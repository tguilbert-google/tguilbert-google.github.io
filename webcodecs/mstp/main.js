// Put variables in global scope to make them available to the browser console.
const constraints = window.constraints = {
  audio: true,
  video: true
};

function checkForMSTP() {
  if (typeof MediaStreamTrackProcessor === 'undefined' ||
      typeof MediaStreamTrackGenerator === 'undefined') {

    document.getElementById('errorMsg').textContent =
        'Your browser does not support the experimental MediaStreamTrack API. ' +
        'Please launch with the --enable-blink-features=MediaStreamInsertableStreams flag';
        document.getElementById('addMSTProcessor').disabled = true;
  }
}

var track;

var frameWorker;

function handleSuccess(stream) {
  const video = document.querySelector('video');
  const videoTracks = stream.getVideoTracks();
  console.log(`Using video device: ${videoTracks[0].label}`);
  track = videoTracks[0];
  window.stream = stream; // make variable available to browser console
  video.srcObject = stream;
}

function sendFrameToFrameworker(newFrame) {
  frameWorker.postMessage(newFrame);
}

function addTrackReader() {
  var track_reader = new VideoTrackReader(track);
  track_reader.start(sendFrameToFrameworker);
}

function addMSTProcessor() {
  var processor = new MediaStreamTrackProcessor(track);

  const frameReader = processor.readable.getReader();

  frameReader.read().then(function processFrame({done, value}) {
    if(done) {
      console.log("Frame stream is complete.");
      return;
    }

    sendFrameToFrameworker(value);

    frameReader.read().then(processFrame);
  })
}

function handleError(error) {
  if (error.name === 'ConstraintNotSatisfiedError') {
    const v = constraints.video;
    errorMsg(`The resolution ${v.width.exact}x${v.height.exact} px is not supported by your device.`);
  } else if (error.name === 'PermissionDeniedError') {
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
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    handleSuccess(stream);

    frameWorker = new Worker("frame_worker.js");

    frameWorker.addEventListener('message', function(e) {
      document.getElementById('workerMsg').textContent = "Msg from worker: " + e.data;
      console.log(e.data);
    }, false);

  } catch (e) {
    handleError(e);
  }
}
