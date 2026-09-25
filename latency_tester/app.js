'use strict';

/**
 * E2E Audio Loopback Latency Analyzer.
 *
 * Measurement core: a single duplex `AudioWorkletProcessor` emits a band-limited
 * MLS (or log chirp) burst on `outputs[0]` and records `inputs[0]` starting on the
 * exact same `currentFrame`. The FFT matched-filter peak lag in the recording is
 * therefore the round-trip latency in samples. Analysis runs in a Web Worker.
 *
 * Modes:
 *  - `webaudio`: worklet -> `AudioContext.destination`.
 *  - `audio_element_stream`: worklet -> `MediaStreamAudioDestinationNode` -> `<audio>.srcObject`.
 *  - `audio_element_wav`: `<audio src=blob:wav>` burst train, continuous capture;
 *    reports play()-referenced latency and steady-state burst spacing.
 *  - `webcodecs_rx`: `webaudio` measurement plus a parallel `MediaStreamTrackProcessor`
 *    capture whose PCM is correlated independently (integrity, spacing, timestamps).
 *  - `simulated_dongle`: synthetic 142.35 ms loopback, output muted.
 */

const API_MODES = ['webaudio', 'audio_element_stream', 'audio_element_wav', 'webcodecs_rx', 'simulated_dongle'];
const SIGNAL_TYPES = ['mls13', 'mls12', 'chirp'];
const LATENCY_HINTS = ['interactive', 'balanced', 'playback'];
const SIGNAL_LENGTHS = { mls13: 8191, mls12: 4095, chirp: 8192 };
const MODE_LABELS = {
  webaudio: 'WebAudio (AudioWorklet duplex)',
  audio_element_stream: '<audio> srcObject (MediaStream)',
  audio_element_wav: '<audio> WAV blob (experimental)',
  webcodecs_rx: 'WebCodecs MediaStreamTrackProcessor (experimental)',
  simulated_dongle: 'Simulated dongle (self-test)'
};

// Advanced settings, keyed by URL parameter name. Values are strings as they
// appear in the controls.
const DEFAULT_SETTINGS = {
  mode: 'webaudio', signal: 'mls13', bursts: '5', intervalMs: '757', maxRtlMs: '500',
  levelDb: '-12', latencyHint: 'interactive', minPsrDb: '18', maxStdDevMs: '0.5',
  rawAudio: 'true', pilot: 'true', matchRate: 'false', simGlitch: 'false'
};

// Each profile only lists what it changes from `DEFAULT_SETTINGS`.
const PROFILES = {
  standard: { description: 'Wired loopback dongle (USB-C or 3.5 mm)', overrides: {} },
  quick: { description: 'One burst, to check the setup and levels', overrides: { bursts: '1' } },
  stability: { description: '20 bursts, to catch glitches and latency changes', overrides: { bursts: '20' } },
  bluetooth: {
    description: 'Wireless or high-latency outputs (up to 2 s round trip)',
    overrides: { maxRtlMs: '2000', maxStdDevMs: '5' }
  },
  selftest: { description: 'No hardware needed: checks the page itself', overrides: { mode: 'simulated_dongle' } }
};

const PREROLL_SECONDS = 0.25;          // Pilot / sink warm-up before burst #1.
const INTERVAL_GUARD_SECONDS = 0.05;   // Minimum silence between capture windows.
const CAPTURE_MARGIN_SECONDS = 0.02;
const WAV_LEAD_SECONDS = 0.5;          // Pilot-only lead-in inside the WAV.
const WAV_STARTUP_ALLOWANCE_SECONDS = 1.5;
const TRAIN_MARGIN_SECONDS = 0.08;     // Search window (+/-) around expected burst positions.
const RESUME_TIMEOUT_MS = 3000;
const WATCHDOG_EXTRA_MS = 10000;
const PILOT_MAX_HZ = 19000;
const PILOT_MAX_FRACTION_OF_FS = 0.47; // Stimulus band tops out at 0.40 * fs.
const CLIP_DBFS = -0.3;
const MAX_SPACING_DEVIATION_SAMPLES = 2;
const MAX_TIMESTAMP_SPACING_ERROR_MS = 2;

// ============================================================================
// 1. AudioWorklet: duplex, sample-accurate transceiver.
// ============================================================================
const WORKLET_CODE = String.raw`
class DuplexLoopbackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.runId = 0;
    this.stimulus = null;
    this.pool = [];
    this.pilotEnabled = false;
    this.pilotAmp = 0.00178; // -55 dBFS keep-awake tone for USB-C DACs.
    this.pilotFreq = 19000;
    this.pilotPhase = 0;
    this.muteOutput = false;
    this.simMode = false;
    this.simDelaySamples = 0;
    this.simGlitchBurst = -1;

    this.mode = 'idle'; // 'bursts' | 'continuous' | 'idle'
    this.burstIndex = 0;
    this.totalBursts = 0;
    this.intervalSamples = 0;
    this.nextBurstStartFrame = 0;

    this.capturing = false;
    this.txStartFrame = 0;
    this.rxBuffer = null;
    this.rxWritePos = 0;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'CONFIGURE':
        this.runId = msg.runId;
        this.stimulus = msg.stimulus;
        this.pilotEnabled = Boolean(msg.pilotEnabled);
        this.pilotFreq = msg.pilotFreq;
        this.muteOutput = Boolean(msg.muteOutput);
        this.simMode = Boolean(msg.simMode);
        this.simDelaySamples = msg.simDelaySamples;
        this.simGlitchBurst = msg.simGlitchBurst;
        break;
      case 'ADD_BUFFERS':
        // Buffers are pre-allocated on the main thread and recycled, so the
        // render thread never allocates.
        for (const b of msg.buffers) this.pool.push(b);
        break;
      case 'START_BURSTS':
        this.mode = 'bursts';
        this.totalBursts = msg.totalBursts;
        this.intervalSamples = msg.intervalSamples;
        this.burstIndex = 0;
        this.nextBurstStartFrame = currentFrame + msg.prerollSamples;
        break;
      case 'START_CONTINUOUS': {
        const buf = this.pool.pop();
        if (!buf) {
          this.port.postMessage({ type: 'ERROR', runId: this.runId, message: 'No capture buffer available for continuous capture.' });
          return;
        }
        this.mode = 'continuous';
        this.rxBuffer = buf;
        this.rxWritePos = 0;
        this.capturing = true;
        this.txStartFrame = currentFrame;
        this.port.postMessage({ type: 'CONTINUOUS_STARTED', runId: this.runId, captureStartFrame: currentFrame });
        break;
      }
      case 'STOP':
        this.mode = 'idle';
        this.capturing = false;
        break;
    }
  }

  simulate(offset) {
    let s = (Math.random() * 2 - 1) * 0.004;
    let d = offset - this.simDelaySamples;
    if (this.burstIndex === this.simGlitchBurst && d > (this.stimulus.length >> 1)) d -= 128;
    if (d >= 0 && d < this.stimulus.length) s += 0.5 * this.stimulus[d];
    return s;
  }

  finishCapture() {
    const buf = this.rxBuffer;
    this.rxBuffer = null;
    this.capturing = false;
    if (this.mode === 'continuous') {
      this.mode = 'idle';
      this.port.postMessage({ type: 'CONTINUOUS_CAPTURED', runId: this.runId, captureStartFrame: this.txStartFrame, rxBuffer: buf }, [buf.buffer]);
      return;
    }
    this.port.postMessage({
      type: 'BURST_CAPTURED', runId: this.runId, burstIndex: this.burstIndex,
      txStartFrame: this.txStartFrame, rxBuffer: buf
    }, [buf.buffer]);
    this.burstIndex++;
    if (this.burstIndex < this.totalBursts) {
      // Schedule from the previous burst start so the configured interval is honored.
      this.nextBurstStartFrame = this.txStartFrame + this.intervalSamples;
    } else {
      this.mode = 'idle';
      this.port.postMessage({ type: 'RUN_COMPLETE', runId: this.runId });
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const input = inputs[0];
    const frames = output && output.length ? output[0].length : 128;
    const inMono = input && input.length ? input[0] : null;
    const pilotStep = (2 * Math.PI * this.pilotFreq) / sampleRate;

    for (let i = 0; i < frames; i++) {
      const absFrame = currentFrame + i;

      if (this.mode === 'bursts' && !this.capturing && this.burstIndex < this.totalBursts &&
          absFrame >= this.nextBurstStartFrame) {
        const buf = this.pool.pop();
        if (buf) {
          this.rxBuffer = buf;
          this.rxWritePos = 0;
          this.capturing = true;
          this.txStartFrame = absFrame;
        }
        // Otherwise wait for a recycled buffer; the actual txStartFrame is reported.
      }

      let out = 0;
      if (!this.muteOutput) {
        if (this.pilotEnabled) {
          out += this.pilotAmp * Math.sin(this.pilotPhase);
          this.pilotPhase += pilotStep;
          if (this.pilotPhase > 2 * Math.PI) this.pilotPhase -= 2 * Math.PI;
        }
        if (this.mode === 'bursts' && this.capturing) {
          const k = absFrame - this.txStartFrame;
          if (k < this.stimulus.length) out += this.stimulus[k];
        }
      }
      if (output) {
        for (let c = 0; c < output.length; c++) output[c][i] = out;
      }

      if (this.capturing) {
        let s = inMono ? inMono[i] : 0;
        if (this.simMode && this.mode === 'bursts') s = this.simulate(absFrame - this.txStartFrame);
        this.rxBuffer[this.rxWritePos++] = s;
        if (this.rxWritePos >= this.rxBuffer.length) this.finishCapture();
      }
    }
    return true;
  }
}
registerProcessor('duplex-loopback-processor', DuplexLoopbackProcessor);
`;

// ============================================================================
// 2. Web Worker: stimulus synthesis and FFT matched-filter analysis.
// ============================================================================
const WORKER_CODE = String.raw`
'use strict';
let STIM = null;
// Quarter-based small-glitch checks need every quarter to be broadband (MLS).
// Chirp quarters are narrow sub-bands whose correlation depends on the channel
// response, so only the split-peak detector is used for chirps.
let STIM_BROADBAND = false;
const SPECTRUM_CACHE = new Map();
const SPLIT_PEAK_EXCLUSION = 40;       // Samples around the main peak excluded from sidelobe stats.
const SPLIT_PEAK_MAX_RATIO_DB = 9.5;   // A second peak within this of the main peak => glitch.
const QUARTER_SEARCH_RADIUS = 48;      // Small-glitch detector search (+/- samples).
const QUARTER_MIN_EXTRA_PSR_DB = 12;   // Only run small-glitch check with SNR headroom.
const QUARTER_MAX_RESIDUAL = 0.45;     // Quarter-lag deviation from a line (samples) => glitch.
const QUARTER_MIN_NCC_RATIO = 0.6;     // Worst/best quarter normalized correlation => glitch.

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

// Radix-2 in-place Cooley-Tukey FFT.
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 0, j = 0; i < n; i++) {
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (inverse ? 2 : -2) * Math.PI / len;
    const wLenRe = Math.cos(angle);
    const wLenIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wRe = 1, wIm = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const vRe = re[b] * wRe - im[b] * wIm;
        const vIm = re[b] * wIm + im[b] * wRe;
        re[b] = re[a] - vRe; im[b] = im[a] - vIm;
        re[a] += vRe; im[a] += vIm;
        const nw = wRe * wLenRe - wIm * wLenIm;
        wIm = wRe * wLenIm + wIm * wLenRe;
        wRe = nw;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

// Zero-phase (forward-backward) 2nd-order Butterworth high-pass + low-pass.
function zeroPhaseBandpass(signal, fs, fLow, fHigh) {
  function biquad(arr, b0, b1, b2, a1, a2) {
    const out = new Float32Array(arr.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < arr.length; i++) {
      const x0 = arr[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    }
    return out;
  }
  function coeffs(f, highpass) {
    const w0 = (2 * Math.PI * f) / fs;
    const alpha = Math.sin(w0) / Math.SQRT2;
    const cw = Math.cos(w0);
    const a0 = 1 + alpha;
    const b0 = (highpass ? (1 + cw) / 2 : (1 - cw) / 2) / a0;
    const b1 = (highpass ? -(1 + cw) : (1 - cw)) / a0;
    return [b0, b1, b0, (-2 * cw) / a0, (1 - alpha) / a0];
  }
  const hp = coeffs(fLow, true);
  const lp = coeffs(fHigh, false);
  let x = biquad(biquad(signal, ...hp), ...lp);
  x.reverse();
  x = biquad(biquad(x, ...hp), ...lp);
  x.reverse();
  return x;
}

// Taps verified maximal-length (period 2^order - 1) for this shift-right,
// feed-into-MSB Fibonacci LFSR form.
function mlsTaps(order) { return order === 12 ? [10, 2, 1, 0] : [12, 2, 1, 0]; }

function generateMls(order) {
  const len = (1 << order) - 1;
  const taps = mlsTaps(order);
  const start = len;
  let reg = start;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = (reg & 1) ? 1 : -1;
    let fb = 0;
    for (const t of taps) fb ^= (reg >> t) & 1;
    reg = (reg >> 1) | (fb << (order - 1));
    if (reg === start && i < len - 1) {
      throw new Error('MLS taps are not maximal-length (period ' + (i + 1) + ' < ' + len + ').');
    }
  }
  if (reg !== start) throw new Error('MLS register did not return to its initial state.');
  return out;
}

function generateStimulus(signalType, fs, levelDb) {
  const fLow = 500;
  const fHigh = Math.min(12000, 0.40 * fs);
  let raw;
  if (signalType === 'chirp') {
    const len = 8192;
    raw = new Float32Array(len);
    const T = len / fs;
    const k = Math.log(fHigh / fLow);
    for (let n = 0; n < len; n++) {
      const t = n / fs;
      raw[n] = Math.sin((2 * Math.PI * fLow * T / k) * (Math.exp((t / T) * k) - 1));
    }
  } else {
    raw = zeroPhaseBandpass(generateMls(signalType === 'mls12' ? 12 : 13), fs, fLow, fHigh);
  }
  // 2 ms raised-cosine taper, then normalize to the requested peak level.
  const taper = Math.max(16, Math.round(0.002 * fs));
  let maxAbs = 1e-9;
  for (let i = 0; i < raw.length; i++) {
    const edge = Math.min(i, raw.length - 1 - i);
    if (edge < taper) raw[i] *= 0.5 * (1 - Math.cos((Math.PI * edge) / taper));
    maxAbs = Math.max(maxAbs, Math.abs(raw[i]));
  }
  const scale = Math.pow(10, levelDb / 20) / maxAbs;
  for (let i = 0; i < raw.length; i++) raw[i] *= scale;
  return raw;
}

function stimSpectrum(n) {
  let s = SPECTRUM_CACHE.get(n);
  if (!s) {
    s = { re: new Float32Array(n), im: new Float32Array(n) };
    s.re.set(STIM);
    fft(s.re, s.im, false);
    SPECTRUM_CACHE.set(n, s);
  }
  return s;
}

function parabolicOffset(y1, y2, y3) {
  const d = 2 * (y1 - 2 * y2 + y3);
  if (Math.abs(d) < 1e-12) return 0;
  return Math.max(-0.5, Math.min(0.5, (y1 - y3) / d));
}

// Correlates each quarter of the stimulus independently around the main lag.
// A mid-burst dropout/insertion of G samples makes quarters disagree by ~G
// (G <= search radius), or leaves one quarter poorly correlated (larger G).
function quarterLagFit(rx, absLag) {
  const Q = Math.floor(STIM.length / 4);
  const R = QUARTER_SEARCH_RADIUS;
  const vals = new Float64Array(2 * R + 1);
  const lags = [];
  const ncc = [];
  for (let q = 0; q < 4; q++) {
    let bestIdx = 0, bestVal = -1;
    for (let d = -R; d <= R; d++) {
      const base = absLag + d + q * Q;
      let acc = 0;
      if (base >= 0 && base + Q <= rx.length) {
        for (let n = 0; n < Q; n++) acc += rx[base + n] * STIM[q * Q + n];
      }
      const v = Math.abs(acc);
      vals[d + R] = v;
      if (v > bestVal) { bestVal = v; bestIdx = d + R; }
    }
    let off = 0;
    if (bestIdx > 0 && bestIdx < 2 * R) off = parabolicOffset(vals[bestIdx - 1], vals[bestIdx], vals[bestIdx + 1]);
    lags.push(bestIdx - R + off);
    // Normalized correlation of this quarter at its best lag.
    const base = Math.max(0, Math.min(rx.length - Q, absLag + bestIdx - R + q * Q));
    let eRx = 0, eStim = 0;
    for (let n = 0; n < Q; n++) { eRx += rx[base + n] * rx[base + n]; eStim += STIM[q * Q + n] * STIM[q * Q + n]; }
    ncc.push(bestVal / Math.max(1e-12, Math.sqrt(eRx * eStim)));
  }
  // Clock drift between capture and render shows up as a linear slope across
  // quarters; a dropout/insertion shows up as a step. Only the residual from a
  // least-squares line counts (a step of G leaves a residual >= 0.3 * G).
  const meanY = (lags[0] + lags[1] + lags[2] + lags[3]) / 4;
  const slope = (-1.5 * lags[0] - 0.5 * lags[1] + 0.5 * lags[2] + 1.5 * lags[3]) / 5;
  let residual = 0;
  for (let q = 0; q < 4; q++) residual = Math.max(residual, Math.abs(lags[q] - (meanY + slope * (q - 1.5))));
  const jumps = [lags[1] - lags[0], lags[2] - lags[1], lags[3] - lags[2]];
  const medianJump = jumps.slice().sort((a, b) => a - b)[1];
  const step = Math.max(...jumps.map((j) => Math.abs(j - medianJump)));
  const nccRatio = Math.min(...ncc) / Math.max(1e-12, Math.max(...ncc));
  return { lags, residual, step, nccRatio, driftPpm: (slope / Q) * 1e6 };
}

// Matched filter over rx[start, start + winLen). Returned lag is absolute in rx.
function analyzeWindow(rx, start, winLen, gateDb, wantEnvelope) {
  const L = STIM.length;
  start = Math.max(0, Math.round(start));
  winLen = Math.min(Math.round(winLen), rx.length - start);
  const maxLag = winLen - L;
  if (maxLag < 2) return null;

  const n = nextPow2(winLen + L);
  const spec = stimSpectrum(n);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  re.set(rx.subarray(start, start + winLen));
  fft(re, im, false);
  for (let k = 0; k < n; k++) {
    const yr = re[k], yi = im[k], xr = spec.re[k], xi = -spec.im[k];
    re[k] = yr * xr - yi * xi;
    im[k] = yr * xi + yi * xr;
  }
  fft(re, im, true);

  let bestLag = 0, bestVal = 0;
  for (let lag = 0; lag <= maxLag; lag++) {
    const v = Math.abs(re[lag]);
    if (v > bestVal) { bestVal = v; bestLag = lag; }
  }
  let delta = 0;
  if (bestLag > 0 && bestLag < maxLag) {
    delta = parabolicOffset(Math.abs(re[bestLag - 1]), bestVal, Math.abs(re[bestLag + 1]));
  }

  let sideSumSq = 0, sideCount = 0, secondVal = 0, secondLag = -1;
  for (let lag = 0; lag <= maxLag; lag++) {
    if (Math.abs(lag - bestLag) <= SPLIT_PEAK_EXCLUSION) continue;
    const v = Math.abs(re[lag]);
    sideSumSq += v * v;
    sideCount++;
    if (v > secondVal) { secondVal = v; secondLag = lag; }
  }
  const sideRms = Math.sqrt(sideSumSq / Math.max(1, sideCount));
  const psrDb = 20 * Math.log10(Math.max(1e-12, bestVal) / Math.max(1e-12, sideRms));
  const secondRatioDb = 20 * Math.log10(Math.max(1e-12, bestVal) / Math.max(1e-12, secondVal));

  const splitPeak = psrDb >= gateDb && secondRatioDb < SPLIT_PEAK_MAX_RATIO_DB;
  let quarter = null;
  if (STIM_BROADBAND && psrDb >= gateDb + QUARTER_MIN_EXTRA_PSR_DB) quarter = quarterLagFit(rx, start + bestLag);
  const stepGlitch = quarter !== null && quarter.residual > QUARTER_MAX_RESIDUAL;
  const nccGlitch = quarter !== null && quarter.nccRatio < QUARTER_MIN_NCC_RATIO;
  const smallGlitch = !splitPeak && (stepGlitch || nccGlitch);
  const glitch = splitPeak || smallGlitch;
  // null => a glitch was detected but its size could not be estimated.
  const glitchDelta = splitPeak ? Math.abs(secondLag - bestLag)
    : (stepGlitch ? Math.round(quarter.step) : (nccGlitch ? null : 0));

  let maxPeak = 0, sumSq = 0;
  for (let i = start; i < start + winLen; i++) {
    const a = Math.abs(rx[i]);
    if (a > maxPeak) maxPeak = a;
    sumSq += rx[i] * rx[i];
  }

  let envelope = null;
  if (wantEnvelope) {
    const points = 500;
    envelope = new Float32Array(points);
    const step = maxLag / points;
    for (let p = 0; p < points; p++) {
      const s = Math.floor(p * step);
      const e = Math.min(maxLag, Math.floor((p + 1) * step) + 1);
      let m = 0;
      for (let i = s; i < e; i++) m = Math.max(m, Math.abs(re[i]));
      envelope[p] = m / Math.max(1e-12, bestVal);
    }
  }

  return {
    lag: start + bestLag + delta,
    windowStart: start,
    maxLag,
    psrDb,
    secondRatioDb,
    sideRmsNorm: sideRms / Math.max(1e-12, bestVal),
    splitPeak,
    smallGlitch,
    smallGlitchChecked: quarter !== null,
    quarterResidual: quarter ? quarter.residual : null,
    quarterNccRatio: quarter ? quarter.nccRatio : null,
    driftPpm: quarter ? quarter.driftPpm : null,
    glitch,
    glitchDelta,
    peakDbFs: 20 * Math.log10(Math.max(1e-7, maxPeak)),
    rmsDbFs: 20 * Math.log10(Math.max(1e-7, Math.sqrt(sumSq / winLen))),
    envelope
  };
}

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'PREPARE_STIMULUS') {
      STIM = generateStimulus(msg.signalType, msg.sampleRate, msg.levelDb);
      STIM_BROADBAND = msg.signalType !== 'chirp';
      SPECTRUM_CACHE.clear();
      self.postMessage({ type: 'STIMULUS_READY', runId: msg.runId, stimulus: STIM.slice() });
    } else if (msg.type === 'ANALYZE_BURST') {
      const rx = msg.rxBuffer;
      const r = analyzeWindow(rx, 0, rx.length, msg.gateDb, true);
      if (!r) throw new Error('Capture window is shorter than the stimulus.');
      r.type = 'BURST_ANALYZED';
      r.runId = msg.runId;
      r.burstIndex = msg.burstIndex;
      r.rxWaveform = rx;
      self.postMessage(r, [rx.buffer]);
    } else if (msg.type === 'ANALYZE_TRAIN') {
      const rx = msg.rxBuffer;
      const bursts = [];
      const first = analyzeWindow(rx, msg.firstStart, msg.firstLen, msg.gateDb, true);
      if (first) {
        bursts.push(first);
        for (let k = 1; k < msg.offsets.length; k++) {
          const expected = first.lag + msg.offsets[k];
          const r = analyzeWindow(rx, expected - msg.marginSamples, 2 * msg.marginSamples + STIM.length, msg.gateDb, false);
          if (!r) break;
          bursts.push(r);
        }
      }
      let preview = null;
      let previewOnset = 0;
      if (first) {
        preview = rx.slice(first.windowStart, first.windowStart + first.maxLag + STIM.length);
        previewOnset = first.lag - first.windowStart;
      }
      self.postMessage({ type: 'TRAIN_ANALYZED', runId: msg.runId, tag: msg.tag, bursts, preview, previewOnset },
        preview ? [preview.buffer] : []);
    }
  } catch (err) {
    self.postMessage({ type: 'ERROR', runId: msg.runId, message: String((err && err.message) || err) });
  }
};
`;

// ============================================================================
// 3. Helpers.
// ============================================================================
function errMsg(err) { return String((err && err.message) || err); }

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function fmt(v, digits = 2, unit = '') {
  return (typeof v === 'number' && Number.isFinite(v)) ? `${v.toFixed(digits)}${unit}` : 'n/a';
}

function decimateMinMax(wave, points) {
  const out = new Float32Array(points * 2);
  const step = wave.length / points;
  for (let p = 0; p < points; p++) {
    const s = Math.floor(p * step);
    const e = Math.max(s + 1, Math.floor((p + 1) * step));
    let mn = 0, mx = 0;
    for (let i = s; i < e && i < wave.length; i++) {
      if (wave[i] < mn) mn = wave[i];
      if (wave[i] > mx) mx = wave[i];
    }
    out[2 * p] = mn;
    out[2 * p + 1] = mx;
  }
  return out;
}

function computeStats(trials) {
  const valid = trials.filter((t) => t.valid);
  const rtls = valid.map((t) => t.rtlMs);
  const n = rtls.length;
  const hist = new Map();
  valid.forEach((t) => {
    const key = Math.round(t.lagSamples);
    hist.set(key, (hist.get(key) || 0) + 1);
  });
  const histogram = [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([lag, count]) => ({ lagSamples: lag, count }));
  if (!n) {
    return { validCount: 0, total: trials.length, median: null, mean: null, stdDev: null, min: null, max: null, histogram };
  }
  const mean = rtls.reduce((s, v) => s + v, 0) / n;
  const stdDev = n > 1 ? Math.sqrt(rtls.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    validCount: n, total: trials.length, median: median(rtls), mean, stdDev,
    min: Math.min(...rtls), max: Math.max(...rtls), histogram
  };
}

function createMonoWavBlob(samples, sampleRate) {
  const n = samples.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, n * 2, true);
  for (let i = 0, o = 44; i < n; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function setSelectIfValid(el, value) {
  if (value !== null && [...el.options].some((o) => o.value === value)) el.value = value;
}

function renderRows(container, rows) {
  container.replaceChildren(...rows.map(([k, v]) => {
    const row = document.createElement('div');
    row.className = 'env-row';
    const key = document.createElement('span');
    key.className = 'env-key';
    key.textContent = k;
    const val = document.createElement('span');
    val.className = 'env-val';
    val.textContent = v;
    row.append(key, val);
    return row;
  }));
}

// ============================================================================
// 4. Application controller.
// ============================================================================
class E2EAudioLatencyApp {
  constructor() {
    this.run = null;
    this.runCounter = 0;
    this.lastPlot = null;
    this.bindDom();
    this.initWorker();
    const autorun = this.loadConfigFromUrl();
    this.refreshDevices();
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => this.refreshDevices());
    }
    this.redrawPlots();
    window.addEventListener('resize', () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.redrawPlots(), 120);
    });
    if (autorun) setTimeout(() => this.startTestRun(false), 300);
  }

  initWorker() {
    // The worker lives for the page lifetime; its blob URL is intentionally not revoked
    // because some browsers fetch the script asynchronously after construction.
    const url = URL.createObjectURL(new Blob([WORKER_CODE], { type: 'application/javascript' }));
    this.worker = new Worker(url);
    this.worker.onmessage = (e) => this.onWorkerMessage(e.data);
    this.worker.onerror = (e) => {
      if (this.run) this.failRun(this.run, 'WORKER ERROR', e.message || 'Analyzer worker crashed.', []);
    };
  }

  bindDom() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      runBtn: $('run-test-btn'), stopBtn: $('stop-test-btn'),
      shareBtn: $('copy-config-btn'), exportJsonBtn: $('export-json-btn'), progressPill: $('progress-pill'),
      profile: $('cfg-profile'), profileDesc: $('profile-desc'), advanced: $('advanced-settings'),
      apiMode: $('cfg-api-mode'), signalType: $('cfg-signal-type'), burstCount: $('cfg-burst-count'),
      intervalMs: $('cfg-interval-ms'), maxRtlMs: $('cfg-max-rtl'), levelDb: $('cfg-output-level'),
      latencyHint: $('cfg-latency-hint'), minPsrDb: $('cfg-min-psr'), maxStdDevMs: $('cfg-max-stddev'),
      inputDevice: $('cfg-input-device'), outputDevice: $('cfg-output-device'),
      disableAec: $('cfg-disable-aec'), pilot: $('cfg-pilot-tone'), matchRate: $('cfg-match-rate'),
      simGlitch: $('cfg-sim-glitch'),
      verdictBanner: $('verdict-banner'), verdictBadge: $('verdict-badge'),
      verdictHeadline: $('verdict-headline'), verdictDiagnostics: $('verdict-diagnostics'),
      kpiRtlLabel: $('kpi-rtl-label'), kpiRtl: $('kpi-rtl-median'), kpiRtlSub: $('kpi-rtl-sub'),
      kpiJitter: $('kpi-jitter'), kpiJitterSub: $('kpi-jitter-sub'),
      kpiPsr: $('kpi-psr'), kpiPsrSub: $('kpi-psr-sub'),
      kpiGlitches: $('kpi-glitches'), kpiGlitchesSub: $('kpi-glitches-sub'),
      segBase: $('seg-base'), segOutput: $('seg-output'), segRest: $('seg-os'),
      legBase: $('leg-base'), legOutput: $('leg-output'), legRest: $('leg-os'),
      decompMeta: $('decomp-meta'), decompNote: $('decomp-note'),
      modeResults: $('mode-results-list'),
      waveCanvas: $('waveform-canvas'), corrCanvas: $('correlation-canvas'),
      latencyHeader: $('latency-col-header'), trialBody: $('trial-table-body'), envList: $('env-metadata-list')
    };

    this.els.runBtn.addEventListener('click', () => this.startTestRun(false));
    this.els.stopBtn.addEventListener('click', () => this.stopTestRun());
    this.els.shareBtn.addEventListener('click', () => this.copyShareableUrl());
    this.els.exportJsonBtn.addEventListener('click', () => this.exportJsonReport());
    this.els.profile.addEventListener('change', () => {
      if (this.els.profile.value !== 'custom') this.applyProfile(this.els.profile.value);
      this.syncConfigToUrl();
    });
    Object.values(this.fields()).forEach(({ el }) => el.addEventListener('change', () => {
      this.updateProfileFromFields();
      this.syncConfigToUrl();
    }));
  }

  // ---------------------------------------------------------------- config --
  // Maps URL parameter names to the advanced-settings controls.
  fields() {
    const e = this.els;
    return {
      mode: { el: e.apiMode, type: 'select' }, signal: { el: e.signalType, type: 'select' },
      bursts: { el: e.burstCount, type: 'select' }, intervalMs: { el: e.intervalMs, type: 'num' },
      maxRtlMs: { el: e.maxRtlMs, type: 'select' }, levelDb: { el: e.levelDb, type: 'select' },
      latencyHint: { el: e.latencyHint, type: 'select' }, minPsrDb: { el: e.minPsrDb, type: 'num' },
      maxStdDevMs: { el: e.maxStdDevMs, type: 'num' }, rawAudio: { el: e.disableAec, type: 'bool' },
      pilot: { el: e.pilot, type: 'bool' }, matchRate: { el: e.matchRate, type: 'bool' },
      simGlitch: { el: e.simGlitch, type: 'bool' }
    };
  }

  // Current advanced settings, keyed like `DEFAULT_SETTINGS` (all strings).
  currentSettings() {
    const out = {};
    for (const [key, { el, type }] of Object.entries(this.fields())) {
      if (type === 'bool') out[key] = String(el.checked);
      else if (type === 'num' && el.value !== '' && Number.isFinite(Number(el.value))) out[key] = String(Number(el.value));
      else out[key] = el.value;
    }
    return out;
  }

  applySettings(settings) {
    for (const [key, { el, type }] of Object.entries(this.fields())) {
      if (!(key in settings) || settings[key] === null) continue;
      const v = String(settings[key]);
      if (type === 'bool') el.checked = v === 'true';
      else if (type === 'select') setSelectIfValid(el, v);
      else if (Number.isFinite(Number(v))) el.value = v;
    }
  }

  profileSettings(name) {
    return { ...DEFAULT_SETTINGS, ...(PROFILES[name] ? PROFILES[name].overrides : {}) };
  }

  applyProfile(name) {
    this.applySettings(this.profileSettings(name));
    this.els.profile.value = name;
    this.updateProfileDescription();
  }

  // Selects the profile matching the advanced fields, or "Custom".
  updateProfileFromFields() {
    const cur = this.currentSettings();
    const same = (a, b) => Object.keys(a).every((k) => String(a[k]) === String(b[k]));
    const match = Object.keys(PROFILES).find((name) => same(this.profileSettings(name), cur));
    this.els.profile.value = match || 'custom';
    this.updateProfileDescription();
  }

  updateProfileDescription() {
    const name = this.els.profile.value;
    const c = this.readConfig(false);
    const summary = `${MODE_LABELS[c.mode]} · ${c.burstCount} burst${c.burstCount > 1 ? 's' : ''} · max RTL ${c.maxRtlMs} ms · jitter gate ±${c.maxStdDevMs} ms`;
    const desc = PROFILES[name] ? PROFILES[name].description : 'Custom settings (see Advanced settings).';
    this.els.profileDesc.textContent = `${desc} — ${summary}`;
  }

  loadConfigFromUrl() {
    const p = new URLSearchParams(window.location.search);
    const profile = PROFILES[p.get('profile')] ? p.get('profile') : 'standard';
    this.applyProfile(profile);
    // Individual parameters override the profile.
    const overrides = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) if (p.has(key)) overrides[key] = p.get(key);
    this.applySettings(overrides);
    this.updateProfileFromFields();
    if (this.els.profile.value === 'custom') this.els.advanced.open = true;
    return p.get('autorun') === 'true';
  }

  // Writes `profile=` plus only the settings that differ from that profile.
  syncConfigToUrl() {
    const name = this.els.profile.value;
    const base = this.profileSettings(PROFILES[name] ? name : 'standard');
    const cur = this.currentSettings();
    const p = new URLSearchParams();
    if (name !== 'standard' && PROFILES[name]) p.set('profile', name);
    for (const [k, v] of Object.entries(cur)) if (String(base[k]) !== v) p.set(k, v);
    const qs = p.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }

  readConfig(quick) {
    const num = (el, def, min, max) => {
      const v = Number(el.value);
      return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
    };
    const pick = (el, allowed, def) => (allowed.includes(el.value) ? el.value : def);
    return {
      mode: pick(this.els.apiMode, API_MODES, 'webaudio'),
      signalType: pick(this.els.signalType, SIGNAL_TYPES, 'mls13'),
      burstCount: quick ? 1 : Math.round(num(this.els.burstCount, 5, 1, 50)),
      intervalMs: num(this.els.intervalMs, 757, 300, 5000),
      maxRtlMs: num(this.els.maxRtlMs, 500, 100, 3000),
      levelDb: num(this.els.levelDb, -12, -40, -1),
      latencyHint: pick(this.els.latencyHint, LATENCY_HINTS, 'interactive'),
      minPsrDb: num(this.els.minPsrDb, 18, 6, 40),
      maxStdDevMs: num(this.els.maxStdDevMs, 0.5, 0.01, 50),
      disableAec: this.els.disableAec.checked,
      pilot: this.els.pilot.checked,
      matchRate: this.els.matchRate.checked,
      simGlitch: this.els.simGlitch.checked,
      inputDeviceId: this.els.inputDevice.value,
      outputDeviceId: this.els.outputDevice.value
    };
  }

  async refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const fill = (select, kind, defaultLabel, prefix) => {
        const previous = select.value;
        const opts = [new Option(defaultLabel, '')];
        devices.filter((d) => d.kind === kind).forEach((d, i) => {
          opts.push(new Option(d.label || `${prefix} #${i + 1}`, d.deviceId));
        });
        select.replaceChildren(...opts);
        // Preserve the user's selection across re-enumeration.
        if ([...select.options].some((o) => o.value === previous)) select.value = previous;
      };
      fill(this.els.inputDevice, 'audioinput', 'Default Hardware Input', 'Audio Input');
      fill(this.els.outputDevice, 'audiooutput', 'Default System Output', 'Audio Output');
    } catch (_) {
      // Labels/IDs are unavailable before permission is granted.
    }
  }

  // ------------------------------------------------------------- lifecycle --
  isCurrent(run) { return this.run === run; }

  async startTestRun(quick) {
    if (this.run) return;
    const cfg = this.readConfig(quick);
    const run = {
      id: ++this.runCounter, cfg, startedAt: new Date().toISOString(),
      trials: [], tx: [], outLatSamples: [], notes: [], modeIssues: [], modeRows: [], modeData: null
    };
    this.run = run;
    this.resetResultsUi(cfg);
    this.setButtonsRunning(true);
    this.setVerdict('idle', 'RUNNING', `Starting ${MODE_LABELS[cfg.mode]}...`, []);

    try {
      await this.setupAudio(run);
      if (!this.isCurrent(run)) return;
      this.renderEnvironment(run);
      this.worker.postMessage({
        type: 'PREPARE_STIMULUS', runId: run.id, signalType: cfg.signalType,
        sampleRate: run.fs, levelDb: cfg.levelDb
      });
    } catch (err) {
      const hints = err.hints || [
        'No dongle attached? Choose the "Self-test" profile.',
        'For unattended runs, launch Chrome with --autoplay-policy=no-user-gesture-required and --use-fake-ui-for-media-stream.'
      ];
      this.failRun(run, 'SETUP ERROR', `Could not initialize audio: ${errMsg(err)}`, hints);
    }
  }

  // Maps a `getUserMedia()` / `setSinkId()` failure to an actionable error.
  describeDeviceError(err, step, cfg) {
    const name = err && err.name;
    let message = `${step}: ${errMsg(err)}`;
    let hints;
    if (step === 'Microphone' && (name === 'NotFoundError' || name === 'OverconstrainedError')) {
      if (cfg.inputDeviceId) {
        message = 'Microphone: the selected input device is no longer available (unplugged or re-enumerated).';
        hints = ['The device list has been refreshed. Pick the input again (or "Default Hardware Input") and retry.'];
      } else {
        message = 'Microphone: no audio input device was found.';
        hints = [
          'Plug in the loopback dongle. On phones, TRRS dongles need a 4-pole plug to expose a mic input.',
          'Check that the OS sees an input device, and that no OS/enterprise policy disables the microphone.',
          'No dongle attached? Choose the "Self-test" profile.'
        ];
      }
    } else if (step === 'Microphone' && (name === 'NotAllowedError' || name === 'SecurityError')) {
      message = 'Microphone: permission denied.';
      hints = ['Allow microphone access from the site settings in the address bar and retry.',
        'The page must be served over https:// (or localhost).'];
    } else if (step === 'Microphone' && (name === 'NotReadableError' || name === 'AbortError')) {
      message = 'Microphone: the input device could not be opened.';
      hints = ['Another app may be holding the device exclusively. Close it and retry, or replug the dongle.'];
    } else if (step === 'Output device') {
      message = 'Output device: the selected output sink is not available.';
      hints = ['The device list has been refreshed. Pick the output again (or "Default System Output") and retry.'];
    }
    const out = new Error(message);
    out.hints = hints;
    return out;
  }

  async setupAudio(run) {
    const cfg = run.cfg;
    const simulated = cfg.mode === 'simulated_dongle';
    run.trackSettings = null;

    if (!simulated) {
      const voice = !cfg.disableAec;
      const audio = {
        echoCancellation: { ideal: voice }, noiseSuppression: { ideal: voice },
        autoGainControl: { ideal: voice }, channelCount: { ideal: 1 }
      };
      if (cfg.inputDeviceId) audio.deviceId = { exact: cfg.inputDeviceId };
      try {
        run.micStream = await navigator.mediaDevices.getUserMedia({ audio });
      } catch (err) {
        this.refreshDevices();
        throw this.describeDeviceError(err, 'Microphone', cfg);
      }
      if (!this.isCurrent(run)) return;
      this.refreshDevices();
      const track = run.micStream.getAudioTracks()[0];
      run.trackSettings = track.getSettings ? track.getSettings() : {};
    }

    const ctxOptions = { latencyHint: cfg.latencyHint };
    if (cfg.matchRate && run.trackSettings && run.trackSettings.sampleRate) {
      ctxOptions.sampleRate = run.trackSettings.sampleRate;
    }
    run.ctx = new AudioContext(ctxOptions);
    if (cfg.outputDeviceId && typeof run.ctx.setSinkId === 'function') {
      try {
        await run.ctx.setSinkId(cfg.outputDeviceId);
      } catch (err) {
        this.refreshDevices();
        throw this.describeDeviceError(err, 'Output device', cfg);
      }
    }
    await withTimeout(run.ctx.resume(), RESUME_TIMEOUT_MS,
      'AudioContext did not start (autoplay policy). Click "Run Latency Test", or launch Chrome with --autoplay-policy=no-user-gesture-required for autorun.');
    if (run.ctx.state !== 'running') throw new Error(`AudioContext state is "${run.ctx.state}".`);

    const fs = run.ctx.sampleRate;
    run.fs = fs;
    run.baseLatencyMs = typeof run.ctx.baseLatency === 'number' && run.ctx.baseLatency > 0 ? run.ctx.baseLatency * 1000 : null;
    run.stimLength = SIGNAL_LENGTHS[cfg.signalType];
    run.maxRtlSamples = Math.round((cfg.maxRtlMs / 1000) * fs);
    run.captureLength = run.maxRtlSamples + run.stimLength + Math.round(CAPTURE_MARGIN_SECONDS * fs);
    const minInterval = run.captureLength + Math.round(INTERVAL_GUARD_SECONDS * fs);
    const requested = Math.round((cfg.intervalMs / 1000) * fs);
    run.intervalSamples = Math.max(requested, minInterval);
    if (run.intervalSamples > requested) {
      run.notes.push(`Burst interval raised from ${cfg.intervalMs} ms to ${(run.intervalSamples / fs * 1000).toFixed(1)} ms to fit a ${cfg.maxRtlMs} ms max-RTL capture window.`);
    }
    run.pilotFreq = Math.min(PILOT_MAX_HZ, PILOT_MAX_FRACTION_OF_FS * fs);

    const trackRate = run.trackSettings && run.trackSettings.sampleRate;
    if (trackRate && trackRate !== fs) {
      run.notes.push(`Mic track runs at ${trackRate} Hz but the AudioContext runs at ${fs} Hz; a resampler is part of the measured path.`);
    }
  }

  async launchPipeline(run, stimulus) {
    const { cfg, ctx, fs } = run;
    if (!this.isCurrent(run) || !ctx) return;

    const url = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    if (!this.isCurrent(run)) return;

    const node = new AudioWorkletNode(ctx, 'duplex-loopback-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2]
    });
    run.node = node;
    node.port.onmessage = (e) => this.onWorkletMessage(run, e.data);
    if (run.micStream) ctx.createMediaStreamSource(run.micStream).connect(node);

    const isWav = cfg.mode === 'audio_element_wav';
    const silentToDestination = () => {
      // Keeps the worklet pulled by the hardware clock without audible output.
      const g = ctx.createGain();
      g.gain.value = 0;
      node.connect(g).connect(ctx.destination);
    };

    if (cfg.mode === 'simulated_dongle' || isWav) {
      silentToDestination();
    } else if (cfg.mode === 'audio_element_stream') {
      const dest = ctx.createMediaStreamDestination();
      node.connect(dest);
      silentToDestination();
      run.audioEl = new Audio();
      run.audioEl.srcObject = dest.stream;
      if (cfg.outputDeviceId && typeof run.audioEl.setSinkId === 'function') await run.audioEl.setSinkId(cfg.outputDeviceId);
      await run.audioEl.play();
    } else {
      node.connect(ctx.destination);
    }
    if (!this.isCurrent(run)) return;

    node.port.postMessage({
      type: 'CONFIGURE', runId: run.id, stimulus,
      pilotEnabled: cfg.pilot && !isWav, pilotFreq: run.pilotFreq,
      muteOutput: isWav, simMode: cfg.mode === 'simulated_dongle',
      simDelaySamples: Math.round(0.14235 * fs),
      simGlitchBurst: cfg.simGlitch ? (cfg.burstCount > 1 ? 1 : 0) : -1
    });

    if (isWav) {
      await this.startWavTrain(run, stimulus);
      return;
    }

    const buffers = [0, 1, 2].map(() => new Float32Array(run.captureLength));
    node.port.postMessage({ type: 'ADD_BUFFERS', buffers }, buffers.map((b) => b.buffer));
    if (cfg.mode === 'webcodecs_rx') this.startMstpCollector(run);

    const prerollSamples = Math.round(PREROLL_SECONDS * fs);
    node.port.postMessage({
      type: 'START_BURSTS', totalBursts: cfg.burstCount, intervalSamples: run.intervalSamples, prerollSamples
    });
    const runMs = ((prerollSamples + (cfg.burstCount - 1) * run.intervalSamples + run.captureLength) / fs) * 1000;
    this.armWatchdog(run, runMs + WATCHDOG_EXTRA_MS);
    this.setProgress(`Running burst 1 / ${cfg.burstCount}...`);
  }

  async startWavTrain(run, stimulus) {
    const { cfg, fs, node } = run;
    const lead = Math.round(WAV_LEAD_SECONDS * fs);
    const I = run.intervalSamples;
    const total = lead + (cfg.burstCount - 1) * I + stimulus.length + Math.round(0.1 * fs);
    const wav = new Float32Array(total);
    if (cfg.pilot) {
      const amp = 0.00178;
      const step = (2 * Math.PI * run.pilotFreq) / fs;
      for (let i = 0; i < total; i++) wav[i] = amp * Math.sin(step * i);
    }
    for (let k = 0; k < cfg.burstCount; k++) {
      const off = lead + k * I;
      for (let i = 0; i < stimulus.length; i++) wav[off + i] += stimulus[i];
    }
    run.wavLead = lead;
    run.wavUrl = URL.createObjectURL(createMonoWavBlob(wav, fs));

    const el = new Audio();
    el.preload = 'auto';
    run.audioEl = el;
    if (cfg.outputDeviceId && typeof el.setSinkId === 'function') await el.setSinkId(cfg.outputDeviceId);
    // Wait until the blob is decodable so play() measures pipeline startup, not loading.
    await withTimeout(new Promise((resolve, reject) => {
      el.addEventListener('canplaythrough', resolve, { once: true });
      el.addEventListener('error', () => reject(new Error('WAV blob failed to load in <audio>.')), { once: true });
      el.src = run.wavUrl;
      el.load();
    }), 5000, 'Timed out loading the WAV blob into <audio>.');
    if (!this.isCurrent(run)) return;

    const captureLength = Math.round(WAV_STARTUP_ALLOWANCE_SECONDS * fs) + run.maxRtlSamples + total;
    const buf = new Float32Array(captureLength);
    node.port.postMessage({ type: 'ADD_BUFFERS', buffers: [buf] }, [buf.buffer]);
    node.port.postMessage({ type: 'START_CONTINUOUS' });
    this.armWatchdog(run, (captureLength / fs) * 1000 + WATCHDOG_EXTRA_MS);
    this.setProgress('Playing <audio> WAV burst train...');
  }

  startMstpCollector(run) {
    if (typeof MediaStreamTrackProcessor === 'undefined' || !run.micStream) {
      run.mstp = { error: 'MediaStreamTrackProcessor is not available in this browser.' };
      return;
    }
    const track = run.micStream.getAudioTracks()[0].clone();
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    const m = { track, reader, chunks: [], samples: [], totalFrames: 0, sampleRate: null, stopped: false, error: null };
    run.mstp = m;
    (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        const deliveryPerfMs = performance.now();
        try {
          if (m.stopped || !this.isCurrent(run)) break;
          const frames = value.numberOfFrames;
          const pcm = new Float32Array(frames);
          value.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
          m.sampleRate = value.sampleRate;
          m.chunks.push({ startFrame: m.totalFrames, frames, timestampUs: value.timestamp, deliveryPerfMs });
          m.samples.push(pcm);
          m.totalFrames += frames;
        } finally {
          value.close();
        }
      }
    })().catch((err) => { m.error = errMsg(err); });
  }

  armWatchdog(run, ms) {
    clearTimeout(run.watchdog);
    run.watchdog = setTimeout(() => {
      this.failRun(run, 'TIMEOUT', `No result after ${(ms / 1000).toFixed(1)} s.`, [
        'The audio device may have stopped delivering input, or the page was throttled in the background.'
      ]);
    }, ms);
  }

  stopTestRun() {
    const run = this.run;
    if (!run) return;
    this.setVerdict('idle', 'STOPPED', 'Measurement stopped by user.', []);
    this.cleanup(run);
  }

  failRun(run, badge, text, hints) {
    if (!this.isCurrent(run)) return;
    this.setVerdict('fail', `FAIL — ${badge}`, text, hints);
    this.publishResult(run, 'FAIL', computeStats(run.trials), [{ severity: 'fail', badge, text }], text);
    this.cleanup(run);
  }

  cleanup(run) {
    clearTimeout(run.watchdog);
    if (run.node) {
      run.node.port.postMessage({ type: 'STOP' });
      run.node.port.onmessage = null;
      run.node.disconnect();
    }
    if (run.mstp && run.mstp.reader) {
      run.mstp.stopped = true;
      run.mstp.reader.cancel().catch(() => {});
      run.mstp.track.stop();
    }
    if (run.audioEl) {
      run.audioEl.pause();
      run.audioEl.srcObject = null;
      run.audioEl.removeAttribute('src');
    }
    if (run.wavUrl) URL.revokeObjectURL(run.wavUrl);
    if (run.micStream) run.micStream.getTracks().forEach((t) => t.stop());
    if (run.ctx) run.ctx.close().catch(() => {});
    if (this.isCurrent(run)) {
      this.run = null;
      this.setButtonsRunning(false);
      this.setProgress('Idle — Ready');
    }
  }

  // -------------------------------------------------------------- messages --
  onWorkletMessage(run, msg) {
    if (!this.isCurrent(run) || msg.runId !== run.id) return;
    const { ctx, fs, cfg } = run;
    switch (msg.type) {
      case 'BURST_CAPTURED': {
        let txDacPerfMs = null;
        if (typeof ctx.getOutputTimestamp === 'function') {
          const ts = ctx.getOutputTimestamp();
          if (ts.performanceTime > 0) txDacPerfMs = ts.performanceTime + (msg.txStartFrame / fs - ts.contextTime) * 1000;
        }
        if (typeof ctx.outputLatency === 'number' && ctx.outputLatency > 0) run.outLatSamples.push(ctx.outputLatency * 1000);
        run.tx[msg.burstIndex] = { txStartFrame: msg.txStartFrame, txDacPerfMs };
        this.setProgress(`Analyzing burst ${msg.burstIndex + 1} / ${cfg.burstCount}...`);
        this.worker.postMessage({
          type: 'ANALYZE_BURST', runId: run.id, burstIndex: msg.burstIndex, rxBuffer: msg.rxBuffer, gateDb: cfg.minPsrDb
        }, [msg.rxBuffer.buffer]);
        break;
      }
      case 'RUN_COMPLETE':
        this.setProgress('Finalizing analysis...');
        break;
      case 'CONTINUOUS_STARTED':
        run.captureStartFrame = msg.captureStartFrame;
        // `currentTime` resolution is one render callback; this bounds the play() reference.
        run.playFrame = Math.round(ctx.currentTime * fs);
        run.audioEl.play().catch((err) => this.failRun(run, 'PLAYBACK ERROR', `<audio>.play() rejected: ${errMsg(err)}`, []));
        break;
      case 'CONTINUOUS_CAPTURED':
        this.setProgress('Analyzing <audio> burst train...');
        this.analyzeTrain(run, 'wav', msg.rxBuffer, {
          firstStart: Math.max(0, run.playFrame - msg.captureStartFrame + run.wavLead - Math.round(0.02 * fs)),
          firstLen: Math.round(WAV_STARTUP_ALLOWANCE_SECONDS * fs) + run.maxRtlSamples + run.stimLength,
          offsets: Array.from({ length: cfg.burstCount }, (_, k) => k * run.intervalSamples)
        });
        break;
      case 'ERROR':
        this.failRun(run, 'WORKLET ERROR', msg.message, []);
        break;
    }
  }

  analyzeTrain(run, tag, rxBuffer, { firstStart, firstLen, offsets }) {
    this.worker.postMessage({
      type: 'ANALYZE_TRAIN', runId: run.id, tag, rxBuffer, firstStart, firstLen, offsets,
      marginSamples: Math.round(TRAIN_MARGIN_SECONDS * run.fs), gateDb: run.cfg.minPsrDb
    }, [rxBuffer.buffer]);
  }

  onWorkerMessage(msg) {
    const run = this.run;
    if (!run || msg.runId !== run.id) return; // Drop results from stopped/previous runs.
    try {
      switch (msg.type) {
        case 'ERROR':
          this.failRun(run, 'ANALYZER ERROR', msg.message, []);
          break;
        case 'STIMULUS_READY':
          this.launchPipeline(run, msg.stimulus).catch((err) => this.failRun(run, 'PIPELINE ERROR', errMsg(err), [
            'If <audio>.play() was rejected, click Run manually (autoplay policy).'
          ]));
          break;
        case 'BURST_ANALYZED':
          this.onBurstAnalyzed(run, msg);
          break;
        case 'TRAIN_ANALYZED':
          if (msg.tag === 'wav') this.onWavAnalyzed(run, msg);
          else if (msg.tag === 'mstp') this.onMstpAnalyzed(run, msg);
          break;
      }
    } catch (err) {
      this.failRun(run, 'INTERNAL ERROR', errMsg(err), []);
    }
  }

  makeTrial(run, burstIndex, lagSamples, r) {
    return {
      burstIndex, lagSamples, rtlMs: (lagSamples / run.fs) * 1000,
      psrDb: r.psrDb, peakDbFs: r.peakDbFs, glitch: r.glitch, glitchDelta: r.glitchDelta,
      smallGlitchChecked: r.smallGlitchChecked, valid: r.psrDb >= run.cfg.minPsrDb && !r.glitch
    };
  }

  onBurstAnalyzed(run, msg) {
    const trial = this.makeTrial(run, msg.burstIndex, msg.lag, msg);
    const tx = run.tx[msg.burstIndex];
    if (tx) trial.txStartFrame = tx.txStartFrame;
    run.trials.push(trial);
    this.appendTrialRow(run, trial);
    this.setPlot(run, msg.rxWaveform, msg.lag, msg, 'RTL');

    // Recycle the capture buffer back to the worklet pool.
    if (run.node) run.node.port.postMessage({ type: 'ADD_BUFFERS', buffers: [msg.rxWaveform] }, [msg.rxWaveform.buffer]);
    this.updateSummary(run);

    if (run.trials.length >= run.cfg.burstCount) {
      if (run.cfg.mode === 'webcodecs_rx') this.analyzeMstp(run);
      else this.finishRun(run);
    }
  }

  onWavAnalyzed(run, msg) {
    const I = run.intervalSamples;
    const bursts = msg.bursts;
    let maxSpacingDev = 0;
    let prev = null; // Last burst that passed the PSR gate: { k, lag }.
    bursts.forEach((b, k) => {
      const latencySamples = b.lag + run.captureStartFrame - (run.playFrame + run.wavLead + k * I);
      const trial = this.makeTrial(run, k, latencySamples, b);
      if (b.psrDb >= run.cfg.minPsrDb) {
        if (prev) {
          trial.spacingDevSamples = b.lag - prev.lag - (k - prev.k) * I;
          maxSpacingDev = Math.max(maxSpacingDev, Math.abs(trial.spacingDevSamples));
        }
        prev = { k, lag: b.lag };
      }
      run.trials.push(trial);
      this.appendTrialRow(run, trial);
    });
    if (msg.preview && bursts[0]) this.setPlot(run, msg.preview, msg.previewOnset, bursts[0], 'offset');

    const fs = run.fs;
    const detected = bursts.filter((b) => b.psrDb >= run.cfg.minPsrDb).length;
    const missing = run.cfg.burstCount - detected;
    const firstOk = bursts[0] && bursts[0].psrDb >= run.cfg.minPsrDb;
    run.modeRows = [
      ['play() → first burst at mic', firstOk ? `${fmt(run.trials[0].rtlMs)} ms (element startup + output + input path)` : 'not detected'],
      ['Steady-state spacing deviation (max)', detected >= 2 ? `${maxSpacingDev.toFixed(2)} samples (${(maxSpacingDev / fs * 1000).toFixed(3)} ms)` : 'n/a (fewer than 2 bursts detected)'],
      ['Burst spacing in WAV', `${I} samples (${(I / fs * 1000).toFixed(1)} ms)`],
      ['play() reference uncertainty', 'about one render callback (AudioContext.currentTime granularity)']
    ];
    run.modeData = { maxSpacingDevSamples: detected >= 2 ? maxSpacingDev : null, burstsDetected: detected };
    if (missing > 0 && detected > 0) run.modeIssues.push({ severity: 'warn', badge: 'BURSTS MISSING', text: `${missing} WAV burst(s) were not captured.` });
    if (maxSpacingDev > MAX_SPACING_DEVIATION_SAMPLES) {
      run.modeIssues.push({ severity: 'warn', badge: 'ELEMENT PLAYBACK DRIFT', text: `<audio> burst spacing deviated by up to ${maxSpacingDev.toFixed(1)} samples (dropouts, stalls, or resampler drift).` });
    }
    this.updateSummary(run);
    this.finishRun(run);
  }

  analyzeMstp(run) {
    const m = run.mstp;
    const finishWith = (text) => {
      run.modeRows = [['WebCodecs capture', text]];
      run.modeIssues.push({ severity: 'warn', badge: 'WEBCODECS UNAVAILABLE', text });
      this.finishRun(run);
    };
    if (!m || m.error) return finishWith(m ? m.error : 'Collector not started.');
    m.stopped = true;
    m.reader.cancel().catch(() => {});
    if (!m.totalFrames) return finishWith('MediaStreamTrackProcessor delivered no audio.');
    if (m.sampleRate !== run.fs) {
      return finishWith(`MediaStreamTrackProcessor runs at ${m.sampleRate} Hz vs AudioContext ${run.fs} Hz; correlation skipped. Enable "Match AudioContext rate to mic track rate" (matchRate=true).`);
    }
    const pcm = new Float32Array(m.totalFrames);
    let o = 0;
    for (const s of m.samples) { pcm.set(s, o); o += s.length; }
    m.samples = [];
    const tx0 = run.tx[0].txStartFrame;
    this.setProgress('Analyzing WebCodecs capture...');
    this.analyzeTrain(run, 'mstp', pcm, {
      firstStart: 0,
      firstLen: Math.round((PREROLL_SECONDS + 1.0) * run.fs) + run.maxRtlSamples + run.stimLength,
      offsets: run.tx.map((t) => t.txStartFrame - tx0)
    });
  }

  onMstpAnalyzed(run, msg) {
    const m = run.mstp;
    const fs = run.fs;
    const chunks = m.chunks;
    const chunkAt = (frame) => {
      let lo = 0, hi = chunks.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (chunks[mid].startFrame <= frame) lo = mid; else hi = mid - 1;
      }
      return chunks[lo];
    };
    const bursts = msg.bursts;
    const per = bursts.map((b, k) => {
      const c = chunkAt(Math.floor(b.lag));
      const tsMs = (c.timestampUs + ((b.lag - c.startFrame) / fs) * 1e6) / 1000;
      const tx = run.tx[k];
      return {
        burstIndex: k, lag: b.lag, psrDb: b.psrDb, glitch: b.glitch,
        valid: b.psrDb >= run.cfg.minPsrDb && !b.glitch, tsMs, deliveryPerfMs: c.deliveryPerfMs,
        dacToDeliveryMs: tx.txDacPerfMs !== null ? c.deliveryPerfMs - tx.txDacPerfMs : null,
        timestampMinusTxMs: tx.txDacPerfMs !== null ? tsMs - tx.txDacPerfMs : null
      };
    });
    const ref = per.find((p) => p.valid);
    let maxSpacingDev = 0, maxTsErr = 0;
    per.forEach((p) => {
      if (!ref || p === ref || !p.valid) return;
      const txDelta = run.tx[p.burstIndex].txStartFrame - run.tx[ref.burstIndex].txStartFrame;
      p.spacingDevSamples = (p.lag - ref.lag) - txDelta;
      p.timestampSpacingErrMs = (p.tsMs - ref.tsMs) - (txDelta / fs) * 1000;
      maxSpacingDev = Math.max(maxSpacingDev, Math.abs(p.spacingDevSamples));
      maxTsErr = Math.max(maxTsErr, Math.abs(p.timestampSpacingErrMs));
    });
    const validCount = per.filter((p) => p.valid).length;
    const glitches = per.filter((p) => p.glitch).length;
    const dacToDelivery = median(per.filter((p) => p.dacToDeliveryMs !== null).map((p) => p.dacToDeliveryMs));
    const tsMinusTx = median(per.filter((p) => p.timestampMinusTxMs !== null).map((p) => p.timestampMinusTxMs));

    run.modeRows = [
      ['WebCodecs bursts detected', `${validCount} / ${run.cfg.burstCount} (${glitches} glitched)`],
      ['Chunk size (median)', `${median(chunks.map((c) => c.frames))} frames @ ${m.sampleRate} Hz`],
      ['Burst spacing vs WebAudio (max)', `${maxSpacingDev.toFixed(2)} samples`],
      ['AudioData.timestamp spacing error (max)', `${maxTsErr.toFixed(3)} ms`],
      ['Est. DAC → JS delivery (median)', `${fmt(dacToDelivery)} ms (uses getOutputTimestamp)`],
      ['AudioData.timestamp − est. DAC time', `${fmt(tsMinusTx)} ms (only meaningful if timestamps use the performance.now() timebase)`]
    ];
    const enough = validCount >= 2;
    run.modeData = { validCount, glitches, maxSpacingDevSamples: enough ? maxSpacingDev : null, maxTimestampSpacingErrMs: enough ? maxTsErr : null, medianDacToDeliveryMs: dacToDelivery, medianTimestampMinusTxMs: tsMinusTx, bursts: per };
    if (validCount < run.cfg.burstCount) run.modeIssues.push({ severity: 'warn', badge: 'WEBCODECS BURSTS MISSING', text: `Only ${validCount}/${run.cfg.burstCount} bursts were cleanly detected in the MediaStreamTrackProcessor stream.` });
    if (maxSpacingDev > MAX_SPACING_DEVIATION_SAMPLES) run.modeIssues.push({ severity: 'warn', badge: 'WEBCODECS FRAME DRIFT', text: `MediaStreamTrackProcessor burst spacing deviates from WebAudio by up to ${maxSpacingDev.toFixed(1)} samples (dropped or duplicated frames).` });
    if (maxTsErr > MAX_TIMESTAMP_SPACING_ERROR_MS) run.modeIssues.push({ severity: 'warn', badge: 'AUDIODATA TIMESTAMP ERROR', text: `AudioData.timestamp spacing is off by up to ${maxTsErr.toFixed(2)} ms relative to the sample count.` });
    this.finishRun(run);
  }

  // ------------------------------------------------------------ reporting --
  finishRun(run) {
    if (!this.isCurrent(run)) return;
    const cfg = run.cfg;
    const stats = computeStats(run.trials);
    const issues = [];
    const isWav = cfg.mode === 'audio_element_wav';
    const metric = isWav ? 'play()-referenced latency' : 'E2E round-trip latency';

    if (stats.validCount === 0) {
      const bestPsr = run.trials.length ? Math.max(...run.trials.map((t) => t.psrDb)) : 0;
      const maxPeak = run.trials.length ? Math.max(...run.trials.map((t) => t.peakDbFs)) : -120;
      let text = `No valid burst: best PSR ${bestPsr.toFixed(1)} dB (gate ${cfg.minPsrDb} dB).`;
      if (maxPeak < -50) text += ' Input is near silence (< -50 dBFS): check that the dongle is seated and the input is not muted.';
      else if (run.trackSettings && run.trackSettings.echoCancellation === true) text += ' echoCancellation is active and likely cancels the loopback signal.';
      else if (run.trials.some((t) => t.glitch)) text += ' All detected bursts were glitched.';
      else text += ' Raise media volume or the output level and retry.';
      issues.push({ severity: 'fail', badge: 'NO VALID BURST', text });
    } else {
      const lowPsr = run.trials.filter((t) => t.psrDb < cfg.minPsrDb).length;
      const glitched = run.trials.filter((t) => t.glitch);
      const maxPeak = Math.max(...run.trials.map((t) => t.peakDbFs));
      if (glitched.length) issues.push({ severity: 'warn', badge: 'AUDIO GLITCH', text: `${glitched.length} burst(s) show a mid-burst dropout/insertion (${glitched.map((t) => `#${t.burstIndex + 1}: ${t.glitchDelta === null ? 'size unknown' : `${t.glitchDelta} samples`}`).join(', ')}); excluded from stats.` });
      if (lowPsr) issues.push({ severity: 'warn', badge: 'LOW PSR', text: `${lowPsr}/${run.trials.length} burst(s) fell below the ${cfg.minPsrDb} dB PSR gate; excluded from stats.` });
      if (stats.stdDev > cfg.maxStdDevMs) issues.push({ severity: 'warn', badge: 'HIGH JITTER', text: `Burst-to-burst spread ±${stats.stdDev.toFixed(3)} ms exceeds ±${cfg.maxStdDevMs} ms (${stats.histogram.length} distinct lags).` });
      if (maxPeak > CLIP_DBFS) issues.push({ severity: 'warn', badge: 'INPUT CLIPPING', text: `Input peaked at ${maxPeak.toFixed(1)} dBFS; lower the media volume or output level.` });
      if (run.trackSettings && run.trackSettings.echoCancellation === true) issues.push({ severity: 'warn', badge: 'VOICE PROCESSING ACTIVE', text: 'Track reports echoCancellation: true; the voice-communication path adds latency and may distort the signal.' });
    }
    issues.push(...run.modeIssues);

    const fails = issues.filter((i) => i.severity === 'fail');
    const warns = issues.filter((i) => i.severity === 'warn');
    const ordered = [...fails, ...warns];
    let status = 'pass';
    let badge = 'PASS';
    let headline = `${metric}: ${fmt(stats.median)} ms (±${fmt(stats.stdDev, 3)} ms, ${stats.validCount}/${stats.total} bursts)`;
    if (ordered.length) {
      status = fails.length ? 'fail' : 'warn';
      badge = `${status.toUpperCase()} — ${ordered[0].badge}${ordered.length > 1 ? ` (+${ordered.length - 1} more)` : ''}`;
      if (fails.length) headline = 'Measurement failed';
      else headline = `${metric}: ${fmt(stats.median)} ms (±${fmt(stats.stdDev, 3)} ms), ${warns.length} issue(s) need attention`;
    }
    const bullets = ordered.map((i) => i.text).concat(run.notes);
    if (!ordered.length) bullets.unshift(`All ${stats.total} bursts passed the ${cfg.minPsrDb} dB PSR gate with no glitches.`);
    this.setVerdict(status, badge, headline, bullets);
    this.updateSummary(run);
    this.renderEnvironment(run);
    this.publishResult(run, status.toUpperCase(), stats, issues, null);
    this.cleanup(run);
  }

  publishResult(run, verdict, stats, issues, error) {
    const outLat = median(run.outLatSamples);
    const result = {
      timestamp: new Date().toISOString(),
      startedAt: run.startedAt,
      verdict,
      error,
      config: run.cfg,
      effective: {
        sampleRate: run.fs || null,
        trackSampleRate: (run.trackSettings && run.trackSettings.sampleRate) || null,
        intervalMs: run.fs ? (run.intervalSamples / run.fs) * 1000 : null,
        captureWindowMs: run.fs ? (run.captureLength / run.fs) * 1000 : null,
        stimulusLength: run.stimLength || null,
        pilotHz: run.cfg.pilot ? run.pilotFreq || null : null
      },
      reportedLatency: {
        baseLatencyMs: run.baseLatencyMs ?? null,
        outputLatencyMs: outLat,
        rtlMinusReportedMs: (stats.median !== null && (run.baseLatencyMs || outLat)) ? stats.median - (run.baseLatencyMs || 0) - (outLat || 0) : null
      },
      stats,
      issues,
      notes: run.notes,
      trackSettings: run.trackSettings,
      trials: run.trials.map((t) => ({
        burstIndex: t.burstIndex, rtlMs: +t.rtlMs.toFixed(4), lagSamples: +t.lagSamples.toFixed(3),
        psrDb: +t.psrDb.toFixed(2), peakDbFs: +t.peakDbFs.toFixed(2), glitch: t.glitch,
        glitchDeltaSamples: t.glitchDelta, smallGlitchChecked: t.smallGlitchChecked, valid: t.valid,
        spacingDevSamples: t.spacingDevSamples ?? null
      })),
      modeResults: run.modeData
    };
    window.__e2eAudioTestResult = result;
    console.log('E2E_AUDIO_RESULT:' + JSON.stringify(result));
  }

  updateSummary(run) {
    const stats = computeStats(run.trials);
    const cfg = run.cfg;
    const fs = run.fs || 48000;
    const setKpi = (el, value, unit) => {
      el.textContent = value;
      const u = document.createElement('span');
      u.className = 'kpi-unit';
      u.textContent = ` ${unit}`;
      el.append(u);
    };

    if (stats.median === null) {
      setKpi(this.els.kpiRtl, '—', 'ms');
      this.els.kpiRtlSub.textContent = `No valid bursts yet (${stats.total} analyzed)`;
      setKpi(this.els.kpiJitter, '—', 'ms');
      this.els.kpiJitterSub.textContent = `Target: ≤ ±${cfg.maxStdDevMs} ms`;
    } else {
      setKpi(this.els.kpiRtl, stats.median.toFixed(2), 'ms');
      this.els.kpiRtlSub.textContent = `${(stats.median / 1000 * fs).toFixed(1)} samples @ ${fs} Hz | ${stats.min.toFixed(2)}–${stats.max.toFixed(2)} ms`;
      setKpi(this.els.kpiJitter, `±${stats.stdDev.toFixed(3)}`, 'ms');
      this.els.kpiJitterSub.textContent = `Target ≤ ±${cfg.maxStdDevMs} ms | ${stats.histogram.length} distinct lag(s)`;
    }
    const psrs = run.trials.map((t) => t.psrDb);
    setKpi(this.els.kpiPsr, psrs.length ? (psrs.reduce((a, b) => a + b, 0) / psrs.length).toFixed(1) : '—', 'dB');
    this.els.kpiPsrSub.textContent = `Gate ≥ ${cfg.minPsrDb} dB | ${run.trials.filter((t) => t.psrDb >= cfg.minPsrDb).length}/${run.trials.length} pass`;
    const glitches = run.trials.filter((t) => t.glitch).length;
    setKpi(this.els.kpiGlitches, String(glitches), `/ ${run.trials.length}`);
    this.els.kpiGlitchesSub.textContent = glitches ? 'Mid-burst dropout/insertion detected'
      : (cfg.signalType === 'chirp' ? 'Split-peak check only (use MLS for small dropouts)' : 'No dropouts ≥ 2 samples detected');

    this.renderDecomposition(run, stats);
    const histText = stats.histogram.length
      ? stats.histogram.map((h) => `${h.lagSamples}×${h.count}`).join('  ')
      : 'n/a';
    renderRows(this.els.modeResults, [['Distinct lags (samples × count)', histText], ...run.modeRows]);
  }

  renderDecomposition(run, stats) {
    const { segBase, segOutput, segRest, legBase, legOutput, legRest, decompMeta, decompNote } = this.els;
    const applicable = run.cfg.mode === 'webaudio' || run.cfg.mode === 'webcodecs_rx';
    decompMeta.textContent = `Measured RTL: ${fmt(stats.median)} ms`;
    if (!applicable || stats.median === null) {
      [segBase, segOutput, segRest].forEach((s) => { s.style.width = '0%'; });
      decompNote.textContent = applicable
        ? 'Waiting for a valid measurement.'
        : 'Not applicable: baseLatency/outputLatency describe AudioContext.destination, which is not the path under test in this mode.';
      legBase.textContent = 'baseLatency: n/a';
      legOutput.textContent = 'outputLatency: n/a';
      legRest.textContent = 'Input path + unreported output: n/a';
      return;
    }
    const base = run.baseLatencyMs ?? null;
    const out = median(run.outLatSamples);
    const rest = Math.max(0, stats.median - (base || 0) - (out || 0));
    const total = Math.max(stats.median, (base || 0) + (out || 0), 1e-6);
    segBase.style.width = `${((base || 0) / total) * 100}%`;
    segOutput.style.width = `${((out || 0) / total) * 100}%`;
    segRest.style.width = `${(rest / total) * 100}%`;
    legBase.textContent = `baseLatency: ${base === null ? 'not reported' : `${base.toFixed(2)} ms`}`;
    legOutput.textContent = `outputLatency: ${out === null ? 'not reported' : `${out.toFixed(2)} ms`}`;
    legRest.textContent = `Input path + unreported output: ${rest.toFixed(2)} ms`;
    decompNote.textContent = 'RTL − reported output latency. Includes the whole capture path (HAL, Chrome capture, MediaStreamAudioSourceNode FIFO) plus anything outputLatency does not report.';
  }

  renderEnvironment(run) {
    const s = run.trackSettings;
    const fs = run.fs;
    const rows = [
      ['Pipeline', MODE_LABELS[run.cfg.mode]],
      ['AudioContext rate / latencyHint', fs ? `${fs} Hz / ${run.cfg.latencyHint}` : 'n/a'],
      ['Mic track rate', s && s.sampleRate ? `${s.sampleRate} Hz` : (s ? 'not reported' : 'n/a (simulated)')],
      ['baseLatency / outputLatency', `${fmt(run.baseLatencyMs)} / ${fmt(median(run.outLatSamples))} ms`],
      ['echoCancellation / NS / AGC', s ? `${s.echoCancellation} / ${s.noiseSuppression} / ${s.autoGainControl}` : 'n/a'],
      ['Stimulus', `${run.cfg.signalType} (${run.stimLength || '?'} samples) @ ${run.cfg.levelDb} dBFS`],
      ['Capture window / interval', fs ? `${(run.captureLength / fs * 1000).toFixed(1)} / ${(run.intervalSamples / fs * 1000).toFixed(1)} ms` : 'n/a'],
      ['Pilot tone', run.cfg.pilot && run.pilotFreq ? `${Math.round(run.pilotFreq)} Hz @ -55 dBFS` : 'disabled'],
      ['Automation result', 'window.__e2eAudioTestResult']
    ];
    renderRows(this.els.envList, rows);
  }

  resetResultsUi(cfg) {
    this.els.trialBody.replaceChildren();
    this.els.latencyHeader.textContent = cfg.mode === 'audio_element_wav' ? 'play()-Ref. Latency' : 'Round-Trip Latency';
    this.els.kpiRtlLabel.textContent = cfg.mode === 'audio_element_wav' ? 'Median play()-Referenced Latency' : 'Median Round-Trip Latency';
    this.lastPlot = null;
    this.redrawPlots();
    this.updateSummary({ cfg, trials: [], outLatSamples: [], modeRows: [] });
  }

  setButtonsRunning(running) {
    this.els.runBtn.disabled = running;
    this.els.stopBtn.disabled = !running;
  }

  setProgress(text) { this.els.progressPill.textContent = text; }

  setVerdict(state, badge, headline, bullets) {
    this.els.verdictBanner.className = `verdict-banner ${state}`;
    this.els.verdictBadge.textContent = badge;
    this.els.verdictHeadline.textContent = headline;
    this.els.verdictDiagnostics.replaceChildren(...bullets.map((b) => {
      const li = document.createElement('li');
      li.textContent = b;
      return li;
    }));
  }

  appendTrialRow(run, t) {
    const tr = document.createElement('tr');
    const cells = [
      `#${t.burstIndex + 1}`, `${t.rtlMs.toFixed(3)} ms`, t.lagSamples.toFixed(2),
      `${t.psrDb.toFixed(1)} dB`, `${t.peakDbFs.toFixed(1)} dBFS`
    ];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      if (i === 1) {
        const strong = document.createElement('strong');
        strong.textContent = text;
        td.append(strong);
      } else {
        td.textContent = text;
      }
      tr.append(td);
    });
    const td = document.createElement('td');
    const pill = document.createElement('span');
    if (t.valid) { pill.className = 'pill-pass'; pill.textContent = 'PASS'; }
    else if (t.glitch) { pill.className = 'pill-warn'; pill.textContent = t.glitchDelta === null ? 'GLITCH' : `GLITCH (${t.glitchDelta} smp)`; }
    else { pill.className = 'pill-fail'; pill.textContent = 'LOW PSR'; }
    td.append(pill);
    tr.append(td);
    this.els.trialBody.append(tr);
  }

  // ---------------------------------------------------------------- plots --
  setPlot(run, wave, onsetSample, r, onsetKind) {
    const fs = run.fs;
    this.lastPlot = {
      minmax: decimateMinMax(wave, 1200),
      onsetFrac: onsetSample / wave.length,
      onsetLabel: onsetKind === 'RTL' ? `RTL ${((onsetSample / fs) * 1000).toFixed(2)} ms` : `onset @ ${((onsetSample / fs) * 1000).toFixed(1)} ms in window`,
      envelope: r.envelope,
      peakFrac: r.maxLag > 0 ? (r.lag - r.windowStart) / r.maxLag : 0,
      peakLabel: `PSR ${r.psrDb.toFixed(1)} dB`,
      gateNorm: Math.min(1, r.sideRmsNorm * Math.pow(10, run.cfg.minPsrDb / 20))
    };
    this.redrawPlots();
  }

  prepCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 500;
    const h = canvas.clientHeight || 190;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-canvas').trim() || '#0b1120';
    ctx.fillRect(0, 0, w, h);
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    return { ctx, w, h };
  }

  redrawPlots() {
    const p = this.lastPlot;
    {
      const { ctx, w, h } = this.prepCanvas(this.els.waveCanvas);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
      ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
      if (p) {
        let peak = 1e-6;
        for (let i = 0; i < p.minmax.length; i++) peak = Math.max(peak, Math.abs(p.minmax[i]));
        const scale = (h * 0.44) / peak; // Auto-scale so low-level loopback is visible.
        const pts = p.minmax.length / 2;
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x < w; x++) {
          const i = Math.min(pts - 1, Math.floor((x / w) * pts));
          ctx.moveTo(x + 0.5, h / 2 - p.minmax[2 * i + 1] * scale);
          ctx.lineTo(x + 0.5, h / 2 - p.minmax[2 * i] * scale);
        }
        ctx.stroke();
        const ox = p.onsetFrac * w;
        ctx.strokeStyle = '#4ade80';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(ox, 0); ctx.lineTo(ox, h); ctx.stroke();
        ctx.fillStyle = '#4ade80';
        ctx.fillText(p.onsetLabel, Math.max(6, Math.min(w - 170, ox + 6)), 16);
      }
    }
    {
      const { ctx, w, h } = this.prepCanvas(this.els.corrCanvas);
      if (p && p.envelope) {
        const y = (v) => h - 14 - v * (h - 30);
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.55)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(0, y(p.gateNorm)); ctx.lineTo(w, y(p.gateNorm)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = '#f43f5e';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (let i = 0; i < p.envelope.length; i++) {
          const x = (i / (p.envelope.length - 1)) * w;
          if (i === 0) ctx.moveTo(x, y(p.envelope[i])); else ctx.lineTo(x, y(p.envelope[i]));
        }
        ctx.stroke();
        const px = p.peakFrac * w;
        ctx.fillStyle = '#4ade80';
        ctx.beginPath(); ctx.arc(px, y(1), 4, 0, 2 * Math.PI); ctx.fill();
        ctx.fillText(p.peakLabel, Math.max(6, Math.min(w - 110, px + 8)), 16);
      }
    }
  }

  // ---------------------------------------------------------------- export --
  copyShareableUrl() {
    this.syncConfigToUrl();
    navigator.clipboard.writeText(window.location.href).then(() => {
      const orig = this.els.shareBtn.textContent;
      this.els.shareBtn.textContent = 'Copied!';
      setTimeout(() => { this.els.shareBtn.textContent = orig; }, 1500);
    }).catch(() => {});
  }

  exportJsonReport() {
    const payload = window.__e2eAudioTestResult || { error: 'No test run completed yet.' };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `e2e-audio-latency-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.e2eApp = new E2EAudioLatencyApp();
});
