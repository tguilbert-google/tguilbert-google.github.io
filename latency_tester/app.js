'use strict';

/**
 * E2E Audio Loopback Latency Analyzer.
 *
 * Measurement core: a single duplex `AudioWorkletProcessor` emits a band-limited
 * MLS burst on `outputs[0]` and records `inputs[0]` starting on the exact same
 * `currentFrame`. The FFT matched-filter peak lag in the recording is therefore
 * the round-trip latency in samples. Analysis runs in a Web Worker.
 *
 * Captures are buffered and only analyzed after the last burst, so no analysis
 * or drawing happens while audio is being measured.
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
 *  - `simulated_dongle`: synthetic 142.35 ms loopback, output muted.
 */

const API_MODES = ['webaudio', 'simulated_dongle'];
const LATENCY_HINTS = ['interactive', 'balanced', 'playback'];
const MODE_LABELS = {
  webaudio: 'Loopback dongle (WebAudio)',
  simulated_dongle: 'Self-test (simulated loopback)'
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

const STIM_LENGTH = 8191;              // MLS order 13.
const STIM_LEVEL_DB = -12;             // Stimulus peak level, dBFS.
const BURST_INTERVAL_MS = 757;         // Raised if the capture window needs more.
const PREROLL_SECONDS = 0.5;           // Pilot / sink / input warm-up before burst #1.
const INTERVAL_GUARD_SECONDS = 0.05;   // Minimum silence between capture windows.
const CAPTURE_MARGIN_SECONDS = 0.02;
const RESUME_TIMEOUT_MS = 3000;
const WATCHDOG_EXTRA_MS = 10000;
const ANALYSIS_TIMEOUT_MS = 30000;     // Analysis of all bursts, after the last one.
const PILOT_MAX_HZ = 19000;
const PILOT_MAX_FRACTION_OF_FS = 0.47; // Stimulus band tops out at 0.40 * fs.
const CLIP_DBFS = -0.3;
const SIM_DELAY_SECONDS = 0.14235;
const CHECK_TONE_HZ = 1000;            // Input check: pulsed tone frequency.
const CHECK_CYCLES = 2;                // Input check: 1 s off + 1 s on per cycle.
const CHECK_TONE_MIN_DELTA_DB = 10;    // Input check: tone-on vs tone-off at the input.
const CHECK_FLOOR_DB = -120;           // Input check: floor for silent readings.
const CHECK_SILENT_DB = -115;          // Input check: RMS at or below this is digital silence.
const MAX_BATCH_RUNS = 50;
const BATCH_GAP_MS = 1000;             // Pause between runs, so devices fully close and reopen.
const BATCH_MAX_CONSECUTIVE_FAILURES = 3;
const SESSION_STORAGE_KEY = 'e2eAudioLatencySession';
const SESSION_SCHEMA_VERSION = 1;
const AUTORUN_DELAY_MS = 2000;         // Lets device enumeration and UA hints settle.

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

// Taps verified maximal-length (period 2^13 - 1) for this shift-right,
// feed-into-MSB Fibonacci LFSR form.
const MLS_ORDER = 13;
const MLS_TAPS = [12, 2, 1, 0];

function generateMls() {
  const len = (1 << MLS_ORDER) - 1;
  const start = len;
  let reg = start;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = (reg & 1) ? 1 : -1;
    let fb = 0;
    for (const t of MLS_TAPS) fb ^= (reg >> t) & 1;
    reg = (reg >> 1) | (fb << (MLS_ORDER - 1));
    if (reg === start && i < len - 1) {
      throw new Error('MLS taps are not maximal-length (period ' + (i + 1) + ' < ' + len + ').');
    }
  }
  if (reg !== start) throw new Error('MLS register did not return to its initial state.');
  return out;
}

function generateStimulus(fs, levelDb) {
  const fLow = 500;
  const fHigh = Math.min(12000, 0.40 * fs);
  const raw = zeroPhaseBandpass(generateMls(), fs, fLow, fHigh);
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
  if (psrDb >= DETECT_GATE_DB + QUARTER_MIN_EXTRA_PSR_DB) quarter = quarterLagFit(rx, peak.idx);
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
      STIM = generateStimulus(msg.sampleRate, msg.levelDb);
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

// Linear interpolation between closest ranks; `p` in [0, 100].
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * (p / 100);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Summarizes run results (as saved by `saveReport()`).
function summarizeRuns(runs) {
  const lat = runs.map((r) => r.latencyMs).filter((v) => typeof v === 'number');
  return {
    count: runs.length,
    failed: runs.filter((r) => r.verdict === 'FAIL').length,
    glitches: runs.reduce((sum, r) => sum + (r.glitchCount || 0), 0),
    median: median(lat), p10: percentile(lat, 10), p90: percentile(lat, 90),
    min: lat.length ? Math.min(...lat) : null, max: lat.length ? Math.max(...lat) : null
  };
}

function describeSummary(s) {
  const parts = [`${s.count} run${s.count === 1 ? '' : 's'}${s.failed ? ` (${s.failed} failed)` : ''}`];
  if (s.median !== null) {
    parts.push(`median ${fmt(s.median)} ms`, `p10–p90 ${fmt(s.p10)}–${fmt(s.p90)}`, `range ${fmt(s.min)}–${fmt(s.max)}`);
  }
  parts.push(`${s.glitches} glitch${s.glitches === 1 ? '' : 'es'}`);
  return parts.join(' · ');
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
    this.lastResult = null;
    this.batch = null;
    this.device = { userAgent: navigator.userAgent };
    this.bindDom();
    this.initWorker();
    this.session = this.loadSession();
    this.renderSession();
    this.loadDeviceInfo();
    this.refreshDevices();
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => this.refreshDevices());
    }
    this.redrawPlots();
    this.applyUrlParams();
    document.addEventListener('visibilitychange', () => this.onVisibilityChange());
    window.addEventListener('resize', () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.redrawPlots(), 120);
    });
  }

  // The reduced user agent hides the phone model and OS version, so ask for
  // them through User-Agent Client Hints where available.
  async loadDeviceInfo() {
    if (!navigator.userAgentData || !navigator.userAgentData.getHighEntropyValues) return;
    try {
      const v = await navigator.userAgentData.getHighEntropyValues(['model', 'platform', 'platformVersion', 'fullVersionList']);
      const chrome = (v.fullVersionList || []).find((b) => /Chrome|Chromium/.test(b.brand));
      Object.assign(this.device, {
        model: v.model || null, platform: v.platform || null, platformVersion: v.platformVersion || null,
        browserVersion: chrome ? chrome.version : null
      });
    } catch (_) {
      // Keep the user agent only.
    }
  }

  // Lets a script on the device run unattended batches, e.g.
  // `?autorun=1&runs=10&bursts=10&label=as-is&token=abc`. The batch's runs are
  // downloaded as `e2e-audio-batch-<token>.json` when it ends. Autorun needs
  // `--autoplay-policy=no-user-gesture-required`, since nobody taps the page.
  applyUrlParams() {
    const params = new URLSearchParams(location.search);
    const selects = {
      runs: this.els.runCount, bursts: this.els.burstCount, mode: this.els.apiMode, hint: this.els.latencyHint
    };
    for (const [key, el] of Object.entries(selects)) {
      const v = params.get(key);
      if (v === null) continue;
      if (![...el.options].some((o) => o.value === v)) el.append(new Option(v, v));
      el.value = v;
    }
    if (params.has('label')) this.els.label.value = params.get('label');
    if (params.get('autorun') !== '1') return;
    this.autorunToken = (params.get('token') || String(Date.now())).replace(/[^A-Za-z0-9_-]/g, '_');
    setTimeout(() => {
      // A restored background tab must not start measuring.
      if (document.visibilityState === 'visible') this.startBatch();
    }, AUTORUN_DELAY_MS);
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
      exportJsonBtn: $('export-json-btn'), downloadBtn: $('download-capture-btn'),
      clearSessionBtn: $('clear-session-btn'),
      progressPill: $('progress-pill'),
      apiMode: $('cfg-api-mode'), burstCount: $('cfg-burst-count'), maxRtlMs: $('cfg-max-rtl'),
      latencyHint: $('cfg-latency-hint'), runCount: $('cfg-run-count'), label: $('cfg-label'),
      inputDevice: $('cfg-input-device'), outputDevice: $('cfg-output-device'),
      simGlitch: $('cfg-sim-glitch'),
      verdictBanner: $('verdict-banner'), verdictBadge: $('verdict-badge'),
      verdictHeadline: $('verdict-headline'), verdictDiagnostics: $('verdict-diagnostics'),
      kpiRtl: $('kpi-rtl-median'), kpiRtlSub: $('kpi-rtl-sub'),
      kpiJitter: $('kpi-jitter'), kpiJitterSub: $('kpi-jitter-sub'),
      kpiPsr: $('kpi-psr'), kpiPsrSub: $('kpi-psr-sub'),
      kpiGlitches: $('kpi-glitches'), kpiGlitchesSub: $('kpi-glitches-sub'),
      signalDetails: $('signal-details-list'), waveMeta: $('wave-meta'),
      waveCanvas: $('waveform-canvas'), corrCanvas: $('correlation-canvas'),
      trialBody: $('trial-table-body'), envList: $('env-metadata-list'),
      sessionList: $('session-list'), sessionMeta: $('session-meta')
    };

    this.els.runBtn.addEventListener('click', () => this.startBatch());
    this.els.stopBtn.addEventListener('click', () => this.stopTestRun());
    this.els.checkBtn.addEventListener('click', () => this.checkInput());
    this.els.exportJsonBtn.addEventListener('click', () => this.exportJsonReport());
    this.els.downloadBtn.addEventListener('click', () => this.downloadCapture());
    this.els.clearSessionBtn.addEventListener('click', () => this.clearSession());
  }

  // ---------------------------------------------------------------- config --
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
      burstCount: Math.round(num(this.els.burstCount, 5, 1, 50)),
      intervalMs: BURST_INTERVAL_MS,
      maxRtlMs,
      jitterGateMs,
      consensusWindowMs: Math.max(MIN_CONSENSUS_WINDOW_MS, 2 * jitterGateMs),
      levelDb: STIM_LEVEL_DB,
      latencyHint: pick(this.els.latencyHint, LATENCY_HINTS, 'interactive'),
      simGlitch: this.els.simGlitch.checked,
      inputDeviceId: this.els.inputDevice.value,
      outputDeviceId: this.els.outputDevice.value,
      outputLabel: this.els.outputDevice.selectedOptions.length ? this.els.outputDevice.selectedOptions[0].text : null,
      runCount: Math.round(num(this.els.runCount, 1, 1, MAX_BATCH_RUNS)),
      label: this.els.label.value.trim()
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

  // Resolves with the saved result once the run ends, or with null if it was
  // stopped (or could not start).
  async startTestRun() {
    if (this.run || this.checking) return null;
    const cfg = this.readConfig();
    const run = {
      id: ++this.runCounter, cfg, startedAt: new Date().toISOString(),
      trials: [], tx: [], pending: [], outLatSamples: [], notes: [], missingInputFrames: 0, combined: null,
      captures: [], average: null, result: null,
      batchId: this.batch ? this.batch.id : null, runInBatch: this.batch ? this.batch.index + 1 : null
    };
    run.done = new Promise((resolve) => { run.resolve = resolve; });
    this.run = run;
    this.resetResultsUi(cfg);
    this.setButtonsRunning(true);
    this.setVerdict('idle', 'RUNNING', `Starting ${MODE_LABELS[cfg.mode]}...`, []);
    this.setProgress('Starting...');

    try {
      await this.setupAudio(run);
      if (!this.isCurrent(run)) return;
      this.renderEnvironment(run);
      this.worker.postMessage({
        type: 'PREPARE_STIMULUS', runId: run.id, sampleRate: run.fs, levelDb: cfg.levelDb
      });
    } catch (err) {
      const hints = err.hints || ['No dongle attached? Pick "Self-test" as the loopback.'];
      this.failRun(run, 'SETUP ERROR', `Could not initialize audio: ${errMsg(err)}`, hints);
    }
    return run.done;
  }

  // Runs `runCount` measurements back to back, each with its own
  // `AudioContext` and input stream, so that their startup phase differs.
  async startBatch() {
    if (this.run || this.checking || this.batch) return;
    const cfg = this.readConfig();
    const batch = { id: new Date().toISOString(), total: cfg.runCount, index: 0, stopped: false, results: [], abortReason: null };
    this.batch = batch;
    this.setButtonsRunning(true);
    let consecutiveFailures = 0;
    try {
      await this.acquireWakeLock(batch);
      for (let i = 0; i < batch.total && !batch.stopped; i++) {
        batch.index = i;
        if (i > 0) {
          this.setProgress('Waiting before the next run...');
          await sleep(BATCH_GAP_MS);
          if (batch.stopped) break;
        }
        const result = await this.startTestRun();
        if (!result) break;
        batch.results.push(result);
        consecutiveFailures = result.verdict === 'FAIL' ? consecutiveFailures + 1 : 0;
        if (consecutiveFailures >= BATCH_MAX_CONSECUTIVE_FAILURES && i + 1 < batch.total) {
          batch.abortReason = `Stopped after ${consecutiveFailures} consecutive failed runs.`;
          break;
        }
      }
    } finally {
      this.releaseWakeLock();
      this.batch = null;
      this.setButtonsRunning(false);
      this.setProgress('Idle — Ready');
    }
    if (batch.total > 1) this.showBatchSummary(batch);
    if (this.autorunToken) {
      this.downloadJson({
        ...this.exportHeader(), token: this.autorunToken, batchId: batch.id, runsRequested: batch.total,
        stopped: batch.stopped, abortReason: batch.abortReason, runs: batch.results
      }, `e2e-audio-batch-${this.autorunToken}.json`);
      this.autorunToken = null;
    }
  }

  // A hidden page loses its input (Chrome denies `getUserMedia()`) and gets
  // its timers throttled, so keep the screen on for the whole batch.
  async acquireWakeLock(batch) {
    if (!navigator.wakeLock) {
      batch.wakeLockError = 'Screen Wake Lock API not available';
      return;
    }
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {
      batch.wakeLockError = errMsg(err);
    }
  }

  releaseWakeLock() {
    if (this.wakeLock) this.wakeLock.release().catch(() => {});
    this.wakeLock = null;
  }

  // Ends the batch right away if the page is hidden anyway (tab switch, power
  // button), instead of letting the next runs fail on the microphone.
  onVisibilityChange() {
    const batch = this.batch;
    if (document.visibilityState !== 'hidden' || !batch) return;
    batch.stopped = true;
    batch.abortReason = `The page went to the background after ${batch.results.length} of ${batch.total} runs; the run in progress was dropped. Keep the screen on and the tab visible.`;
    if (this.run) this.cleanup(this.run);
  }

  showBatchSummary(batch) {
    const s = summarizeRuns(batch.results);
    const bullets = [];
    if (batch.stopped && !batch.abortReason) bullets.push(`Stopped by user after ${s.count} of ${batch.total} runs.`);
    if (batch.abortReason) bullets.push(batch.abortReason);
    if (batch.wakeLockError) bullets.push(`Could not keep the screen on (${batch.wakeLockError}); a screen timeout will interrupt the batch.`);
    batch.results.forEach((r) => {
      if (r.verdict !== 'PASS') {
        const first = r.issues && r.issues[0];
        bullets.push(`Run ${r.runInBatch}: ${r.verdict}${first ? ` — ${first.badge}: ${first.text}` : ''}`);
      }
    });
    bullets.push('All completed runs are saved in the session. Use Export JSON to download them.');
    let state = 'pass';
    if (!s.count || s.failed === s.count) state = 'fail';
    else if (s.failed || s.glitches || batch.stopped || batch.abortReason) state = 'warn';
    const headline = s.median === null ? `${s.count} run(s), no latency measured`
      : `Median ${fmt(s.median)} ms over ${s.count - s.failed} run(s) · range ${fmt(s.min)}–${fmt(s.max)} ms · ${s.glitches} glitch(es)`;
    this.setVerdict(state, `BATCH — ${state.toUpperCase()}`, headline, bullets);
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
          'No dongle attached? Pick "Self-test" as the loopback.'
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

  // Opens the input with voice processing off, so the stimulus isn't removed.
  async openMic(cfg) {
    const audio = {
      echoCancellation: { ideal: false }, noiseSuppression: { ideal: false },
      autoGainControl: { ideal: false }, channelCount: { ideal: 1 }
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
  async openContext(cfg) {
    const ctx = new AudioContext({ latencyHint: cfg.latencyHint });
    try {
      if (cfg.outputDeviceId && typeof ctx.setSinkId === 'function') {
        try {
          await ctx.setSinkId(cfg.outputDeviceId);
        } catch (err) {
          this.refreshDevices();
          throw this.describeDeviceError(err, 'Output device', cfg);
        }
      }
      await withTimeout(ctx.resume(), RESUME_TIMEOUT_MS,
        'AudioContext did not start (autoplay policy). Click "Run Latency Test" again.');
      if (ctx.state !== 'running') throw new Error(`AudioContext state is "${ctx.state}".`);
      return ctx;
    } catch (err) {
      ctx.close().catch(() => {});
      throw err;
    }
  }

  // Plays a pulsed tone on the selected output and checks that it shows up on
  // the selected input. Independent of the latency analysis, so it separates
  // routing/level problems from analysis problems.
  async checkInput() {
    if (this.run || this.checking) return;
    this.checking = true;
    this.setButtonsRunning(true);
    const cfg = this.readConfig();
    const simulated = cfg.mode === 'simulated_dongle';
    let stream = null, ctx = null;
    try {
      this.setVerdict('idle', 'INPUT CHECK', `Playing a ${CHECK_TONE_HZ} Hz tone on and off. It should be audible only through the dongle path...`, []);
      let track = null, settings = {};
      if (!simulated) {
        stream = await this.openMic(cfg);
        track = stream.getAudioTracks()[0];
        settings = track.getSettings ? track.getSettings() : {};
      }
      ctx = await this.openContext(cfg);
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
        this.setProgress(`Input check: ${rms.toFixed(1)} dBFS RMS, ${CHECK_TONE_HZ} Hz at ${tone.toFixed(1)} dB`);
        if (bucket && ctx.currentTime > t0) {
          bucket.tone.push(tone);
          bucket.rms.push(rms);
        }
      }
      osc.stop();
      const toneOn = median(on.tone), toneOff = median(off.tone);
      const rmsOn = median(on.rms), rmsOff = median(off.rms);
      const delta = toneOn - toneOff;
      const levels = [
        `Input level with tone: ${fmt(rmsOn, 1)} dBFS RMS; without: ${fmt(rmsOff, 1)} dBFS RMS.`,
        `${CHECK_TONE_HZ} Hz at the input: ${fmt(toneOn, 1)} dB with tone vs ${fmt(toneOff, 1)} dB without (${fmt(delta, 1)} dB difference).`,
        track
          ? `Input: ${track.label || 'unknown'} | echoCancellation / NS / AGC: ${settings.echoCancellation} / ${settings.noiseSuppression} / ${settings.autoGainControl}.`
          : 'Input: simulated loopback (self-test).'
      ];
      if (delta >= CHECK_TONE_MIN_DELTA_DB) {
        this.setVerdict('pass', 'INPUT CHECK — OK', `The tone reaches the input, ${fmt(delta, 1)} dB above the background. The loopback path works.`, [
          ...levels,
          'If latency runs still fail, click "Download Capture" after a run and share the WAV.'
        ]);
      } else if (rmsOn !== null && rmsOn <= CHECK_SILENT_DB && rmsOff <= CHECK_SILENT_DB) {
        this.setVerdict('fail', 'INPUT CHECK — SILENT INPUT', 'The input delivers digital silence.', [
          ...levels,
          'Pick the dongle as the input explicitly, and check that it is not muted.'
        ]);
      } else {
        this.setVerdict('fail', 'INPUT CHECK — TONE NOT RECEIVED', 'The tone did not reach the input.', [
          ...levels,
          'Did you hear the tone from a speaker or headphones? Then the output is not routed to the dongle: pick it as the Output explicitly.',
          'Did you hear nothing? Raise the media volume, and check that the dongle is fully seated.',
          'If the input level changes with the tone but this check still fails, voice processing may be removing it.'
        ]);
      }
    } catch (err) {
      this.setVerdict('fail', 'INPUT CHECK — ERROR', errMsg(err), err.hints || []);
    } finally {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (ctx) ctx.close().catch(() => {});
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

    run.ctx = await this.openContext(cfg);
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
    run.stimLength = STIM_LENGTH;
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

    if (cfg.mode === 'simulated_dongle') {
      // Keeps the worklet pulled by the hardware clock without audible output.
      const g = ctx.createGain();
      g.gain.value = 0;
      node.connect(g).connect(ctx.destination);
    } else {
      node.connect(ctx.destination);
    }

    node.port.postMessage({
      type: 'CONFIGURE', runId: run.id, stimulus,
      pilotEnabled: true, pilotFreq: run.pilotFreq,
      simMode: cfg.mode === 'simulated_dongle',
      simDelaySamples: Math.round(SIM_DELAY_SECONDS * fs),
      simGlitchBurst: cfg.simGlitch ? (cfg.burstCount > 1 ? 1 : 0) : -1
    });

    // One buffer per burst: captures are only analyzed after the last burst,
    // so the analysis and UI updates can't compete with the audio threads.
    const buffers = Array.from({ length: cfg.burstCount }, () => new Float32Array(run.captureLength));
    node.port.postMessage({ type: 'ADD_BUFFERS', buffers }, buffers.map((b) => b.buffer));

    const prerollSamples = Math.round(PREROLL_SECONDS * fs);
    node.port.postMessage({
      type: 'START_BURSTS', totalBursts: cfg.burstCount, intervalSamples: run.intervalSamples, prerollSamples
    });
    const runMs = ((prerollSamples + (cfg.burstCount - 1) * run.intervalSamples + run.captureLength) / fs) * 1000;
    this.armWatchdog(run, runMs + WATCHDOG_EXTRA_MS);
    this.setProgress(`Capturing burst 1 / ${cfg.burstCount}...`);
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
    if (this.batch) this.batch.stopped = true;
    const run = this.run;
    if (!run) return;
    this.setVerdict('idle', 'STOPPED', 'Measurement stopped by user.', []);
    this.cleanup(run);
  }

  failRun(run, badge, text, hints) {
    if (!this.isCurrent(run)) return;
    this.setVerdict('fail', `FAIL — ${badge}`, text, hints);
    this.saveReport(run, 'FAIL', computeStats(run.trials), [{ severity: 'fail', badge, text }], text);
    this.cleanup(run);
  }

  cleanup(run) {
    // Detach first so that teardown events (track `ended`, context
    // `statechange`) are ignored by `isCurrent()`.
    const wasCurrent = this.isCurrent(run);
    if (wasCurrent) this.run = null;
    clearTimeout(run.watchdog);
    if (run.node) {
      run.node.port.postMessage({ type: 'STOP' });
      run.node.port.onmessage = null;
      run.node.disconnect();
    }
    if (run.micSource) run.micSource.disconnect();
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
      if (!this.batch) this.setProgress('Idle — Ready');
      run.resolve(run.result);
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
        run.pending[msg.burstIndex] = msg.rxBuffer;
        if (msg.burstIndex + 1 < cfg.burstCount) this.setProgress(`Capturing burst ${msg.burstIndex + 2} / ${cfg.burstCount}...`);
        break;
      }
      case 'RUN_COMPLETE':
        // All bursts are captured: analyze them now.
        this.armWatchdog(run, ANALYSIS_TIMEOUT_MS);
        this.setProgress(`Analyzing ${cfg.burstCount} bursts...`);
        run.pending.forEach((rxBuffer, burstIndex) => {
          this.worker.postMessage({ type: 'ANALYZE_BURST', runId: run.id, burstIndex, rxBuffer }, [rxBuffer.buffer]);
        });
        run.pending = [];
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
          this.launchPipeline(run, msg.stimulus).catch((err) => this.failRun(run, 'PIPELINE ERROR', errMsg(err), []));
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
    this.setPlot(run, msg.rxWaveform, msg.lag, msg, `Burst #${msg.burstIndex + 1} capture`);

    // Keep it for "Download Capture".
    run.captures[msg.burstIndex] = msg.rxWaveform;
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
    if (msg.combined.count > 1) {
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
      hints.push('Raise the media volume.');
      hints.push(`If the round trip can exceed ${cfg.maxRtlMs} ms, raise Max Expected RTL.`);
    } else if (run.trackSettings && run.trackSettings.echoCancellation === true) {
      text += ' Sound reaches the input, but echoCancellation is active and removes the stimulus.';
      hints.push('Disable voice processing in the OS; the page already asks for it to be off.');
    } else {
      text += ` Sound reaches the input (${fmt(c.rxSnrDb, 1)} dB above the noise floor) but does not match the stimulus.`;
      hints.push('Voice processing (echo cancellation or noise suppression applied by the OS), a lossy codec, or heavy distortion can cause this.');
      hints.push(`If the round trip can exceed ${cfg.maxRtlMs} ms, raise Max Expected RTL.`);
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
        issues.push({ severity: 'warn', badge: 'LOW SIGNAL', text: `No single burst was strong enough; the latency comes from the average of ${c.count} bursts (PSR ${fmt(c.psrDb, 1)} dB). Per-burst jitter is unavailable.${snr} Raise the media volume.` });
      } else if (weak || missed) {
        const parts = [];
        if (weak) parts.push(`${weak} burst(s) were only confirmed near the averaged lag (PSR ≥ ${CONFIRM_GATE_DB} dB within ±${cfg.consensusWindowMs} ms)`);
        if (missed) parts.push(`${missed} burst(s) were not detected`);
        issues.push({ severity: 'warn', badge: 'LOW SIGNAL', text: `${parts.join(' and ')}. Raise the media volume for more reliable results.` });
      }
      if (glitched.length) issues.push({ severity: 'warn', badge: 'AUDIO GLITCH', text: `${glitched.length} burst(s) show a mid-burst dropout/insertion (${glitched.map((t) => `#${t.burstIndex + 1}: ${t.glitchDelta === null ? 'size unknown' : `${t.glitchDelta} samples`}`).join(', ')}); excluded from stats.` });
      if (moved.length) issues.push({ severity: 'warn', badge: 'LATENCY CHANGE', text: `${moved.length} burst(s) have a latency more than ${cfg.consensusWindowMs} ms away from the averaged lag (${fmt((c.lag / fs) * 1000)} ms): ${moved.map((t) => `#${t.burstIndex + 1}: ${fmt(t.rtlMs)} ms`).join(', ')}.` });
      if (stats.validCount > 1 && stats.stdDev > cfg.jitterGateMs) issues.push({ severity: 'warn', badge: 'HIGH JITTER', text: `Burst-to-burst spread ±${stats.stdDev.toFixed(3)} ms exceeds ±${cfg.jitterGateMs} ms (${stats.histogram.length} distinct lags).` });
      if (maxPeak > CLIP_DBFS) issues.push({ severity: 'warn', badge: 'INPUT CLIPPING', text: `Input peaked at ${maxPeak.toFixed(1)} dBFS; lower the media volume.` });
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
    this.saveReport(run, status.toUpperCase(), stats, issues, null);
    this.cleanup(run);
  }

  // Keeps a summary of the run for "Export JSON".
  saveReport(run, verdict, stats, issues, error) {
    const c = run.combined;
    this.lastResult = {
      timestamp: new Date().toISOString(),
      verdict,
      error,
      latencyMs: run.latencyMs ?? null,
      jitterMs: stats.validCount > 1 ? stats.stdDev : null,
      glitchCount: run.trials.filter((t) => t.glitch).length,
      config: run.cfg,
      environment: {
        inputLabel: run.inputLabel || null,
        outputLabel: run.cfg.mode === 'simulated_dongle' ? null : run.cfg.outputLabel,
        sampleRate: run.fs || null,
        trackSettings: run.trackSettings,
        baseLatencyMs: run.baseLatencyMs ?? null,
        outputLatencyMs: median(run.outLatSamples)
      },
      stats,
      combined: c ? {
        bursts: c.count, lagSamples: +c.lag.toFixed(3), rtlMs: run.fs ? +((c.lag / run.fs) * 1000).toFixed(4) : null,
        psrDb: +c.psrDb.toFixed(2), rxSnrDb: +c.rxSnrDb.toFixed(2), noiseDbFs: +c.noiseDbFs.toFixed(2), glitch: c.glitch
      } : null,
      issues,
      notes: run.notes,
      trials: run.trials.map((t) => ({
        burstIndex: t.burstIndex, rtlMs: +t.rtlMs.toFixed(4), lagSamples: +t.lagSamples.toFixed(3),
        psrDb: +t.psrDb.toFixed(2), peakDbFs: +t.peakDbFs.toFixed(2), noiseDbFs: +t.noiseDbFs.toFixed(2),
        rxSnrDb: +t.rxSnrDb.toFixed(2), status: t.status, method: t.method,
        glitchDeltaSamples: t.glitchDelta, offConsensus: t.offConsensus
      }))
    };
    run.result = {
      ...this.lastResult, label: run.cfg.label, batchId: run.batchId, runInBatch: run.runInBatch,
      pageVersion: this.pageVersion()
    };
    this.session.runs.push(run.result);
    this.persistSession();
    this.renderSession();
  }

  // ------------------------------------------------------------- session --
  // Completed runs are kept in `localStorage`, so that results from several
  // batches (and page reloads) can be exported together.
  loadSession() {
    try {
      const saved = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY));
      if (saved && saved.schemaVersion === SESSION_SCHEMA_VERSION && Array.isArray(saved.runs)) return saved;
    } catch (_) {
      // Corrupt or unavailable storage: start a new session.
    }
    return { schemaVersion: SESSION_SCHEMA_VERSION, runs: [] };
  }

  persistSession() {
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(this.session));
      this.sessionPersistError = null;
    } catch (err) {
      // Quota exceeded or storage disabled: keep the session in memory only.
      this.sessionPersistError = errMsg(err);
    }
  }

  clearSession() {
    const n = this.session.runs.length;
    if (!n || !window.confirm(`Delete all ${n} saved run(s)? Export JSON first to keep them.`)) return;
    this.session = { schemaVersion: SESSION_SCHEMA_VERSION, runs: [] };
    this.persistSession();
    this.renderSession();
  }

  renderSession() {
    const runs = this.session.runs;
    const groups = new Map();
    runs.forEach((r) => {
      const cfg = r.config || {};
      let key = `${r.label || '(no label)'} · ${cfg.latencyHint}`;
      if (cfg.mode === 'simulated_dongle') key += ' · self-test';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });
    const rows = [...groups.entries()].map(([key, group]) => [key, describeSummary(summarizeRuns(group))]);
    if (!rows.length) rows.push(['No runs yet', 'Completed runs are saved here, grouped by label']);
    renderRows(this.els.sessionList, rows);
    let meta = `${runs.length} run(s) saved in this browser`;
    if (this.sessionPersistError) meta += ` (not persisted: ${this.sessionPersistError})`;
    this.els.sessionMeta.textContent = meta;
  }

  pageVersion() {
    const tag = document.querySelector('.version-tag');
    return tag ? tag.textContent.trim() : null;
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
      : 'No dropouts ≥ 2 samples detected';

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

  renderEnvironment(run) {
    const s = run.trackSettings;
    const fs = run.fs;
    const simulated = run.cfg.mode === 'simulated_dongle';
    const rows = [
      ['Loopback', MODE_LABELS[run.cfg.mode]],
      ['Input device', simulated ? 'n/a (simulated)' : (run.inputLabel || 'unknown')],
      ['Output device', simulated ? 'n/a (simulated)' : (run.cfg.outputLabel || 'unknown')],
      ['AudioContext rate / latencyHint', fs ? `${fs} Hz / ${run.cfg.latencyHint}` : 'n/a'],
      ['Mic track rate', s && s.sampleRate ? `${s.sampleRate} Hz` : (s ? 'not reported' : 'n/a (simulated)')],
      ['baseLatency / outputLatency', `${fmt(run.baseLatencyMs)} / ${fmt(median(run.outLatSamples))} ms`],
      ['echoCancellation / NS / AGC', s ? `${s.echoCancellation} / ${s.noiseSuppression} / ${s.autoGainControl}` : 'n/a']
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
    running = running || Boolean(this.batch);
    this.els.runBtn.disabled = running;
    this.els.checkBtn.disabled = running;
    // The input check is short and has no stop path.
    this.els.stopBtn.disabled = !running || Boolean(this.checking);
    this.els.downloadBtn.disabled = running || !this.lastCapture;
    this.els.clearSessionBtn.disabled = running;
  }

  setProgress(text) {
    const b = this.batch;
    this.els.progressPill.textContent = b && b.total > 1 ? `Run ${b.index + 1} / ${b.total} · ${text}` : text;
  }

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
  exportHeader() {
    return {
      schemaVersion: SESSION_SCHEMA_VERSION, exportedAt: new Date().toISOString(),
      pageVersion: this.pageVersion(), device: this.device
    };
  }

  downloadJson(payload, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Downloads every run saved in the session.
  exportJsonReport() {
    const header = this.exportHeader();
    const runs = this.session.runs;
    const stamp = header.exportedAt.replace(/[:.]/g, '-');
    this.downloadJson({ ...header, runs }, `e2e-audio-session-${runs.length}runs-${stamp}.json`);
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
  window.e2eApp = new E2EAudioLatencyApp();
});
