const constraints_base = {
  audio: {
    autoGainControl: true,
    noiseSuppression: true,
    echoCancellation: true,
  },
  video: false
};

let audioTrack;
let stream;

let audioContext;
let streamNode;
let workletNode;
let wasmWorkletNode;

let processor;
let generator;
let encoder;
let decoder;

let audioElement;

function displayRoute(msg) {
  document.querySelector("#routeMsg").innerHTML = msg;
}

function disable(id) {
  document.querySelector(id).disabled = true;
}

function show(id) {
  document.querySelector(id).style.visibility = 'visible';
}

function hide(id) {
  document.querySelector(id).style.visibility = 'hidden';
}

async function initAudioContext() {
  if(!audioContext) {
    audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule("./passthrough-processor.js");
    await audioContext.audioWorklet.addModule("./wasm-worklet-processor.js");
  }
}

function handleSuccess() {
  const audioTracks = stream.getAudioTracks();
  console.log(`Using Audio device: ${audioTracks[0].label}`);
  console.log(audioTracks);
  audioTrack = audioTracks[0];
  window.audioTrack = audioTrack; // make variable available to browser console
}

function handleError(error) {
  if (error.name === 'PermissionDeniedError') {
    errorMsg('Permissions have not been granted to use your camera and ' +
      'microphone, you need to allow the page access to your devices in ' +
      'order for the demo to work.');
  }
  errorMsg(`getUserMedia error: ${error.name}`, error);
}

function errorMsg(msg, error) {
  const errorElement = document.querySelector('#errorMsg');
  errorElement.innerHTML += `<p>${msg}</p>`;
  if (typeof error !== 'undefined') {
    console.error(error);
  }
}

async function init() {
  try {
    let constraints = constraints_base;

    constraints.audio.autoGainControl = document.getElementById('agc').checked;
    constraints.audio.noiseSuppression = document.getElementById('ns').checked;
    constraints.audio.echoCancellation = document.getElementById('ec').checked;

    stream = await navigator.mediaDevices.getUserMedia(constraints);

    disable("#agc");
    disable("#ns");
    disable("#ec");
    handleSuccess();
  } catch (e) {
    handleError(e);
  }

  await initAudioContext();

  disable("#initBtn");
  show("#outputTypesDiv");
}

function trackToMSSN() {
  streamNode = audioContext.createMediaStreamSource(stream);
  streamNode.connect(audioContext.destination);
  hide("#outputTypesDiv");
  displayRoute("gUM --> MediaStreamSourceNode --> audioContext.destination");
}

function trackToWorklet() {
  streamNode = audioContext.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(audioContext, 'passthrough-processor');
  streamNode.connect(workletNode).connect(audioContext.destination);
  hide("#outputTypesDiv");
  displayRoute("gUM --> MediaStreamSourceNode --> AudioWorkletNode --> audioContext.destination");
}

function trackToWASM() {
  streamNode = audioContext.createMediaStreamSource(stream);
  wasmWorkletNode = new AudioWorkletNode(audioContext, 'wasm-worklet-processor');
  streamNode.connect(wasmWorkletNode).connect(audioContext.destination);
  hide("#outputTypesDiv");
  displayRoute("gUM --> MediaStreamSourceNode --> WASM -> audioContext.destination");
}

function trackToBreakoutBox() {
  processor = new MediaStreamTrackProcessor(audioTrack);
  generator = new MediaStreamTrackGenerator('audio');

  processor.readable.pipeTo(generator.writable);

  let breakoutBoxStream = new MediaStream([generator]);

  streamNode = audioContext.createMediaStreamSource(breakoutBoxStream);
  wasmWorkletNode = new AudioWorkletNode(audioContext, 'wasm-worklet-processor');
  streamNode.connect(wasmWorkletNode).connect(audioContext.destination);
  hide("#outputTypesDiv");
  displayRoute("gUM --> MediaStreamTrackGenerator --> MediaStreamTrackProcessor --> MediaStreamSourceNode --> WASM -> audioContext.destination");
}


function trackToWebCodecs() {
  generator = new MediaStreamTrackGenerator('audio');
  const writer = generator.writable.getWriter();

  let decoder_init = {
    error: () => console.log("Decode error"),
    output: data => {
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

  let encoder_config = {
    codec: 'opus',
    sampleRate: 48000,
    numberOfChannels: 1,
    bitrate: 256000,  // 256kbit
  };

  encoder.configure(encoder_config);

  processor = new MediaStreamTrackProcessor(audioTrack);

  const reader = processor.readable.getReader();

  reader.read().then(function pump({ done, value }) {
      if (done) {
        console.log("Stream ended");
        return;
      }

      encoder.encode(value);

      value.close;

      return reader.read().then(pump);
    }
  );

  let breakoutBoxStream = new MediaStream([generator]);

  streamNode = audioContext.createMediaStreamSource(breakoutBoxStream);
  wasmWorkletNode = new AudioWorkletNode(audioContext, 'wasm-worklet-processor');
  streamNode.connect(wasmWorkletNode).connect(audioContext.destination);
  hide("#outputTypesDiv");
  displayRoute("gUM --> MediaStreamTrackGenerator --> WebCodecs Opus encoder --> WebCodecs Opus decoder --> MediaStreamTrackProcessor --> MediaStreamSourceNode --> WASM -> audioContext.destination");
}

function trackToAudioElement() {
  audioElement = document.createElement('audio');
  audioElement.srcObject = stream;
  audioElement.play()
  hide("#outputTypesDiv");
  displayRoute("gUM --> MediaStream --> <audio>.srcObject");
}
