# E2E Audio Loopback Latency Analyzer

A static page (plain HTML, CSS, and JS, with no build step and no external requests) that measures round-trip audio latency through a physical loopback. That means a TRRS or USB-C loopback dongle, or an output jack wired to an input.

## How it works

- A single duplex `AudioWorkletProcessor` plays a band-limited MLS burst (or a log chirp). On the same `currentFrame`, it starts recording its input. Because the recording starts exactly when the burst starts, the matched-filter peak lag in the recording is the round-trip latency in samples.
- FFT cross-correlation runs in a Web Worker. Parabolic interpolation refines the peak to a fraction of a sample (about 0.03-sample error in simulation).
- Confidence is the peak-to-sidelobe ratio (PSR) of the correlation. Pure noise scores about 12–14 dB. A clean wired loopback scores 30–45 dB.
- Detection has two stages, so weak loopback signals still give a result:
  1. Each burst is searched over the whole capture window. A peak of at least **18 dB** counts on its own.
  2. After the last burst, all captures are averaged. They are sample-aligned to their burst start, so averaging N bursts adds 10·log10(N) dB of SNR. If the average clears 18 dB, weaker bursts are searched again within ±1 ms of the averaged lag (±10 ms for high-latency outputs). Such a burst is kept at **14 dB** or more and shows as "PASS (weak)". The search window is 100–250 times narrower, so this gate has a similar false-alarm rate.
  - If no single burst passes but the average does, the average gives the latency, with a "LOW SIGNAL" warning.
- When nothing is detected, the page reports the input levels to explain why: digital silence, a burst that doesn't rise above the noise floor (wrong device or volume too low), or a signal that arrives but doesn't match the stimulus (voice processing, codec, distortion).
- Glitch detection (splices, dropouts, and inserted samples inside a burst):
  - **Split peak:** a second correlation peak within 9.5 dB of the main one, which would pass the 18 dB gate on its own.
  - **Quarter check (MLS only, PSR ≥ 30 dB):** each quarter of the stimulus is correlated on its own.
    - A step between the quarter lags means a dropout or insertion. This catches dropouts as small as 2 samples. A linear slope is treated as clock drift and ignored.
    - A quarter with poor normalized correlation also counts as a glitch. This catches dropouts larger than 48 samples.
  - Chirp stimuli use the split-peak check only.
- A burst whose latency is more than the search window away from the averaged lag is flagged "LATENCY CHANGE".

## Modes

| `mode` | What's measured |
| --- | --- |
| `webaudio` (default) | Worklet → `AudioContext.destination` → dongle → `getUserMedia` → `MediaStreamAudioSourceNode` → worklet. |
| `audio_element_stream` | The worklet output goes through a `MediaStreamAudioDestinationNode` into `<audio>.srcObject`, which is routed to the chosen sink. |
| `simulated_dongle` | A synthetic loopback of about 142.35 ms with the output muted. Use it as a self-test and demo. |

## Profiles

Most users only need to pick a profile, plus the input and output devices. Everything else is under "Advanced settings".

| `profile` | Use for | Changes from the defaults |
| --- | --- | --- |
| `standard` (default) | Wired loopback dongle (USB-C or 3.5 mm) | none |
| `quick` | Checking the setup and levels | 1 burst |
| `stability` | Catching glitches and latency changes | 20 bursts |
| `bluetooth` | Wireless or high-latency outputs | max RTL 2000 ms |
| `selftest` | No hardware; checks the page itself | `mode=simulated_dongle` |

Changing any advanced setting switches the profile to "Custom", unless the new values match another profile.

The jitter gate is ±0.5 ms. It widens to ±5 ms when max RTL is above 500 ms, because wireless outputs jitter more.

## URL parameters

`profile`, then any of: `mode`, `signal` (`mls13`, `mls12`, `chirp`), `bursts` (1, 5, 10, 20), `intervalMs`, `maxRtlMs` (300, 500, 1000, 2000), `levelDb` (-20, -12, -6, -2), `latencyHint`, `rawAudio`, `pilot`, `matchRate`, `simGlitch`, and `autorun=true`. Individual parameters override the profile.

"Copy Config Link" writes the profile (e.g. `?profile=bluetooth`). For custom settings, it writes only the settings that differ from `standard` (e.g. `?bursts=10&maxRtlMs=2000`).

## Debugging a failing setup

**Check Input** plays a 1 kHz tone at the configured level, gated 1 s off / 1 s on for two cycles, on the selected output. It measures the 1 kHz level at the selected input with and without the tone. It passes if the tone is at least 10 dB above the background. Otherwise it reports "SILENT INPUT" (the input delivers digital zeros) or "TONE NOT RECEIVED". If you hear the tone from a speaker, the output isn't routed to the dongle. With the self-test profile, the tone is looped back internally, so no hardware is needed.

**Download Capture** saves the raw recordings of the last run as a mono 32-bit float WAV at the context's sample rate. The file is a sequence of equal-length segments, each `captureLength` samples long (see the file name, `e2e-audio-capture-<fs>Hz-<captureLength>x<segments>-<time>.wav`):

1. The stimulus, zero-padded.
2. One segment per burst, starting at the sample where that burst was emitted.
3. The average of all burst captures.

## Automation

Bots and humans share the same page and measurement code. Chrome needs `--autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream`.

### API

```js
const result = await window.e2eAudio.run({
  profile: 'interactive', bursts: '20',   // Any URL parameter, as a string.
  input: 'e2e_loopback_in', output: 'USB', // Case-insensitive label regexes.
  preflight: true,                         // Tone check first (default).
  quiet: true,                             // Skip plot rendering.
});
```

`run()` returns a Promise that always resolves with a result (it never rejects). Unknown keys or invalid values give `setup_error` / `invalid_config`. `window.e2eAudio` also exposes `schemaVersion` and `pageVersion`.

`input` / `output` pick devices by label. If nothing matches, the run fails with `no_input_match` or `no_output_match`, and the message lists the available labels. Output selection is skipped where `setSinkId()` isn't supported (`environment.outputSelection` is then `unsupported`).

`?autorun=true` does the same from the URL, and also accepts `input`, `output`, `preflight=false` and `quiet=true`.

### Result (schema v1)

When a run finishes, the page sets `window.__e2eAudioTestResult` and logs a single line, `E2E_AUDIO_RESULT:<json>`. The main fields are:

- `schemaVersion` (1), `status`, `reason` and `message`.
- `status`:
  - `ok`: `metrics` is set.
  - `setup_error`: the setup is broken, so there's nothing to compare. Reasons include `invalid_config`, `busy`, `no_input_match`, `no_output_match`, `permission_denied`, `input_busy`, `autoplay_blocked`, `setup_timeout`, `preflight_silent_input` and `preflight_tone_not_received`.
  - `measurement_error`: the setup worked but the run didn't. Reasons include `no_signal`, `too_few_bursts` (fewer than 50% of bursts detected), `stopped` and `timeout`.
- `metrics` (null unless `ok`): `rtl_ms`, `rtl_jitter_ms`, `glitch_count`, `reported_latency_ms` and `unreported_latency_ms` (both only in `webaudio` mode), plus the health values `psr_db` and `bursts_detected`. Glitches are counted, never fatal.
- `environment`: page version, user agent, mode, sample rates, device labels, track settings, `baseLatency` and `outputLatency`.
- `preflight`: the tone check levels.
- The older fields are unchanged: `verdict`, `latencyMs`, `issues[]`, `stats`, `combined`, `trials` (per burst, now with `emitTimeMs`), `effective` and `reportedLatency`.

### Trace marks

After a run, the page adds User Timing entries for each detected burst: `e2e-audio:burst-N:emit` and `e2e-audio:burst-N:receive` marks, an `e2e-audio:burst-N:rtl` measure, and an `e2e-audio:run` measure. They appear in the `blink.user_timing` trace category. The emit time maps the audio clock onto `performance.now()` and is accurate to about one audio callback. `blink.user_timing,audio,webaudio` is a lightweight Perfetto config that shows the marks next to the audio render callbacks.

### Smoke test

[`automation/smoke_test.py`](automation/smoke_test.py) drives Chrome over CDP and checks the API, the self-test numbers, the trace marks and a simulated glitch. With `--loopback=pulse`, it creates a PulseAudio null sink and remapped source, runs the three real stories, and removes them afterwards.

```sh
python3 latency_tester/automation/smoke_test.py --file                   # No hardware.
python3 latency_tester/automation/smoke_test.py --file --loopback=pulse  # Linux virtual loopback.
```

Note: the loopback needs a PulseAudio server that can capture. Under Chrome Remote Desktop, `PULSE_RUNTIME_PATH` may point at a private PipeWire instance that records silence. Use `PULSE_RUNTIME_PATH=/run/user/$(id -u)/pulse` instead.

### Frozen versions

`v4/` is a frozen copy of the page for bots, so that page changes don't show up as regressions. Pin it, and only move to a newer frozen copy on purpose. The top-level page keeps changing.

## Tips and limitations

- Set media volume to about 80% and disable the OS's audio effects if you can. The page asks for `echoCancellation`, `noiseSuppression`, and `autoGainControl` to be off, then checks what `getSettings()` reports.
- If you get "LOW SIGNAL", raise the media volume, set the stimulus level to −6 dBFS, or run more bursts.
- Averaging assumes the latency stays constant across bursts. If the input and output are on different clocks (for example, speakers and a USB mic), the lag can drift by a few samples per burst. That still works for strong signals, but it weakens the average for weak ones.
- Pilot tone: a -55 dBFS tone keeps USB-C DACs from sleeping between bursts. Its frequency is `min(19 kHz, 0.47·fs)`, so it stays below Nyquist.
- The "Reported vs. unreported" bar shows only the latencies the browser reports (`baseLatency` and `outputLatency`). Everything else is lumped together, including the whole capture path.
