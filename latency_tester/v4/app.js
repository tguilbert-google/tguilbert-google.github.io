'use strict';

/**
 * E2E Audio Loopback Latency Analyzer.
 *
 * Measurement core: a single duplex `AudioWorkletProcessor` emits a band-limited
 * MLS (or log chirp) burst on `outputs[0]` and records `inputs[0]` starting on the
 * exact same `currentFrame`. The FFT matched-filter peak lag in the recording is
 * therefore the round-trip latency in samples. Analysis runs in a Web Worker.
 *
 * Detection is two-stage so that weak loopback signals still produce a result:
 *  1. Each burst is searched over the whole capture window. A peak that clears
 *     `DETECT_GATE_DB` counts on its own.
 *  2. After the last burst, all captures (which are sample-aligned to their
 *     burst start) are averaged. This raises the SNR by 10*log10(N) dB. If the
 *     average clears `DETECT_GATE_DB`, weaker bursts are re-searched in a narrow
 *     window around the averaged lag, where `CONFIRM_GATE_DB` is enough.
 *
 * Modes:
 *  - `webaudio`: worklet -> `AudioContext.destination`.
 *  - `audio_element_stream`: worklet -> `MediaStreamAudioDestinationNode` -> `<audio>.srcObject`.
 *  - `simulated_dongle`: synthetic 142.35 ms loopback, output muted.
 *
 * Automation: `await window.e2eAudio.run(config)` resolves with the same
 * result object as `window.__e2eAudioTestResult` (see `RESULT_SCHEMA_VERSION`).
 * It never rejects; failures resolve with `status` != "ok" and a `reason`.
 */

const API_MODES = ['webaudio', 'audio_element_stream', 'simulated_dongle'];
const SIGNAL_TYPES = ['mls13', 'mls12', 'chirp'];
const LATENCY_HINTS = ['interactive', 'balanced', 'playback'];
const SIGNAL_LENGTHS = { mls13: 8191, mls12: 4095, chirp: 8192 };
const MODE_LABELS = {
  webaudio: 'WebAudio (AudioWorklet duplex)',
  audio_element_stream: '<audio> srcObject (MediaStream)',
  simulated_dongle: 'Simulated dongle (self-test)'
};

// Advanced settings, keyed by URL parameter name. Values are strings as they
// appear in the controls.
const DEFAULT_SETTINGS = {
  mode: 'webaudio', signal: 'mls13', bursts: '5', intervalMs: '757', maxRtlMs: '500',
  levelDb: '-12', latencyHint: 'interactive', rawAudio: 'true', pilot: 'true',
  matchRate: 'false', simGlitch: 'false'
};

// Each profile only lists what it changes from `DEFAULT_SETTINGS`.
const PROFILES = {
  standard: { description: 'Wired loopback dongle (USB-C or 3.5 mm)', overrides: {} },
  quick: { description: 'One burst, to check the setup and levels', overrides: { bursts: '1' } },
  stability: { description: '20 bursts, to catch glitches and latency changes', overrides: { bursts: '20' } },
  bluetooth: { description: 'Wireless or high-latency outputs (up to 2 s round trip)', overrides: { maxRtlMs: '2000' } },
  selftest: { description: 'No hardware needed: checks the page itself', overrides: { mode: 'simulated_dongle' } }
};

// Detection gates, as matched-filter peak-to-sidelobe ratio (PSR). Pure noise
// scores about 12-14 dB when the whole capture window is searched.
const DETECT_GATE_DB = 18;             // Whole-window search: counts on its own.
const CONFIRM_GATE_DB = 14;            // Narrow search around the averaged lag.
const LOW_SNR_DB = 3;                  // Burst level vs. input noise floor.
const JITTER_GATE_MS = 0.5;
const HIGH_LATENCY_JITTER_GATE_MS = 5; // Wireless outputs (max RTL > 500 ms) jitter more.
const HIGH_LATENCY_MAX_RTL_MS = 500;
const MIN_CONSENSUS_WINDOW_MS = 1;     // Half-width of the narrow search window.

const PREROLL_SECONDS = 0.5;           // Pilot / sink / input warm-up before burst #1.
const INTERVAL_GUARD_SECONDS = 0.05;   // Minimum silence between capture windows.
const CAPTURE_MARGIN_SECONDS = 0.02;
const RESUME_TIMEOUT_MS = 3000;
const WATCHDOG_EXTRA_MS = 10000;
const PILOT_MAX_HZ = 19000;
const PILOT_MAX_FRACTION_OF_FS = 0.47; // Stimulus band tops out at 0.40 * fs.
const CLIP_DBFS = -0.3;
const SIM_DELAY_SECONDS = 0.14235;
const CHECK_TONE_HZ = 1000;            // Input check: pulsed tone frequency.
const CHECK_CYCLES = 2;                // Input check: 1 s off + 1 s on per cycle.
const CHECK_TONE_MIN_DELTA_DB = 10;    // Input check: tone-on vs tone-off at the input.
const CHECK_FLOOR_DB = -120;           // Input check: floor for silent readings.
const CHECK_SILENT_DB = -115;          // Input check: RMS at or below this is digital silence.

// Automation. Bump `RESULT_SCHEMA_VERSION` (and freeze a new versioned copy of
// the page) on any breaking change to the result object.
const RESULT_SCHEMA_VERSION = 1;
const MIN_DETECTED_FRACTION = 0.5;     // Fewer detected bursts: `measurement_error`.
const RUN_OPTIONS = ['input', 'output', 'preflight', 'quiet']; // Automation-only options.
const CLOCK_SAMPLE_INTERVAL_MS = 50;   // Audio clock vs. `performance.now()` sampling.
const CLOCK_WINDOW_MS = 1000;          // Samples within this distance map a burst.
const TRACE_PREFIX = 'e2e-audio:';     // User Timing entry names.
const SETUP_TIMEOUT_MS = 30000;        // Automated runs: device setup + preflight.

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
    this.simMode = false;
    this.simDelaySamples = 0;
    this.simGlitchBurst = -1;

    this.running = false;
    this.burstIndex = 0;
    this.totalBursts = 0;
    this.intervalSamples = 0;
    this.nextBurstStartFrame = 0;

    this.capturing = false;
    this.txStartFrame = 0;
    this.rxBuffer = null;
    this.rxWritePos = 0;
    this.missingInputFrames = 0;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'CONFIGURE':
        this.runId = msg.runId;
        this.stimulus = msg.stimulus;
        this.pilotEnabled = Boolean(msg.pilotEnabled);
        this.pilotFreq = msg.pilotFreq;
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
        this.running = true;
        this.totalBursts = msg.totalBursts;
        this.intervalSamples = msg.intervalSamples;
        this.burstIndex = 0;
        this.nextBurstStartFrame = currentFrame + msg.prerollSamples;
        break;
      case 'STOP':
        this.running = false;
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
    this.port.postMessage({
      type: 'BURST_CAPTURED', runId: this.runId, burstIndex: this.burstIndex,
      txStartFrame: this.txStartFrame, missingInputFrames: this.missingInputFrames, rxBuffer: buf
    }, [buf.buffer]);
    this.burstIndex++;
    if (this.burstIndex < this.totalBursts) {
      // Schedule from the previous burst start so the configured interval is honored.
      this.nextBurstStartFrame = this.txStartFrame + this.intervalSamples;
    } else {
      this.running = false;
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

      if (this.running && !this.capturing && this.burstIndex < this.totalBursts &&
          absFrame >= this.nextBurstStartFrame) {
        const buf = this.pool.pop();
        if (buf) {
          this.rxBuffer = buf;
          this.rxWritePos = 0;
          this.missingInputFrames = 0;
          this.capturing = true;
          this.txStartFrame = absFrame;
        }
        // Otherwise wait for a recycled buffer; the actual txStartFrame is reported.
      }

      let out = 0;
      if (this.pilotEnabled) {
        out += this.pilotAmp * Math.sin(this.pilotPhase);
        this.pilotPhase += pilotStep;
        if (this.pilotPhase > 2 * Math.PI) this.pilotPhase -= 2 * Math.PI;
      }
      if (this.capturing) {
        const k = absFrame - this.txStartFrame;
        if (k < this.stimulus.length) out += this.stimulus[k];
      }
      if (output) {
        for (let c = 0; c < output.length; c++) output[c][i] = out;
      }

      if (this.capturing) {
        let s = 0;
        if (this.simMode) s = this.simulate(absFrame - this.txStartFrame);
        else if (inMono) s = inMono[i];
        else this.missingInputFrames++;
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
// Per-run accumulator: { runId, rxSum, count, bursts[] }.
let RUN = null;
const DETECT_GATE_DB = ${DETECT_GATE_DB};
const CONFIRM_GATE_DB = ${CONFIRM_GATE_DB};
const SPLIT_PEAK_EXCLUSION = 40;       // Samples around the main peak excluded from sidelobe stats.
const SPLIT_PEAK_MAX_RATIO_DB = 9.5;   // A second peak within this of the main peak => glitch.
const QUARTER_SEARCH_RADIUS = 48;      // Small-glitch detector search (+/- samples).
const QUARTER_MIN_EXTRA_PSR_DB = 12;   // Only run small-glitch check with SNR headroom.
const QUARTER_MAX_RESIDUAL = 0.45;     // Quarter-lag deviation from a line (samples) => glitch.
const QUARTER_MIN_NCC_RATIO = 0.6;     // Worst/best quarter normalized correlation => glitch.
const LEVEL_BLOCK = 1024;              // Block size for noise-floor / burst-level estimates.
const ENVELOPE_POINTS = 500;

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
function ampDb(ratio) { return 20 * Math.log10(Math.max(1e-12, ratio)); }
function powDb(meanSquare) { return 10 * Math.log10(Math.max(1e-12, meanSquare)); }

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

// Cross-correlation of rx with the stimulus for lags [0, rx.length - L].
function correlate(rx) {
  const L = STIM.length;
  const maxLag = rx.length - L;
  if (maxLag < 2) throw new Error('Capture window is shorter than the stimulus.');
  const n = nextPow2(rx.length + L);
  const spec = stimSpectrum(n);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  re.set(rx);
  fft(re, im, false);
  for (let k = 0; k < n; k++) {
    const yr = re[k], yi = im[k], xr = spec.re[k], xi = -spec.im[k];
    re[k] = yr * xr - yi * xi;
    im[k] = yr * xi + yi * xr;
  }
  fft(re, im, true);
  return re.slice(0, maxLag + 1);
}

// Largest |corr| in [lo, hi], refined to a fraction of a sample. atEdge is
// true when the maximum sits on a search boundary inside the correlation,
// i.e. the real peak is probably outside the window.
function findPeak(corr, lo, hi) {
  lo = Math.max(0, Math.round(lo));
  hi = Math.min(corr.length - 1, Math.round(hi));
  let idx = lo, val = -1;
  for (let i = lo; i <= hi; i++) {
    const v = Math.abs(corr[i]);
    if (v > val) { val = v; idx = i; }
  }
  let delta = 0;
  if (idx > 0 && idx < corr.length - 1) {
    delta = parabolicOffset(Math.abs(corr[idx - 1]), val, Math.abs(corr[idx + 1]));
  }
  const atEdge = (idx === lo && lo > 0) || (idx === hi && hi < corr.length - 1);
  return { idx, lag: idx + delta, val: Math.max(0, val), atEdge };
}

function sidelobes(corr, idx) {
  let sumSq = 0, count = 0, secondVal = 0, secondIdx = -1;
  for (let i = 0; i < corr.length; i++) {
    if (Math.abs(i - idx) <= SPLIT_PEAK_EXCLUSION) continue;
    const v = Math.abs(corr[i]);
    sumSq += v * v;
    count++;
    if (v > secondVal) { secondVal = v; secondIdx = i; }
  }
  return { rms: Math.sqrt(sumSq / Math.max(1, count)), secondVal, secondIdx };
}

// Input levels. The burst covers only part of the capture window, so the
// median block power approximates the noise floor, and the loudest blocks
// (as many as the burst spans) approximate the received burst.
function levels(rx) {
  let maxAbs = 0, sumSq = 0;
  const blocks = [];
  for (let b = 0; b < rx.length; b += LEVEL_BLOCK) {
    const e = Math.min(rx.length, b + LEVEL_BLOCK);
    let s = 0;
    for (let i = b; i < e; i++) {
      const v = rx[i];
      s += v * v;
      const a = Math.abs(v);
      if (a > maxAbs) maxAbs = a;
    }
    sumSq += s;
    if (e - b === LEVEL_BLOCK) blocks.push(s / LEVEL_BLOCK);
  }
  blocks.sort((a, b) => a - b);
  const k = Math.max(1, Math.min(blocks.length >> 1, Math.floor(STIM.length / LEVEL_BLOCK)));
  const noise = blocks.length ? blocks[blocks.length >> 1] : 0;
  let top = 0;
  for (let i = blocks.length - k; i < blocks.length; i++) top += blocks[i];
  top /= k;
  return {
    peakDbFs: 20 * Math.log10(Math.max(1e-7, maxAbs)),
    rmsDbFs: powDb(sumSq / Math.max(1, rx.length)),
    noiseDbFs: powDb(noise),
    rxSnrDb: powDb(top) - powDb(noise),
    silent: maxAbs === 0
  };
}

function envelope(corr, peakVal) {
  const env = new Float32Array(ENVELOPE_POINTS);
  const step = (corr.length - 1) / ENVELOPE_POINTS;
  for (let p = 0; p < ENVELOPE_POINTS; p++) {
    const s = Math.floor(p * step);
    const e = Math.min(corr.length, Math.floor((p + 1) * step) + 1);
    let m = 0;
    for (let i = s; i < e; i++) m = Math.max(m, Math.abs(corr[i]));
    env[p] = m / Math.max(1e-12, peakVal);
  }
  return env;
}

// Matched filter over the whole capture. Returned lag is absolute in rx.
function analyzeCapture(rx) {
  const corr = correlate(rx);
  const peak = findPeak(corr, 0, corr.length - 1);
  const side = sidelobes(corr, peak.idx);
  const psrDb = Math.max(0, ampDb(peak.val / Math.max(1e-12, side.rms)));
  const secondRatioDb = ampDb(peak.val / Math.max(1e-12, side.secondVal));

  // A split peak needs a second arrival that would be a detection on its own;
  // otherwise, at moderate PSR, the tallest noise lobe looks like one.
  const splitPeak = psrDb >= DETECT_GATE_DB && psrDb - secondRatioDb >= DETECT_GATE_DB &&
    secondRatioDb < SPLIT_PEAK_MAX_RATIO_DB;
  let quarter = null;
  if (STIM_BROADBAND && psrDb >= DETECT_GATE_DB + QUARTER_MIN_EXTRA_PSR_DB) quarter = quarterLagFit(rx, peak.idx);
  const stepGlitch = quarter !== null && quarter.residual > QUARTER_MAX_RESIDUAL;
  const nccGlitch = quarter !== null && quarter.nccRatio < QUARTER_MIN_NCC_RATIO;
  const smallGlitch = !splitPeak && (stepGlitch || nccGlitch);
  // null => a glitch was detected but its size could not be estimated.
  const glitchDelta = splitPeak ? Math.abs(side.secondIdx - peak.idx)
    : (stepGlitch ? Math.round(quarter.step) : (nccGlitch ? null : 0));

  return {
    corr,
    lag: peak.lag,
    maxLag: corr.length - 1,
    psrDb,
    secondRatioDb,
    sideRms: side.rms,
    sideRmsNorm: side.rms / Math.max(1e-12, peak.val),
    splitPeak,
    smallGlitch,
    smallGlitchChecked: quarter !== null,
    quarterResidual: quarter ? quarter.residual : null,
    quarterNccRatio: quarter ? quarter.nccRatio : null,
    driftPpm: quarter ? quarter.driftPpm : null,
    glitch: splitPeak || smallGlitch,
    glitchDelta,
    ...levels(rx),
    envelope: envelope(corr, peak.val)
  };
}

// Final per-burst verdict, given the analysis of the averaged capture.
function decideBurst(b, burstIndex, combined, windowSamples) {
  const out = {
    burstIndex, lag: b.lag, psrDb: b.psrDb, glitch: b.glitch, glitchDelta: b.glitchDelta,
    method: 'direct', offConsensus: false, valid: false, status: 'not_detected'
  };
  const combinedOk = combined.psrDb >= DETECT_GATE_DB;
  if (b.psrDb >= DETECT_GATE_DB) {
    out.valid = !b.glitch;
    out.status = b.glitch ? 'glitch' : 'pass';
    out.offConsensus = !b.glitch && combinedOk && Math.abs(b.lag - combined.lag) > windowSamples;
    return out;
  }
  if (!combinedOk) return out;
  const c = Math.round(combined.lag);
  const p = findPeak(b.corr, c - windowSamples, c + windowSamples);
  const psrDb = ampDb(p.val / Math.max(1e-12, b.sideRms));
  if (!p.atEdge && psrDb >= CONFIRM_GATE_DB) {
    Object.assign(out, { lag: p.lag, psrDb, glitch: false, glitchDelta: 0, method: 'consensus', valid: true, status: 'weak' });
  }
  return out;
}

function withoutCorr(r) {
  const out = Object.assign({}, r);
  delete out.corr;
  return out;
}

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'PREPARE_STIMULUS') {
      STIM = generateStimulus(msg.signalType, msg.sampleRate, msg.levelDb);
      STIM_BROADBAND = msg.signalType !== 'chirp';
      SPECTRUM_CACHE.clear();
      RUN = { runId: msg.runId, rxSum: null, count: 0, bursts: [] };
      self.postMessage({ type: 'STIMULUS_READY', runId: msg.runId, stimulus: STIM.slice() });
    } else if (msg.type === 'ANALYZE_BURST') {
      const rx = msg.rxBuffer;
      const r = analyzeCapture(rx);
      if (RUN && RUN.runId === msg.runId) {
        // Captures start on their burst's first output frame, so they are
        // sample-aligned and can be averaged coherently.
        if (!RUN.rxSum) RUN.rxSum = new Float64Array(rx.length);
        for (let i = 0; i < rx.length; i++) RUN.rxSum[i] += rx[i];
        RUN.count++;
        RUN.bursts[msg.burstIndex] = { corr: r.corr, sideRms: r.sideRms, lag: r.lag, psrDb: r.psrDb, glitch: r.glitch, glitchDelta: r.glitchDelta };
      }
      const out = withoutCorr(r);
      out.type = 'BURST_ANALYZED';
      out.runId = msg.runId;
      out.burstIndex = msg.burstIndex;
      out.rxWaveform = rx;
      self.postMessage(out, [rx.buffer]);
    } else if (msg.type === 'FINALIZE') {
      if (!RUN || RUN.runId !== msg.runId || !RUN.count) throw new Error('No captured bursts to combine.');
      const avg = new Float32Array(RUN.rxSum.length);
      for (let i = 0; i < avg.length; i++) avg[i] = RUN.rxSum[i] / RUN.count;
      const combined = analyzeCapture(avg);
      combined.count = RUN.count;
      const decisions = [];
      RUN.bursts.forEach((b, k) => { if (b) decisions.push(decideBurst(b, k, combined, msg.windowSamples)); });
      RUN = null;
      self.postMessage({ type: 'RUN_ANALYZED', runId: msg.runId, combined: withoutCorr(combined), decisions, rxAverage: avg }, [avg.buffer]);
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

// Attaches a machine-readable `reason` (and optional hints) to an error.
function withReason(err, reason, hints) {
  err.reason = reason;
  if (hints) err.hints = hints;
  return err;
}

// The version tag in the page header is the single source of truth.
function pageVersion() {
  const el = document.querySelector('.version-tag');
  return el ? el.textContent.trim() : null;
}

// Burst statuses where the stimulus was found (glitched bursts included).
const DETECTED_STATUSES = new Set(['pass', 'weak', 'glitch']);

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

// Mono IEEE-float WAV, so offline analysis sees the exact captured values.
function createFloatWavBlob(samples, sampleRate) {
  const n = samples.length;
  const buffer = new ArrayBuffer(44 + n * 4);
  const view = new DataView(buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + n * 4, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true); view.setUint16(34, 32, true);
  str(36, 'data'); view.setUint32(40, n * 4, true);
  new Float32Array(buffer, 44, n).set(samples);
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
    if (autorun) setTimeout(() => this.startTestRun(this.urlRunOptions), 300);
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
      runBtn: $('run-test-btn'), stopBtn: $('stop-test-btn'), checkBtn: $('check-input-btn'),
      shareBtn: $('copy-config-btn'), exportJsonBtn: $('export-json-btn'), downloadBtn: $('download-capture-btn'),
      progressPill: $('progress-pill'),
      profile: $('cfg-profile'), profileDesc: $('profile-desc'), advanced: $('advanced-settings'),
      apiMode: $('cfg-api-mode'), signalType: $('cfg-signal-type'), burstCount: $('cfg-burst-count'),
      intervalMs: $('cfg-interval-ms'), maxRtlMs: $('cfg-max-rtl'), levelDb: $('cfg-output-level'),
      latencyHint: $('cfg-latency-hint'),
      inputDevice: $('cfg-input-device'), outputDevice: $('cfg-output-device'),
      disableAec: $('cfg-disable-aec'), pilot: $('cfg-pilot-tone'), matchRate: $('cfg-match-rate'),
      simGlitch: $('cfg-sim-glitch'),
      verdictBanner: $('verdict-banner'), verdictBadge: $('verdict-badge'),
      verdictHeadline: $('verdict-headline'), verdictDiagnostics: $('verdict-diagnostics'),
      kpiRtl: $('kpi-rtl-median'), kpiRtlSub: $('kpi-rtl-sub'),
      kpiJitter: $('kpi-jitter'), kpiJitterSub: $('kpi-jitter-sub'),
      kpiPsr: $('kpi-psr'), kpiPsrSub: $('kpi-psr-sub'),
      kpiGlitches: $('kpi-glitches'), kpiGlitchesSub: $('kpi-glitches-sub'),
      segBase: $('seg-base'), segOutput: $('seg-output'), segRest: $('seg-os'),
      legBase: $('leg-base'), legOutput: $('leg-output'), legRest: $('leg-os'),
      decompMeta: $('decomp-meta'), decompNote: $('decomp-note'),
      signalDetails: $('signal-details-list'), waveMeta: $('wave-meta'),
      waveCanvas: $('waveform-canvas'), corrCanvas: $('correlation-canvas'),
      trialBody: $('trial-table-body'), envList: $('env-metadata-list')
    };

    this.els.runBtn.addEventListener('click', () => this.startTestRun());
    this.els.stopBtn.addEventListener('click', () => this.stopTestRun());
    this.els.checkBtn.addEventListener('click', () => this.checkInput());
    this.els.shareBtn.addEventListener('click', () => this.copyShareableUrl());
    this.els.exportJsonBtn.addEventListener('click', () => this.exportJsonReport());
    this.els.downloadBtn.addEventListener('click', () => this.downloadCapture());
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
      latencyHint: { el: e.latencyHint, type: 'select' }, rawAudio: { el: e.disableAec, type: 'bool' },
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
    const c = this.readConfig();
    const summary = `${MODE_LABELS[c.mode]} · ${c.burstCount} burst${c.burstCount > 1 ? 's' : ''} · max RTL ${c.maxRtlMs} ms · jitter gate ±${c.jitterGateMs} ms`;
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
    // Run options only apply to `autorun`; manual runs use the controls.
    this.urlRunOptions = {
      automated: true, input: p.get('input') || '', output: p.get('output') || '',
      preflight: p.get('preflight') !== 'false', quiet: p.get('quiet') === 'true'
    };
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

  readConfig() {
    const num = (el, def, min, max) => {
      const v = Number(el.value);
      return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
    };
    const pick = (el, allowed, def) => (allowed.includes(el.value) ? el.value : def);
    const maxRtlMs = num(this.els.maxRtlMs, 500, 100, 3000);
    const jitterGateMs = maxRtlMs > HIGH_LATENCY_MAX_RTL_MS ? HIGH_LATENCY_JITTER_GATE_MS : JITTER_GATE_MS;
    return {
      mode: pick(this.els.apiMode, API_MODES, 'webaudio'),
      signalType: pick(this.els.signalType, SIGNAL_TYPES, 'mls13'),
      burstCount: Math.round(num(this.els.burstCount, 5, 1, 50)),
      intervalMs: num(this.els.intervalMs, 757, 300, 5000),
      maxRtlMs,
      jitterGateMs,
      consensusWindowMs: Math.max(MIN_CONSENSUS_WINDOW_MS, 2 * jitterGateMs),
      levelDb: num(this.els.levelDb, -12, -40, -1),
      latencyHint: pick(this.els.latencyHint, LATENCY_HINTS, 'interactive'),
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

  // Automation entry point. `config` takes the URL parameter names (`profile`,
  // any key of `DEFAULT_SETTINGS`, and `RUN_OPTIONS`). Resolves with the result
  // object; never rejects.
  async runAutomated(config = {}) {
    if (this.run || this.checking) {
      return this.standaloneResult('setup_error', 'busy', 'A run or input check is already in progress.');
    }
    const known = new Set(['profile', ...Object.keys(DEFAULT_SETTINGS), ...RUN_OPTIONS]);
    const unknown = Object.keys(config).filter((k) => !known.has(k));
    if (unknown.length) return this.standaloneResult('setup_error', 'invalid_config', `Unknown config key(s): ${unknown.join(', ')}.`);
    if (config.profile !== undefined && !PROFILES[config.profile]) {
      return this.standaloneResult('setup_error', 'invalid_config', `Unknown profile "${config.profile}".`);
    }
    // Reject values the controls can't represent, instead of silently ignoring them.
    const fields = this.fields();
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (!(key in config)) continue;
      const { el, type } = fields[key];
      const v = String(config[key]);
      const ok = type === 'bool' ? (v === 'true' || v === 'false')
        : type === 'select' ? [...el.options].some((o) => o.value === v)
          : Number.isFinite(Number(v));
      if (!ok) return this.standaloneResult('setup_error', 'invalid_config', `Invalid value for "${key}": "${v}".`);
    }
    this.applyProfile(config.profile || 'standard');
    const overrides = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) if (key in config) overrides[key] = String(config[key]);
    this.applySettings(overrides);
    this.updateProfileFromFields();
    return this.startTestRun({
      automated: true, input: config.input || '', output: config.output || '',
      preflight: config.preflight !== false && config.preflight !== 'false',
      quiet: config.quiet === true || config.quiet === 'true'
    });
  }

  // Resolves with the result (also published to `window.__e2eAudioTestResult`).
  // `opts`: `input` / `output` label regexes, `preflight`, `quiet`.
  async startTestRun(opts = {}) {
    if (this.run || this.checking) {
      return this.standaloneResult('setup_error', 'busy', 'A run or input check is already in progress.');
    }
    const cfg = this.readConfig();
    const run = {
      id: ++this.runCounter, cfg, startedAt: new Date().toISOString(),
      opts: {
        input: opts.input || '', output: opts.output || '', preflight: Boolean(opts.preflight),
        quiet: Boolean(opts.quiet), automated: Boolean(opts.automated)
      },
      trials: [], tx: [], outLatSamples: [], notes: [], missingInputFrames: 0, combined: null,
      captures: [], average: null, preflight: null, result: null
    };
    run.done = new Promise((resolve) => { run.resolve = resolve; });
    this.run = run;
    this.resetResultsUi(cfg);
    this.setButtonsRunning(true);
    this.setVerdict('idle', 'RUNNING', `Starting ${MODE_LABELS[cfg.mode]}...`, []);
    // Nobody can answer a permission prompt on a bot. `launchPipeline()` re-arms
    // the watchdog for the measurement itself.
    if (run.opts.automated) this.armWatchdog(run, SETUP_TIMEOUT_MS, { status: 'setup_error', reason: 'setup_timeout' });

    try {
      await this.resolveDevices(run);
      if (!this.isCurrent(run)) return run.done;
      if (run.opts.preflight) {
        this.setProgress('Preflight: checking the loopback path...');
        run.preflight = await this.measureTone(cfg);
        if (!this.isCurrent(run)) return run.done;
        if (run.preflight.verdict !== 'ok') {
          const v = this.toneVerdict(run.preflight);
          this.failRun(run, `PREFLIGHT ${v.title}`, v.text, v.hints,
            { status: 'setup_error', reason: `preflight_${run.preflight.verdict}` });
          return run.done;
        }
      }
      await this.setupAudio(run);
      if (!this.isCurrent(run)) return run.done;
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
      this.failRun(run, 'SETUP ERROR', `Could not initialize audio: ${errMsg(err)}`, hints,
        { status: 'setup_error', reason: err.reason || 'setup_failed' });
    }
    return run.done;
  }

  // Picks the input/output devices whose labels match `run.opts.input` /
  // `run.opts.output` (case-insensitive regexes). Throws with a `reason` if
  // nothing matches, instead of falling back to the default device.
  async resolveDevices(run) {
    const { cfg, opts } = run;
    run.outputSelection = cfg.outputDeviceId ? 'selected' : 'default';
    if (cfg.outputDeviceId) run.outputLabel = this.els.outputDevice.selectedOptions[0]?.text || null;
    if (cfg.mode === 'simulated_dongle' || (!opts.input && !opts.output)) return;
    const compile = (pattern, what) => {
      try {
        return new RegExp(pattern, 'i');
      } catch (_) {
        throw withReason(new Error(`Invalid ${what} pattern "${pattern}".`), 'invalid_config', []);
      }
    };
    const inputRe = opts.input ? compile(opts.input, 'input') : null;
    const outputRe = opts.output ? compile(opts.output, 'output') : null;
    let devices = await navigator.mediaDevices.enumerateDevices();
    if (!devices.some((d) => d.label)) {
      // Labels are only exposed once microphone permission is granted.
      const s = await this.openMic({ ...cfg, inputDeviceId: '' });
      s.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    }
    // Prefer concrete devices over the "default" / "communications" aliases.
    const isAlias = (d) => (d.deviceId === 'default' || d.deviceId === 'communications' ? 1 : 0);
    const pick = (kind, re) => devices.filter((d) => d.kind === kind && re.test(d.label))
      .sort((a, b) => isAlias(a) - isAlias(b))[0];
    const labels = (kind) => devices.filter((d) => d.kind === kind).map((d) => `"${d.label}"`).join(', ') || 'none';
    if (inputRe) {
      const d = pick('audioinput', inputRe);
      if (!d) {
        throw withReason(new Error(`No input device matches /${opts.input}/i. Inputs: ${labels('audioinput')}.`),
          'no_input_match', ['Check that the loopback device is connected and exposes an input.']);
      }
      cfg.inputDeviceId = d.deviceId;
    }
    if (outputRe) {
      if (typeof AudioContext.prototype.setSinkId !== 'function') {
        run.outputSelection = 'unsupported';
        run.notes.push('This browser cannot select an audio output; the default output is used.');
      } else {
        const d = pick('audiooutput', outputRe);
        if (!d) {
          throw withReason(new Error(`No output device matches /${opts.output}/i. Outputs: ${labels('audiooutput')}.`),
            'no_output_match', ['Check that the loopback device is connected and exposes an output.']);
        }
        cfg.outputDeviceId = d.deviceId;
        run.outputSelection = 'selected';
        run.outputLabel = d.label;
      }
    }
    // Show the chosen devices in the controls.
    await this.refreshDevices();
    setSelectIfValid(this.els.inputDevice, cfg.inputDeviceId);
    setSelectIfValid(this.els.outputDevice, cfg.outputDeviceId);
  }

  // A result for failures that happen before a run exists. Not published.
  standaloneResult(status, reason, message) {
    return {
      schemaVersion: RESULT_SCHEMA_VERSION, status, reason, message, metrics: null,
      environment: { pageVersion: pageVersion(), userAgent: navigator.userAgent },
      timestamp: new Date().toISOString(), verdict: 'FAIL', error: message
    };
  }

  // Maps a `getUserMedia()` / `setSinkId()` failure to an actionable error.
  describeDeviceError(err, step, cfg) {
    const name = err && err.name;
    let message = `${step}: ${errMsg(err)}`;
    let hints;
    let reason = step === 'Output device' ? 'output_unavailable' : 'input_failed';
    if (step === 'Microphone' && (name === 'NotFoundError' || name === 'OverconstrainedError')) {
      if (cfg.inputDeviceId) {
        message = 'Microphone: the selected input device is no longer available (unplugged or re-enumerated).';
        reason = 'input_unavailable';
        hints = ['The device list has been refreshed. Pick the input again (or "Default Hardware Input") and retry.'];
      } else {
        message = 'Microphone: no audio input device was found.';
        reason = 'no_input_device';
        hints = [
          'Plug in the loopback dongle. On phones, TRRS dongles need a 4-pole plug to expose a mic input.',
          'Check that the OS sees an input device, and that no OS/enterprise policy disables the microphone.',
          'No dongle attached? Choose the "Self-test" profile.'
        ];
      }
    } else if (step === 'Microphone' && (name === 'NotAllowedError' || name === 'SecurityError')) {
      message = 'Microphone: permission denied.';
      reason = 'permission_denied';
      hints = ['Allow microphone access from the site settings in the address bar and retry.',
        'The page must be served over https:// (or localhost).'];
    } else if (step === 'Microphone' && (name === 'NotReadableError' || name === 'AbortError')) {
      message = 'Microphone: the input device could not be opened.';
      reason = 'input_busy';
      hints = ['Another app may be holding the device exclusively. Close it and retry, or replug the dongle.'];
    } else if (step === 'Output device') {
      message = 'Output device: the selected output sink is not available.';
      hints = ['The device list has been refreshed. Pick the output again (or "Default System Output") and retry.'];
    }
    return withReason(new Error(message), reason, hints);
  }

  async openMic(cfg) {
    const voice = !cfg.disableAec;
    const audio = {
      echoCancellation: { ideal: voice }, noiseSuppression: { ideal: voice },
      autoGainControl: { ideal: voice }, channelCount: { ideal: 1 }
    };
    if (cfg.inputDeviceId) audio.deviceId = { exact: cfg.inputDeviceId };
    try {
      return await navigator.mediaDevices.getUserMedia({ audio });
    } catch (err) {
      throw this.describeDeviceError(err, 'Microphone', cfg);
    } finally {
      this.refreshDevices();
    }
  }

  // Creates a running `AudioContext` on the selected output, or throws.
  async openContext(cfg, trackSettings) {
    const ctxOptions = { latencyHint: cfg.latencyHint };
    if (cfg.matchRate && trackSettings && trackSettings.sampleRate) ctxOptions.sampleRate = trackSettings.sampleRate;
    const ctx = new AudioContext(ctxOptions);
    try {
      if (cfg.outputDeviceId && typeof ctx.setSinkId === 'function') {
        try {
          await ctx.setSinkId(cfg.outputDeviceId);
        } catch (err) {
          this.refreshDevices();
          throw this.describeDeviceError(err, 'Output device', cfg);
        }
      }
      try {
        await withTimeout(ctx.resume(), RESUME_TIMEOUT_MS,
          'AudioContext did not start (autoplay policy). Click "Run Latency Test", or launch Chrome with --autoplay-policy=no-user-gesture-required for autorun.');
      } catch (err) {
        throw withReason(err, 'autoplay_blocked');
      }
      if (ctx.state !== 'running') throw withReason(new Error(`AudioContext state is "${ctx.state}".`), 'context_not_running');
      return ctx;
    } catch (err) {
      ctx.close().catch(() => {});
      throw err;
    }
  }

  // Plays a pulsed tone on the selected output and measures it on the selected
  // input, without touching the UI. Independent of the latency analysis, so it
  // separates routing/level problems from analysis problems. Resolves with
  // `{verdict: 'ok' | 'silent_input' | 'tone_not_received', ...levels}`; throws
  // (with a `reason`) if the devices can't be opened.
  async measureTone(cfg, onProgress = () => {}) {
    const simulated = cfg.mode === 'simulated_dongle';
    let stream = null, ctx = null;
    try {
      let track = null, settings = {};
      if (!simulated) {
        stream = await this.openMic(cfg);
        track = stream.getAudioTracks()[0];
        settings = track.getSettings ? track.getSettings() : {};
      }
      ctx = await this.openContext(cfg, settings);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 8192;
      analyser.smoothingTimeConstant = 0;
      const mute = ctx.createGain();
      mute.gain.value = 0;
      analyser.connect(mute).connect(ctx.destination);
      const osc = ctx.createOscillator();
      osc.frequency.value = CHECK_TONE_HZ;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      if (simulated) {
        // Self-test: loop the tone back internally, like the simulated dongle.
        const delay = ctx.createDelay(1);
        delay.delayTime.value = SIM_DELAY_SECONDS;
        gain.connect(delay).connect(analyser);
      } else {
        ctx.createMediaStreamSource(stream).connect(analyser);
        gain.connect(ctx.destination);
      }
      osc.start();
      // Each cycle is 1 s off then 1 s on. Only the last 300 ms of each
      // segment is measured. With the ~170 ms analyser window, this tolerates
      // about 500 ms of round trip.
      const amp = Math.pow(10, cfg.levelDb / 20);
      const t0 = ctx.currentTime + 0.1;
      for (let k = 0; k < CHECK_CYCLES; k++) {
        gain.gain.setValueAtTime(amp, t0 + 2 * k + 1);
        gain.gain.setValueAtTime(0, t0 + 2 * k + 2);
      }
      const bin = Math.round(CHECK_TONE_HZ / (ctx.sampleRate / analyser.fftSize));
      const freq = new Float32Array(analyser.frequencyBinCount);
      const time = new Float32Array(analyser.fftSize);
      const on = { tone: [], rms: [] }, off = { tone: [], rms: [] };
      const end = t0 + 2 * CHECK_CYCLES;
      while (ctx.currentTime < end) {
        await new Promise((r) => setTimeout(r, 50));
        const p = (ctx.currentTime - t0) % 2;
        const bucket = (p >= 0.7 && p < 1) ? off : (p >= 1.7 ? on : null);
        analyser.getFloatFrequencyData(freq);
        analyser.getFloatTimeDomainData(time);
        let tone = CHECK_FLOOR_DB;
        for (let i = bin - 2; i <= bin + 2; i++) tone = Math.max(tone, freq[i]);
        let sumSq = 0;
        for (const v of time) sumSq += v * v;
        const rms = Math.max(CHECK_FLOOR_DB, 10 * Math.log10(sumSq / time.length));
        onProgress(`${rms.toFixed(1)} dBFS RMS, ${CHECK_TONE_HZ} Hz at ${tone.toFixed(1)} dB`);
        if (bucket && ctx.currentTime > t0) {
          bucket.tone.push(tone);
          bucket.rms.push(rms);
        }
      }
      osc.stop();
      const toneOnDb = median(on.tone), toneOffDb = median(off.tone);
      const rmsOnDb = median(on.rms), rmsOffDb = median(off.rms);
      const deltaDb = (toneOnDb ?? CHECK_FLOOR_DB) - (toneOffDb ?? CHECK_FLOOR_DB);
      let verdict = 'tone_not_received';
      if (deltaDb >= CHECK_TONE_MIN_DELTA_DB) verdict = 'ok';
      else if (rmsOnDb !== null && rmsOnDb <= CHECK_SILENT_DB && rmsOffDb <= CHECK_SILENT_DB) verdict = 'silent_input';
      return {
        verdict, toneHz: CHECK_TONE_HZ, deltaDb, toneOnDb, toneOffDb, rmsOnDb, rmsOffDb,
        simulated, inputLabel: track ? track.label || null : null,
        trackSettings: track ? {
          echoCancellation: settings.echoCancellation, noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGainControl
        } : null
      };
    } finally {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (ctx) ctx.close().catch(() => {});
    }
  }

  // Human-readable verdict for a `measureTone()` result.
  toneVerdict(t) {
    const s = t.trackSettings;
    const levels = [
      `Input level with tone: ${fmt(t.rmsOnDb, 1)} dBFS RMS; without: ${fmt(t.rmsOffDb, 1)} dBFS RMS.`,
      `${t.toneHz} Hz at the input: ${fmt(t.toneOnDb, 1)} dB with tone vs ${fmt(t.toneOffDb, 1)} dB without (${fmt(t.deltaDb, 1)} dB difference).`,
      t.simulated ? 'Input: simulated loopback (self-test).'
        : `Input: ${t.inputLabel || 'unknown'} | echoCancellation / NS / AGC: ${s.echoCancellation} / ${s.noiseSuppression} / ${s.autoGainControl}.`
    ];
    if (t.verdict === 'ok') {
      return {
        state: 'pass', title: 'OK',
        text: `The tone reaches the input, ${fmt(t.deltaDb, 1)} dB above the background. The loopback path works.`,
        hints: [...levels, 'If latency runs still fail, click "Download Capture" after a run and share the WAV.']
      };
    }
    if (t.verdict === 'silent_input') {
      return {
        state: 'fail', title: 'SILENT INPUT', text: 'The input delivers digital silence.',
        hints: [...levels, 'Pick the dongle as the input explicitly, and check that it is not muted.']
      };
    }
    return {
      state: 'fail', title: 'TONE NOT RECEIVED', text: 'The tone did not reach the input.',
      hints: [
        ...levels,
        'Did you hear the tone from a speaker or headphones? Then the output is not routed to the dongle: pick it as the Output explicitly.',
        'Did you hear nothing? Raise the media volume, and check that the dongle is fully seated.',
        'If the input level changes with the tone but this check still fails, voice processing may be removing it.'
      ]
    };
  }

  // "Check Input" button.
  async checkInput() {
    if (this.run || this.checking) return;
    this.checking = true;
    this.setButtonsRunning(true);
    try {
      this.setVerdict('idle', 'INPUT CHECK', `Playing a ${CHECK_TONE_HZ} Hz tone on and off. It should be audible only through the dongle path...`, []);
      const t = await this.measureTone(this.readConfig(), (text) => this.setProgress(`Input check: ${text}`));
      const v = this.toneVerdict(t);
      this.setVerdict(v.state, `INPUT CHECK — ${v.title}`, v.text, v.hints);
    } catch (err) {
      this.setVerdict('fail', 'INPUT CHECK — ERROR', errMsg(err), err.hints || []);
    } finally {
      this.checking = false;
      this.setButtonsRunning(false);
      this.setProgress('Idle — Ready');
    }
  }

  async setupAudio(run) {
    const cfg = run.cfg;
    const simulated = cfg.mode === 'simulated_dongle';
    run.trackSettings = null;

    if (!simulated) {
      run.micStream = await this.openMic(cfg);
      if (!this.isCurrent(run)) return;
      const track = run.micStream.getAudioTracks()[0];
      run.micTrack = track;
      run.trackSettings = track.getSettings ? track.getSettings() : {};
      run.inputLabel = track.label || null;
      track.addEventListener('ended', () => this.failRun(run, 'INPUT LOST',
        'The input track ended during the run (device unplugged or permission revoked).', []));
    }

    run.ctx = await this.openContext(cfg, run.trackSettings);
    // Samples `performance.now() - currentTime` to map the audio clock onto the
    // trace timeline (see `emitTraceMarks()`).
    run.clockSamples = [];
    run.clockTimer = setInterval(() => {
      if (run.ctx.state !== 'running') return;
      const ctxMs = run.ctx.currentTime * 1000;
      run.clockSamples.push([ctxMs, performance.now() - ctxMs]);
    }, CLOCK_SAMPLE_INTERVAL_MS);
    run.ctx.addEventListener('statechange', () => {
      if (run.ctx.state !== 'running') {
        this.failRun(run, 'AUDIO INTERRUPTED', `The AudioContext became "${run.ctx.state}" during the run.`, [
          'Keep the page in the foreground, and avoid calls or other apps taking audio focus.'
        ]);
      }
    });

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
    run.consensusWindowSamples = Math.round((cfg.consensusWindowMs / 1000) * fs);
    run.pilotFreq = Math.min(PILOT_MAX_HZ, PILOT_MAX_FRACTION_OF_FS * fs);

    const trackRate = run.trackSettings && run.trackSettings.sampleRate;
    if (trackRate && trackRate !== fs) {
      run.notes.push(`Mic track runs at ${trackRate} Hz but the AudioContext runs at ${fs} Hz; a resampler is part of the measured path.`);
    }
  }

  async launchPipeline(run, stimulus) {
    const { cfg, ctx, fs } = run;
    if (!this.isCurrent(run) || !ctx) return;
    run.stimulus = stimulus;

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
    if (run.micStream) {
      // Keep a reference so the source node cannot be garbage collected mid-run.
      run.micSource = ctx.createMediaStreamSource(run.micStream);
      run.micSource.connect(node);
    }

    if (cfg.mode === 'simulated_dongle' || cfg.mode === 'audio_element_stream') {
      // Keeps the worklet pulled by the hardware clock without audible output.
      const g = ctx.createGain();
      g.gain.value = 0;
      node.connect(g).connect(ctx.destination);
    } else {
      node.connect(ctx.destination);
    }
    if (cfg.mode === 'audio_element_stream') {
      const dest = ctx.createMediaStreamDestination();
      node.connect(dest);
      run.audioEl = new Audio();
      run.audioEl.srcObject = dest.stream;
      if (cfg.outputDeviceId && typeof run.audioEl.setSinkId === 'function') await run.audioEl.setSinkId(cfg.outputDeviceId);
      await run.audioEl.play();
    }
    if (!this.isCurrent(run)) return;

    node.port.postMessage({
      type: 'CONFIGURE', runId: run.id, stimulus,
      pilotEnabled: cfg.pilot, pilotFreq: run.pilotFreq,
      simMode: cfg.mode === 'simulated_dongle',
      simDelaySamples: Math.round(SIM_DELAY_SECONDS * fs),
      simGlitchBurst: cfg.simGlitch ? (cfg.burstCount > 1 ? 1 : 0) : -1
    });

    const buffers = [0, 1, 2].map(() => new Float32Array(run.captureLength));
    node.port.postMessage({ type: 'ADD_BUFFERS', buffers }, buffers.map((b) => b.buffer));

    const prerollSamples = Math.round(PREROLL_SECONDS * fs);
    node.port.postMessage({
      type: 'START_BURSTS', totalBursts: cfg.burstCount, intervalSamples: run.intervalSamples, prerollSamples
    });
    const runMs = ((prerollSamples + (cfg.burstCount - 1) * run.intervalSamples + run.captureLength) / fs) * 1000;
    this.armWatchdog(run, runMs + WATCHDOG_EXTRA_MS);
    this.setProgress(`Running burst 1 / ${cfg.burstCount}...`);
  }

  armWatchdog(run, ms, { status = 'measurement_error', reason = 'timeout' } = {}) {
    clearTimeout(run.watchdog);
    run.watchdog = setTimeout(() => {
      this.failRun(run, 'TIMEOUT', `No result after ${(ms / 1000).toFixed(1)} s.`, [
        'The audio device may have stopped delivering input, or the page was throttled in the background.',
        'Automated runs: launch Chrome with --use-fake-ui-for-media-stream so no permission prompt blocks the run.'
      ], { status, reason });
    }, ms);
  }

  stopTestRun() {
    const run = this.run;
    if (!run) return;
    this.setVerdict('idle', 'STOPPED', 'Measurement stopped by user.', []);
    this.cleanup(run);
  }

  // `status` is 'setup_error' or 'measurement_error'; `reason` defaults to the
  // badge in snake case (e.g. 'TIMEOUT' -> 'timeout').
  failRun(run, badge, text, hints, { status = 'measurement_error', reason = null } = {}) {
    if (!this.isCurrent(run)) return;
    this.setVerdict('fail', `FAIL — ${badge}`, text, hints);
    this.publishResult(run, 'FAIL', computeStats(run.trials), [{ severity: 'fail', badge, text }], text,
      { status, reason: reason || badge.toLowerCase().replace(/[^a-z0-9]+/g, '_') });
    this.cleanup(run);
  }

  cleanup(run) {
    // Detach first so that teardown events (track `ended`, context
    // `statechange`) are ignored by `isCurrent()`.
    const wasCurrent = this.isCurrent(run);
    if (wasCurrent && !run.result) {
      // Stopped by the user: still resolve `run.done` for API callers.
      this.publishResult(run, 'STOPPED', computeStats(run.trials), [], 'Stopped by user.',
        { status: 'measurement_error', reason: 'stopped' });
    }
    if (wasCurrent) this.run = null;
    clearTimeout(run.watchdog);
    clearInterval(run.clockTimer);
    if (run.node) {
      run.node.port.postMessage({ type: 'STOP' });
      run.node.port.onmessage = null;
      run.node.disconnect();
    }
    if (run.micSource) run.micSource.disconnect();
    if (run.audioEl) {
      run.audioEl.pause();
      run.audioEl.srcObject = null;
    }
    if (run.micStream) run.micStream.getTracks().forEach((t) => t.stop());
    if (run.ctx) run.ctx.close().catch(() => {});
    if (wasCurrent) {
      if (run.captures.some(Boolean)) {
        this.lastCapture = {
          fs: run.fs, captureLength: run.captureLength, stimulus: run.stimulus,
          captures: run.captures.filter(Boolean), average: run.average, startedAt: run.startedAt
        };
      }
      this.setButtonsRunning(false);
      this.setProgress('Idle — Ready');
    }
  }

  // -------------------------------------------------------------- messages --
  onWorkletMessage(run, msg) {
    if (!this.isCurrent(run) || msg.runId !== run.id) return;
    const { ctx, cfg } = run;
    switch (msg.type) {
      case 'BURST_CAPTURED': {
        if (typeof ctx.outputLatency === 'number' && ctx.outputLatency > 0) run.outLatSamples.push(ctx.outputLatency * 1000);
        run.tx[msg.burstIndex] = { txStartFrame: msg.txStartFrame, missingInputFrames: msg.missingInputFrames };
        run.missingInputFrames += msg.missingInputFrames;
        this.setProgress(`Analyzing burst ${msg.burstIndex + 1} / ${cfg.burstCount}...`);
        this.worker.postMessage({
          type: 'ANALYZE_BURST', runId: run.id, burstIndex: msg.burstIndex, rxBuffer: msg.rxBuffer
        }, [msg.rxBuffer.buffer]);
        break;
      }
      case 'RUN_COMPLETE':
        this.setProgress('Finalizing analysis...');
        break;
      case 'ERROR':
        this.failRun(run, 'WORKLET ERROR', msg.message, []);
        break;
    }
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
        case 'RUN_ANALYZED':
          this.onRunAnalyzed(run, msg);
          break;
      }
    } catch (err) {
      this.failRun(run, 'INTERNAL ERROR', errMsg(err), []);
    }
  }

  onBurstAnalyzed(run, msg) {
    // Provisional status; weak bursts are re-checked against the average in
    // `onRunAnalyzed()`.
    const detected = msg.psrDb >= DETECT_GATE_DB;
    const status = detected ? (msg.glitch ? 'glitch' : 'pass') : 'pending';
    const tx = run.tx[msg.burstIndex] || {};
    const trial = {
      burstIndex: msg.burstIndex, lagSamples: msg.lag, rtlMs: (msg.lag / run.fs) * 1000,
      psrDb: msg.psrDb, peakDbFs: msg.peakDbFs, noiseDbFs: msg.noiseDbFs, rxSnrDb: msg.rxSnrDb,
      silent: msg.silent, glitch: msg.glitch, glitchDelta: msg.glitchDelta,
      smallGlitchChecked: msg.smallGlitchChecked, status, valid: status === 'pass',
      method: 'direct', offConsensus: false,
      txStartFrame: tx.txStartFrame, missingInputFrames: tx.missingInputFrames || 0
    };
    run.trials.push(trial);
    this.appendTrialRow(trial);
    if (!run.opts.quiet) this.setPlot(run, msg.rxWaveform, msg.lag, msg, `Burst #${msg.burstIndex + 1} capture`);

    // Keep a copy for "Download Capture", then recycle the buffer to the worklet pool.
    run.captures[msg.burstIndex] = msg.rxWaveform.slice();
    if (run.node) run.node.port.postMessage({ type: 'ADD_BUFFERS', buffers: [msg.rxWaveform] }, [msg.rxWaveform.buffer]);
    this.updateSummary(run);

    if (run.trials.length >= run.cfg.burstCount) {
      this.setProgress(`Combining ${run.trials.length} bursts...`);
      this.worker.postMessage({ type: 'FINALIZE', runId: run.id, windowSamples: run.consensusWindowSamples });
    }
  }

  onRunAnalyzed(run, msg) {
    run.combined = msg.combined;
    run.average = msg.rxAverage;
    const byIndex = new Map(msg.decisions.map((d) => [d.burstIndex, d]));
    run.trials.forEach((t) => {
      const d = byIndex.get(t.burstIndex);
      if (!d) return;
      Object.assign(t, {
        lagSamples: d.lag, rtlMs: (d.lag / run.fs) * 1000, psrDb: d.psrDb, glitch: d.glitch,
        glitchDelta: d.glitchDelta, status: d.status, valid: d.valid, method: d.method, offConsensus: d.offConsensus
      });
    });
    this.els.trialBody.replaceChildren();
    run.trials.forEach((t) => this.appendTrialRow(t));
    if (msg.combined.count > 1 && !run.opts.quiet) {
      this.setPlot(run, msg.rxAverage, msg.combined.lag, msg.combined, `Average of ${msg.combined.count} captures`);
    }
    this.finishRun(run);
  }

  // ------------------------------------------------------------ reporting --
  // Explains why nothing was detected, from the input levels.
  diagnoseNoSignal(run) {
    const c = run.combined;
    const cfg = run.cfg;
    const trials = run.trials;
    const bestPsr = trials.length ? Math.max(...trials.map((t) => t.psrDb)) : null;
    const captured = trials.length * (run.captureLength || 0);
    let text = `No burst detected: best PSR ${fmt(bestPsr, 1)} dB`;
    if (c && c.count > 1) text += `, ${fmt(c.psrDb, 1)} dB after averaging ${c.count} bursts`;
    text += ` (gate ${DETECT_GATE_DB} dB; pure noise scores about 12–14 dB).`;
    const hints = [];
    if ((captured && run.missingInputFrames >= captured / 2) || trials.every((t) => t.silent)) {
      text += ' The input delivered only digital silence.';
      hints.push('Check that the input device is the dongle and that it is not muted (OS mixer, hardware switch).');
    } else if (!c || c.rxSnrDb < LOW_SNR_DB) {
      text += ` The stimulus is not audible at the input: the loudest part of the capture is only ${fmt(c ? c.rxSnrDb : null, 1)} dB above the noise floor (${fmt(median(trials.map((t) => t.noiseDbFs)), 1)} dBFS).`;
      hints.push('Check that both the input and the output are the dongle.');
      hints.push(`Raise the media volume${cfg.levelDb < -6 ? ', or set Stimulus Level to −6 dBFS' : ''}.`);
      hints.push(`If the round trip can exceed ${cfg.maxRtlMs} ms, raise Max Expected RTL (or use the Bluetooth profile).`);
    } else if (run.trackSettings && run.trackSettings.echoCancellation === true) {
      text += ' Sound reaches the input, but echoCancellation is active and removes the stimulus.';
      hints.push('Enable "Raw capture" in Advanced settings, or disable voice processing in the OS.');
    } else {
      text += ` Sound reaches the input (${fmt(c.rxSnrDb, 1)} dB above the noise floor) but does not match the stimulus.`;
      hints.push('Voice processing (echo cancellation or noise suppression applied by the OS), a lossy codec, or heavy distortion can cause this.');
      hints.push(`If the round trip can exceed ${cfg.maxRtlMs} ms, raise Max Expected RTL (or use the Bluetooth profile).`);
    }
    return { text, hints };
  }

  finishRun(run) {
    if (!this.isCurrent(run)) return;
    const cfg = run.cfg;
    const fs = run.fs;
    const trials = run.trials;
    const stats = computeStats(trials);
    const c = run.combined;
    const combinedOk = Boolean(c && c.psrDb >= DETECT_GATE_DB);
    run.latencyMs = stats.median !== null ? stats.median : (combinedOk ? (c.lag / fs) * 1000 : null);
    const issues = [];
    let hints = [];

    if (run.latencyMs === null) {
      const d = this.diagnoseNoSignal(run);
      issues.push({ severity: 'fail', badge: 'NO SIGNAL', text: d.text });
      hints = d.hints;
    } else {
      const weak = trials.filter((t) => t.status === 'weak').length;
      const missed = trials.filter((t) => t.status === 'not_detected').length;
      const glitched = trials.filter((t) => t.status === 'glitch');
      const moved = trials.filter((t) => t.offConsensus);
      const maxPeak = Math.max(...trials.map((t) => t.peakDbFs));
      const snr = c ? ` The burst is only ${fmt(c.rxSnrDb, 1)} dB above the input noise floor${c.count > 1 ? ' (averaged)' : ''}.` : '';
      if (stats.validCount === 0) {
        issues.push({ severity: 'warn', badge: 'LOW SIGNAL', text: `No single burst was strong enough; the latency comes from the average of ${c.count} bursts (PSR ${fmt(c.psrDb, 1)} dB). Per-burst jitter is unavailable.${snr} Raise the media volume or the stimulus level.` });
      } else if (weak || missed) {
        const parts = [];
        if (weak) parts.push(`${weak} burst(s) were only confirmed near the averaged lag (PSR ≥ ${CONFIRM_GATE_DB} dB within ±${cfg.consensusWindowMs} ms)`);
        if (missed) parts.push(`${missed} burst(s) were not detected`);
        issues.push({ severity: 'warn', badge: 'LOW SIGNAL', text: `${parts.join(' and ')}. Raise the media volume or the stimulus level for more reliable results.` });
      }
      if (glitched.length) issues.push({ severity: 'warn', badge: 'AUDIO GLITCH', text: `${glitched.length} burst(s) show a mid-burst dropout/insertion (${glitched.map((t) => `#${t.burstIndex + 1}: ${t.glitchDelta === null ? 'size unknown' : `${t.glitchDelta} samples`}`).join(', ')}); excluded from stats.` });
      if (moved.length) issues.push({ severity: 'warn', badge: 'LATENCY CHANGE', text: `${moved.length} burst(s) have a latency more than ${cfg.consensusWindowMs} ms away from the averaged lag (${fmt((c.lag / fs) * 1000)} ms): ${moved.map((t) => `#${t.burstIndex + 1}: ${fmt(t.rtlMs)} ms`).join(', ')}.` });
      if (stats.validCount > 1 && stats.stdDev > cfg.jitterGateMs) issues.push({ severity: 'warn', badge: 'HIGH JITTER', text: `Burst-to-burst spread ±${stats.stdDev.toFixed(3)} ms exceeds ±${cfg.jitterGateMs} ms (${stats.histogram.length} distinct lags).` });
      if (maxPeak > CLIP_DBFS) issues.push({ severity: 'warn', badge: 'INPUT CLIPPING', text: `Input peaked at ${maxPeak.toFixed(1)} dBFS; lower the media volume or output level.` });
      if (run.trackSettings && run.trackSettings.echoCancellation === true) issues.push({ severity: 'warn', badge: 'VOICE PROCESSING ACTIVE', text: 'Track reports echoCancellation: true; the voice-communication path adds latency and may distort the signal.' });
    }
    if (run.missingInputFrames > 0 && run.latencyMs !== null) {
      run.notes.push(`${run.missingInputFrames} captured frames had no input channel (the mic source was not delivering audio).`);
    }

    const fails = issues.filter((i) => i.severity === 'fail');
    const warns = issues.filter((i) => i.severity === 'warn');
    const ordered = [...fails, ...warns];
    const counts = `${stats.validCount}/${stats.total} bursts`;
    const details = stats.validCount > 1 ? `±${fmt(stats.stdDev, 3)} ms, ${counts}` : counts;
    let status = 'pass';
    let badge = 'PASS';
    let headline = `Round-trip latency: ${fmt(run.latencyMs)} ms (${details})`;
    if (ordered.length) {
      status = fails.length ? 'fail' : 'warn';
      badge = `${status.toUpperCase()} — ${ordered[0].badge}${ordered.length > 1 ? ` (+${ordered.length - 1} more)` : ''}`;
      if (fails.length) headline = 'Measurement failed';
      else headline = `Round-trip latency: ${fmt(run.latencyMs)} ms (${counts}), ${warns.length} issue(s) need attention`;
    }
    const bullets = ordered.map((i) => i.text).concat(hints, run.notes);
    if (!ordered.length) bullets.unshift(`All ${stats.total} bursts passed the ${DETECT_GATE_DB} dB PSR gate with no glitches.`);
    this.setVerdict(status, badge, headline, bullets);
    this.updateSummary(run);
    this.renderEnvironment(run);
    // Automation status: only report a latency backed by enough bursts.
    const detected = trials.filter((t) => DETECTED_STATUSES.has(t.status)).length;
    let outcome = { status: 'ok', reason: null };
    if (run.latencyMs === null) outcome = { status: 'measurement_error', reason: 'no_signal' };
    else if (detected < Math.ceil(cfg.burstCount * MIN_DETECTED_FRACTION)) outcome = { status: 'measurement_error', reason: 'too_few_bursts' };
    this.emitTraceMarks(run);
    this.publishResult(run, status.toUpperCase(), stats, issues, null, outcome);
    this.cleanup(run);
  }

  // Returns the `performance.now()` time at which audio-clock time `ctxMs` was
  // rendered, or null. `currentTime` advances once per audio callback, so the
  // smallest `performance.now() - currentTime` seen is the closest to the
  // render moment. Only nearby samples are used, because a hardware audio
  // clock can drift against `performance.now()`.
  audioToPerfMs(run, ctxMs) {
    let best = Infinity;
    for (const [t, offset] of run.clockSamples || []) {
      if (Math.abs(t - ctxMs) <= CLOCK_WINDOW_MS && offset < best) best = offset;
    }
    return Number.isFinite(best) ? best + ctxMs : null;
  }

  // Adds User Timing marks for each detected burst, so traces show when each
  // burst was rendered and received. Accurate to about one audio callback.
  emitTraceMarks(run) {
    run.traceMarks = 0;
    if (typeof performance.mark !== 'function') return;
    // Keep only the last run's entries in the page's performance timeline.
    for (const type of ['mark', 'measure']) {
      for (const e of performance.getEntriesByType(type)) {
        if (!e.name.startsWith(TRACE_PREFIX)) continue;
        if (type === 'mark') performance.clearMarks(e.name); else performance.clearMeasures(e.name);
      }
    }
    let first = null, last = null;
    for (const t of run.trials) {
      const tx = run.tx[t.burstIndex];
      if (!DETECTED_STATUSES.has(t.status) || !tx || !Number.isFinite(tx.txStartFrame)) continue;
      const emit = this.audioToPerfMs(run, (tx.txStartFrame / run.fs) * 1000);
      if (emit === null || emit < 0) continue;
      const receive = emit + t.rtlMs;
      t.emitTimeMs = emit;
      const name = `${TRACE_PREFIX}burst-${t.burstIndex + 1}`;
      const detail = { rtlMs: +t.rtlMs.toFixed(4), status: t.status, psrDb: +t.psrDb.toFixed(2) };
      try {
        performance.mark(`${name}:emit`, { startTime: emit, detail });
        performance.mark(`${name}:receive`, { startTime: receive, detail });
        performance.measure(`${name}:rtl`, { start: emit, end: receive, detail });
        run.traceMarks += 3;
      } catch (_) {
        // User Timing L3 (startTime/detail) unsupported: skip the marks.
        return;
      }
      if (first === null) first = emit;
      last = receive;
    }
    if (first !== null) {
      performance.measure(`${TRACE_PREFIX}run`, { start: first, end: last, detail: { rtlMs: run.latencyMs } });
      run.traceMarks += 1;
    }
  }

  // Publishes the result object (schema `RESULT_SCHEMA_VERSION`) to
  // `window.__e2eAudioTestResult` and the console, and resolves `run.done`.
  // `outcome.status` is 'ok', 'setup_error' or 'measurement_error'.
  publishResult(run, verdict, stats, issues, error, outcome) {
    const outLat = median(run.outLatSamples);
    const c = run.combined;
    const latency = run.latencyMs ?? null;
    const ok = outcome.status === 'ok';
    // `baseLatency` / `outputLatency` describe `AudioContext.destination`, which
    // is only the output path under test in `webaudio` mode.
    const reported = run.cfg.mode === 'webaudio' && (run.baseLatencyMs || outLat)
      ? (run.baseLatencyMs || 0) + (outLat || 0) : null;
    const detected = run.trials.filter((t) => DETECTED_STATUSES.has(t.status));
    const round = (v, d = 4) => (typeof v === 'number' && Number.isFinite(v) ? +v.toFixed(d) : null);
    const ts = run.trackSettings;
    const result = {
      schemaVersion: RESULT_SCHEMA_VERSION,
      status: outcome.status,
      reason: outcome.reason,
      message: error,
      metrics: ok ? {
        rtl_ms: round(latency),
        rtl_jitter_ms: stats.validCount > 1 ? round(stats.stdDev) : (stats.validCount === 1 ? 0 : null),
        glitch_count: run.trials.filter((t) => t.status === 'glitch').length,
        reported_latency_ms: round(reported),
        unreported_latency_ms: reported !== null ? round(latency - reported) : null,
        psr_db: round(median(detected.map((t) => t.psrDb)), 2),
        bursts_detected: detected.length
      } : null,
      environment: {
        pageVersion: pageVersion(),
        userAgent: navigator.userAgent,
        mode: run.cfg.mode,
        latencyHint: run.cfg.latencyHint,
        signal: run.cfg.signalType,
        sampleRate: run.fs || null,
        trackSampleRate: (ts && ts.sampleRate) || null,
        inputLabel: run.inputLabel || null,
        outputLabel: run.outputLabel || null,
        outputSelection: run.outputSelection || 'default',
        trackSettings: ts ? {
          echoCancellation: ts.echoCancellation, noiseSuppression: ts.noiseSuppression,
          autoGainControl: ts.autoGainControl, channelCount: ts.channelCount, latency: ts.latency
        } : null,
        baseLatencyMs: run.baseLatencyMs ?? null,
        outputLatencyMs: outLat
      },
      options: run.opts,
      preflight: run.preflight,
      trace: { marks: run.traceMarks || 0, clockSamples: (run.clockSamples || []).length },
      timestamp: new Date().toISOString(),
      startedAt: run.startedAt,
      verdict,
      error,
      latencyMs: latency,
      config: run.cfg,
      effective: {
        sampleRate: run.fs || null,
        trackSampleRate: (ts && ts.sampleRate) || null,
        intervalMs: run.fs ? (run.intervalSamples / run.fs) * 1000 : null,
        captureWindowMs: run.fs ? (run.captureLength / run.fs) * 1000 : null,
        stimulusLength: run.stimLength || null,
        pilotHz: run.cfg.pilot ? run.pilotFreq || null : null,
        detectGateDb: DETECT_GATE_DB,
        confirmGateDb: CONFIRM_GATE_DB
      },
      reportedLatency: {
        baseLatencyMs: run.baseLatencyMs ?? null,
        outputLatencyMs: outLat,
        rtlMinusReportedMs: (latency !== null && (run.baseLatencyMs || outLat)) ? latency - (run.baseLatencyMs || 0) - (outLat || 0) : null
      },
      stats,
      combined: c ? {
        bursts: c.count, lagSamples: +c.lag.toFixed(3), rtlMs: run.fs ? +((c.lag / run.fs) * 1000).toFixed(4) : null,
        psrDb: +c.psrDb.toFixed(2), rxSnrDb: +c.rxSnrDb.toFixed(2), noiseDbFs: +c.noiseDbFs.toFixed(2), glitch: c.glitch
      } : null,
      issues,
      notes: run.notes,
      trackSettings: ts,
      missingInputFrames: run.missingInputFrames,
      trials: run.trials.map((t) => ({
        burstIndex: t.burstIndex, rtlMs: +t.rtlMs.toFixed(4), lagSamples: +t.lagSamples.toFixed(3),
        psrDb: +t.psrDb.toFixed(2), peakDbFs: +t.peakDbFs.toFixed(2), noiseDbFs: +t.noiseDbFs.toFixed(2),
        rxSnrDb: +t.rxSnrDb.toFixed(2), status: t.status, method: t.method, valid: t.valid,
        glitch: t.glitch, glitchDeltaSamples: t.glitchDelta, smallGlitchChecked: t.smallGlitchChecked,
        offConsensus: t.offConsensus, emitTimeMs: round(t.emitTimeMs, 3)
      }))
    };
    run.result = result;
    window.__e2eAudioTestResult = result;
    console.log('E2E_AUDIO_RESULT:' + JSON.stringify(result));
    run.resolve(result);
  }

  updateSummary(run) {
    const stats = computeStats(run.trials);
    const cfg = run.cfg;
    const c = run.combined;
    const fs = run.fs || 48000;
    const setKpi = (el, value, unit) => {
      el.textContent = value;
      const u = document.createElement('span');
      u.className = 'kpi-unit';
      u.textContent = ` ${unit}`;
      el.append(u);
    };

    const latency = run.latencyMs ?? stats.median;
    if (latency === null || latency === undefined) {
      setKpi(this.els.kpiRtl, '—', 'ms');
      this.els.kpiRtlSub.textContent = `No valid bursts yet (${stats.total} analyzed)`;
    } else {
      setKpi(this.els.kpiRtl, latency.toFixed(2), 'ms');
      this.els.kpiRtlSub.textContent = stats.median !== null
        ? `${(stats.median / 1000 * fs).toFixed(1)} samples @ ${fs} Hz | ${stats.min.toFixed(2)}–${stats.max.toFixed(2)} ms`
        : `From the ${c ? c.count : ''}-burst average only`;
    }
    if (stats.validCount > 1) {
      setKpi(this.els.kpiJitter, `±${stats.stdDev.toFixed(3)}`, 'ms');
      this.els.kpiJitterSub.textContent = `Target ≤ ±${cfg.jitterGateMs} ms | ${stats.histogram.length} distinct lag(s)`;
    } else {
      setKpi(this.els.kpiJitter, '—', 'ms');
      this.els.kpiJitterSub.textContent = `Target ≤ ±${cfg.jitterGateMs} ms | needs 2+ valid bursts`;
    }
    const psrs = run.trials.map((t) => t.psrDb);
    setKpi(this.els.kpiPsr, psrs.length ? median(psrs).toFixed(1) : '—', 'dB');
    const detected = run.trials.filter((t) => t.valid).length;
    this.els.kpiPsrSub.textContent = `Median per burst | gate ${DETECT_GATE_DB} dB | ${detected}/${run.trials.length} valid`
      + (c && c.count > 1 ? ` | average: ${c.psrDb.toFixed(1)} dB` : '');
    const glitches = run.trials.filter((t) => t.glitch).length;
    setKpi(this.els.kpiGlitches, String(glitches), `/ ${run.trials.length}`);
    this.els.kpiGlitchesSub.textContent = glitches ? 'Mid-burst dropout/insertion detected'
      : (cfg.signalType === 'chirp' ? 'Split-peak check only (use MLS for small dropouts)' : 'No dropouts ≥ 2 samples detected');

    this.renderDecomposition(run, latency ?? null);
    const histText = stats.histogram.length
      ? stats.histogram.map((h) => `${h.lagSamples}×${h.count}`).join('  ')
      : 'n/a';
    const noise = median(run.trials.map((t) => t.noiseDbFs));
    const rows = [
      ['Distinct lags (samples × count)', histText],
      ['Input noise floor (median)', `${fmt(noise, 1)} dBFS`],
      ['Burst level above noise (median)', `${fmt(median(run.trials.map((t) => t.rxSnrDb)), 1)} dB`]
    ];
    if (c) {
      rows.push([`Average of ${c.count} burst(s)`, `${fmt((c.lag / fs) * 1000, 3)} ms, PSR ${fmt(c.psrDb, 1)} dB, ${fmt(c.rxSnrDb, 1)} dB above noise`]);
    }
    if (run.missingInputFrames) rows.push(['Frames with no input', String(run.missingInputFrames)]);
    renderRows(this.els.signalDetails, rows);
  }

  renderDecomposition(run, latency) {
    const { segBase, segOutput, segRest, legBase, legOutput, legRest, decompMeta, decompNote } = this.els;
    const applicable = run.cfg.mode === 'webaudio';
    decompMeta.textContent = `Measured RTL: ${fmt(latency)} ms`;
    if (!applicable || latency === null) {
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
    const rest = Math.max(0, latency - (base || 0) - (out || 0));
    const total = Math.max(latency, (base || 0) + (out || 0), 1e-6);
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
      ['Input device', run.inputLabel || (s ? 'unknown' : 'n/a (simulated)')],
      ['AudioContext rate / latencyHint', fs ? `${fs} Hz / ${run.cfg.latencyHint}` : 'n/a'],
      ['Mic track rate', s && s.sampleRate ? `${s.sampleRate} Hz` : (s ? 'not reported' : 'n/a (simulated)')],
      ['baseLatency / outputLatency', `${fmt(run.baseLatencyMs)} / ${fmt(median(run.outLatSamples))} ms`],
      ['echoCancellation / NS / AGC', s ? `${s.echoCancellation} / ${s.noiseSuppression} / ${s.autoGainControl}` : 'n/a'],
      ['Stimulus', `${run.cfg.signalType} (${run.stimLength || '?'} samples) @ ${run.cfg.levelDb} dBFS`],
      ['Capture window / interval', fs ? `${(run.captureLength / fs * 1000).toFixed(1)} / ${(run.intervalSamples / fs * 1000).toFixed(1)} ms` : 'n/a'],
      ['Detection gates (PSR)', `${DETECT_GATE_DB} dB whole window / ${CONFIRM_GATE_DB} dB within ±${run.cfg.consensusWindowMs} ms of the average`],
      ['Pilot tone', run.cfg.pilot && run.pilotFreq ? `${Math.round(run.pilotFreq)} Hz @ -55 dBFS` : 'disabled'],
      ['Output device', run.outputLabel || (run.cfg.mode === 'simulated_dongle' ? 'n/a (simulated)' : 'default')],
      ['Automation', 'window.e2eAudio.run() / window.__e2eAudioTestResult']
    ];
    renderRows(this.els.envList, rows);
  }

  resetResultsUi(cfg) {
    this.els.trialBody.replaceChildren();
    this.lastPlot = null;
    this.els.waveMeta.textContent = 'Last analyzed capture window';
    this.redrawPlots();
    this.updateSummary({ cfg, trials: [], outLatSamples: [], combined: null, missingInputFrames: 0 });
  }

  setButtonsRunning(running) {
    this.els.runBtn.disabled = running;
    this.els.checkBtn.disabled = running;
    // The input check is short and has no stop path.
    this.els.stopBtn.disabled = !running || Boolean(this.checking);
    this.els.downloadBtn.disabled = running || !this.lastCapture;
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

  appendTrialRow(t) {
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
    const PILLS = {
      pass: ['pill-pass', 'PASS'],
      weak: ['pill-pass', 'PASS (weak)'],
      pending: ['pill-warn', 'WEAK…'],
      glitch: ['pill-warn', t.glitchDelta === null ? 'GLITCH' : `GLITCH (${t.glitchDelta} smp)`],
      not_detected: ['pill-fail', 'NOT DETECTED']
    };
    const [cls, label] = PILLS[t.status] || PILLS.not_detected;
    const td = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = cls;
    pill.textContent = t.offConsensus ? `${label} (moved)` : label;
    td.append(pill);
    tr.append(td);
    this.els.trialBody.append(tr);
  }

  // ---------------------------------------------------------------- plots --
  setPlot(run, wave, onsetSample, r, title) {
    const fs = run.fs;
    const detected = r.psrDb >= DETECT_GATE_DB;
    this.els.waveMeta.textContent = title;
    this.lastPlot = {
      minmax: decimateMinMax(wave, 1200),
      onsetFrac: onsetSample / wave.length,
      onsetLabel: `${detected ? 'RTL' : 'best guess'} ${((onsetSample / fs) * 1000).toFixed(2)} ms`,
      envelope: r.envelope,
      peakFrac: r.maxLag > 0 ? r.lag / r.maxLag : 0,
      peakLabel: `PSR ${r.psrDb.toFixed(1)} dB`,
      gateNorm: Math.min(1, r.sideRmsNorm * Math.pow(10, DETECT_GATE_DB / 20))
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

  // One mono float WAV made of equal-length segments: the stimulus (zero
  // padded), then each burst capture, then the average of all captures.
  downloadCapture() {
    const c = this.lastCapture;
    if (!c) return;
    const segments = [c.stimulus, ...c.captures];
    if (c.average) segments.push(c.average);
    const len = c.captureLength;
    const out = new Float32Array(segments.length * len);
    segments.forEach((s, k) => { if (s) out.set(s.subarray(0, len), k * len); });
    const url = URL.createObjectURL(createFloatWavBlob(out, c.fs));
    const a = document.createElement('a');
    a.href = url;
    a.download = `e2e-audio-capture-${c.fs}Hz-${len}x${segments.length}-${Date.now()}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new E2EAudioLatencyApp();
  window.e2eApp = app;
  // Stable automation API. See `runAutomated()` and the README.
  window.e2eAudio = Object.freeze({
    schemaVersion: RESULT_SCHEMA_VERSION,
    pageVersion: pageVersion(),
    run: (config) => app.runAutomated(config)
  });
});
