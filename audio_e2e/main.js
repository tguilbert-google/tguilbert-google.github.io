const constraints = {
  audio: true,
  video: false
};

let track;
let stream;

let audioContext;
let streamNode;
let workletNode;
let wasmWorkletNode;

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
  track = audioTracks[0];
  window.track = track; // make variable available to browser console
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
    stream = await navigator.mediaDevices.getUserMedia(constraints);
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

function trackToAudioElement() {
  audioElement = document.createElement('audio');
  audioElement.srcObject = stream;
  audioElement.play()
  hide("#outputTypesDiv");
  displayRoute("gUM --> MediaStream --> <audio>.srcObject");
}