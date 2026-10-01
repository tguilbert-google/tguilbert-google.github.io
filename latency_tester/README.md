# E2E Audio Loopback Latency Analyzer

A static page (plain HTML, CSS, and JS, with no build step and no external requests) that measures round-trip audio latency and detects glitches through a physical loopback. That means a TRRS or USB-C loopback dongle, or an output jack wired to an input.

## Usage

1. Plug in the loopback dongle and set the media volume to about 80%.
2. Pick the dongle as both the Input and the Output.
3. Click **Run Latency Test**.

Settings:

- **Loopback:** the dongle, or "Self-test", which simulates a 142.35 ms loopback with the output muted. Use the self-test to check the page itself without any hardware.
- **Number of Bursts:** more bursts give a better jitter estimate and catch more glitches.
- **Max Expected RTL:** the capture window. Use 2000 ms for Bluetooth and other wireless outputs.
- **AudioContext latencyHint:** the `latencyHint` passed to the `AudioContext`.

The stimulus is fixed: a band-limited MLS of order 13 (8191 samples) at −12 dBFS, one burst every 757 ms. The interval grows if the capture window needs more room. Capture always asks for `echoCancellation`, `noiseSuppression` and `autoGainControl` to be off. A −55 dBFS pilot tone at `min(19 kHz, 0.47·fs)` keeps USB-C DACs from sleeping between bursts.

## How it works

- A single duplex `AudioWorkletProcessor` plays the burst. On the same `currentFrame`, it starts recording its input. Because the recording starts exactly when the burst starts, the matched-filter peak lag in the recording is the round-trip latency in samples. The measured path is worklet → `AudioContext.destination` → dongle → `getUserMedia` → `MediaStreamAudioSourceNode` → worklet.
- Captures are buffered and only analyzed after the last burst. While audio is being measured, the page does no analysis and no drawing, so it can't compete with the audio threads and cause the glitches it reports.
- FFT cross-correlation runs in a Web Worker. Parabolic interpolation refines the peak to a fraction of a sample (about 0.03-sample error in simulation).
- Confidence is the peak-to-sidelobe ratio (PSR) of the correlation. Pure noise scores about 12–14 dB. A clean wired loopback scores 30–45 dB.
- Detection has two stages, so weak loopback signals still give a result:
  1. Each burst is searched over the whole capture window. A peak of at least **18 dB** counts on its own.
  2. After the last burst, all captures are averaged. They are sample-aligned to their burst start, so averaging N bursts adds 10·log10(N) dB of SNR. If the average clears 18 dB, weaker bursts are searched again within ±1 ms of the averaged lag (±10 ms for high-latency outputs). Such a burst is kept at **14 dB** or more and shows as "PASS (weak)". The search window is 100–250 times narrower, so this gate has a similar false-alarm rate.
  - If no single burst passes but the average does, the average gives the latency, with a "LOW SIGNAL" warning.
- When nothing is detected, the page reports the input levels to explain why: digital silence, a burst that doesn't rise above the noise floor (wrong device or volume too low), or a signal that arrives but doesn't match the stimulus (voice processing, codec, distortion).
- Glitch detection (splices, dropouts, and inserted samples inside a burst):
  - **Split peak:** a second correlation peak within 9.5 dB of the main one, which would pass the 18 dB gate on its own.
  - **Quarter check (PSR ≥ 30 dB):** each quarter of the stimulus is correlated on its own.
    - A step between the quarter lags means a dropout or insertion. This catches dropouts as small as 2 samples. A linear slope is treated as clock drift and ignored.
    - A quarter with poor normalized correlation also counts as a glitch. This catches dropouts larger than 48 samples.
- A burst whose latency is more than the search window away from the averaged lag is flagged "LATENCY CHANGE".
- The jitter gate is ±0.5 ms. It widens to ±5 ms when max RTL is above 500 ms, because wireless outputs jitter more.

## Debugging a failing setup

**Check Input** plays a 1 kHz tone at −12 dBFS, gated 1 s off / 1 s on for two cycles, on the selected output. It measures the 1 kHz level at the selected input with and without the tone. It passes if the tone is at least 10 dB above the background. Otherwise it reports "SILENT INPUT" (the input delivers digital zeros) or "TONE NOT RECEIVED". If you hear the tone from a speaker, the output isn't routed to the dongle. In self-test mode, the tone is looped back internally, so no hardware is needed.

**Download Capture** saves the raw recordings of the last run as a mono 32-bit float WAV at the context's sample rate. The file is a sequence of equal-length segments, each `captureLength` samples long (see the file name, `e2e-audio-capture-<fs>Hz-<captureLength>x<segments>-<time>.wav`):

1. The stimulus, zero-padded.
2. One segment per burst, starting at the sample where that burst was emitted.
3. The average of all burst captures.

**Export JSON** saves the last result: verdict, `latencyMs`, `jitterMs`, `glitchCount`, the devices and reported latencies, and per-burst results.

## Tips and limitations

- If you get "LOW SIGNAL", raise the media volume or run more bursts.
- Glitches are only detected inside bursts. Each burst is about 170 ms of every 757 ms interval, so roughly 22% of the time is checked.
- Averaging assumes the latency stays constant across bursts. If the input and output are on different clocks (for example, speakers and a USB mic), the lag can drift by a few samples per burst. That still works for strong signals, but it weakens the average for weak ones.
