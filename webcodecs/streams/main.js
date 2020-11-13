var last_frame_canvas;
var first_frame_canvas;
var second_frame_canvas;

var stream_processor;

var keep_reading_from_steam = true;

async function paintFrame(frame, canvas) {
  var ctx = canvas.getContext('2d');

  var img = await frame.createImageBitmap();
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close();
  frame.destroy();
}

async function readFromStream() {
  const reader = stream_processor.readable.getReader();
  reader.read().then(function readStream({value, done}) {
    if(done)
      console.log("Done reading.");

    paintFrame(value, last_frame_canvas);

    if(keep_reading_from_steam)
      return reader.read().then(readStream);
    else
      reader.releaseLock();
  })
}

async function start() {
  var vid = document.getElementById("vid");
  vid.src = "../../vid/buck360p_vp9.webm";
  await vid.play();

  last_frame_canvas = document.getElementById("last-frame");
  first_frame_canvas = document.getElementById("first-frame");
  second_frame_canvas = document.getElementById("second-frame");

  window.last = last_frame_canvas;
  window.first = first_frame_canvas;

  var video_track = vid.captureStream().getVideoTracks()[0];

  stream_processor = new MediaStreamTrackProcessor(video_track);

  document.getElementById("start-btn").disabled = true;

  readFromStream();
}

function toggle() {
  keep_reading_from_steam = !keep_reading_from_steam;

  if(keep_reading_from_steam) {
    readFromStream();
    document.getElementById("read-btn").disabled = true;
    document.getElementById("toggle-btn").innerText = "Pause";
  } else {
    document.getElementById("read-btn").disabled = '';
    document.getElementById("toggle-btn").innerText = "Resume";
  }
}

function readTwoFrames() {
  const reader = stream_processor.readable.getReader();
  reader.read().then(({value, done}) => {
    paintFrame(value, first_frame_canvas);

    return reader.read().then(({value, done}) => {
      paintFrame(value, second_frame_canvas)
      reader.releaseLock();
    });
  })
}
