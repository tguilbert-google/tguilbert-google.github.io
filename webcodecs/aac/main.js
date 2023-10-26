let processor;
let generator;
let encoder;
let decoder;

let audioElement;

function disable(id) {
  document.querySelector(id).disabled = true;
}

function show(id) {
  document.querySelector(id).style.visibility = 'visible';
}

function hide(id) {
  document.querySelector(id).style.visibility = 'hidden';
}

function make_audio_data(timestamp, channels, sampleRate, frames) {
  let data = new Float32Array(frames*channels);

  // This generates samples in a planar format.
  for (var channel = 0; channel < channels; channel++) {
    let hz = 440; // sound frequency
    let gain = 0.3
    let base_index = channel * frames;
    for (var i = 0; i < frames; i++) {
      let t = (i / sampleRate) * hz * (Math.PI * 2);
      data[base_index + i] = Math.sin(t) * gain;
    }
  }

  return new AudioData({
    timestamp: timestamp,
    data: data,
    numberOfChannels: channels,
    numberOfFrames: frames,
    sampleRate: sampleRate,
    format: "f32-planar",
  });
}

async function run(aac_format){
  audioElement = document.querySelector("#audioTarget");

  disable("#aacBtn");
  disable("#adtsBtn");

  await SetUpWebCodecs(aac_format);
}

async function SetUpWebCodecs(aac_format) {
  generator = new MediaStreamTrackGenerator('audio');
  const writer = generator.writable.getWriter();
  
  let stream = new MediaStream([generator]);

  audioElement.srcObject = stream;
  audioElement.play();

  let decode_output_count = 0;

  let decoder_init = {
    error: () => console.log("Decode error"),
    output: data => {
      console.log("Wrote data #" + (decode_output_count++));
      writer.write(data);
    }
  };
  decoder = new AudioDecoder(decoder_init);

  encoder = new AudioEncoder({
    error: e => console.log("Encode error"),
    output: (chunk, metadata) => {
      let config = metadata.decoderConfig;
      if (config)
        decoder.configure(config);
      decoder.decode(chunk);
    }
  });

  let config = {
    codec: 'mp4a.40.2',
    sampleRate: 44100,
    numberOfChannels: 2,
    bitrate: 192000,
    aac : {
      format : aac_format
    },
  };

  encoder.configure(config);

  let timestamp_us = 0;
  let total_duration_s = 5;
  let data_count = 50;
  let data_duration_s = total_duration_s / data_count;
  let data_length = data_duration_s * config.sampleRate;
  for (let i = 0; i < data_count; i++) {
    let data = make_audio_data(timestamp_us, config.numberOfChannels,
      config.sampleRate, data_length);
    encoder.encode(data);
    data.close();
    timestamp_us += data_duration_s * 1_000_000;
  }
  
  await encoder.flush();
  encoder.close();

  await decoder.flush();
  decoder.close();
}