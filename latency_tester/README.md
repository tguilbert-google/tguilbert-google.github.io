# E2E Audio Loopback Latency Analyzer

A static page (plain HTML, CSS, and JS, with no build step and no external requests) that measures round-trip audio latency through a physical loopback. That means a TRRS or USB-C loopback dongle, or an output jack wired to an input.

## How it works

- A single duplex `AudioWorkletProcessor` plays a band-limited MLS burst (or a log chirp). On the same `currentFrame`, it starts recording its input. Because the recording starts exactly when the burst starts, the matched-filter peak lag in the recording is the round-trip latency in samples.
- FFT cross-correlation runs in a Web Worker. Parabolic interpolation refines the peak to a fraction of a sample (about 0.03-sample error in simulation).
- A burst is valid only if its peak-to-sidelobe ratio (PSR) is at least the gate (default 18 dB) and no glitch is detected.
- Glitch detection (splices, dropouts, and inserted samples inside a burst):
  - **Split peak:** a second correlation peak within 9.5 dB of the main one.
  - **Quarter check (MLS only):** each quarter of the stimulus is correlated on its own.
    - A step between the quarter lags means a dropout or insertion. This catches dropouts as small as 2 samples. A linear slope is treated as clock drift and ignored.
    - A quarter with poor normalized correlation also counts as a glitch. This catches dropouts larger than 48 samples.
  - Chirp stimuli use the split-peak check only.

## Modes

| `mode` | What's measured |
| --- | --- |
| `webaudio` (default) | Worklet → `AudioContext.destination` → dongle → `getUserMedia` → `MediaStreamAudioSourceNode` → worklet. |
| `audio_element_stream` | The worklet output goes through a `MediaStreamAudioDestinationNode` into `<audio>.srcObject`, which is routed to the chosen sink. |
| `audio_element_wav` (experimental) | A single WAV burst train played by `<audio src=blob:>` while the worklet records continuously. Reports latency referenced to `play()` (this includes element startup) and how far the burst spacing deviates in steady state. |
| `webcodecs_rx` (experimental) | Runs the `webaudio` measurement plus a parallel `MediaStreamTrackProcessor` capture. Its PCM is correlated separately to check integrity and spacing, and its `AudioData.timestamp` values are compared against the capture. |
| `simulated_dongle` | A synthetic loopback of about 142.35 ms with the output muted. Use it as a self-test and demo. |

## Profiles

Most users only need to pick a profile, plus the input and output devices. Everything else is under "Advanced settings".

| `profile` | Use for | Changes from the defaults |
| --- | --- | --- |
| `standard` (default) | Wired loopback dongle (USB-C or 3.5 mm) | none |
| `quick` | Checking the setup and levels | 1 burst |
| `stability` | Catching glitches and latency changes | 20 bursts |
| `bluetooth` | Wireless or high-latency outputs | max RTL 2000 ms, jitter gate ±5 ms |
| `selftest` | No hardware; checks the page itself | `mode=simulated_dongle` |

Changing any advanced setting switches the profile to "Custom", unless the new values match another profile.

## URL parameters

`profile`, then any of: `mode`, `signal` (`mls13`, `mls12`, `chirp`), `bursts` (1, 5, 10, 20), `intervalMs`, `maxRtlMs` (300, 500, 1000, 2000), `levelDb` (-20, -12, -6, -2), `latencyHint`, `minPsrDb`, `maxStdDevMs`, `rawAudio`, `pilot`, `matchRate`, `simGlitch`, and `autorun=true`. Individual parameters override the profile.

"Copy Config Link" writes the profile (e.g. `?profile=bluetooth`). For custom settings, it writes only the settings that differ from `standard` (e.g. `?bursts=10&maxRtlMs=2000`).

## Automation

```sh
chrome --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream \
  'https://<host>/latency_tester/?mode=webaudio&bursts=10&autorun=true'
```

When a run finishes, the page sets `window.__e2eAudioTestResult` and logs a single line, `E2E_AUDIO_RESULT:<json>`. The JSON contains `verdict` (`PASS`, `WARN`, or `FAIL`), `issues[]`, `stats`, the per-burst `trials`, `effective` (the parameters actually used), and `reportedLatency`.

## Tips and limitations

- Set media volume to about 80% and disable the OS's audio effects if you can. The page asks for `echoCancellation`, `noiseSuppression`, and `autoGainControl` to be off, then checks what `getSettings()` reports.
- Pilot tone: a -55 dBFS tone keeps USB-C DACs from sleeping between bursts. Its frequency is `min(19 kHz, 0.47·fs)`, so it stays below Nyquist.
- The "Reported vs. unreported" bar shows only the latencies the browser reports (`baseLatency` and `outputLatency`). Everything else is lumped together, including the whole capture path.
- In WAV mode, the latency includes the `<audio>` element's startup time. It is not a steady-state output latency.
