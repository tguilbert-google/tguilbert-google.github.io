var frameCount = 0
var stopped = false;
self.addEventListener('message', function(e) {

  var type = e.data.type;

  if (type == "stop") {
    stopped = true;
    return;
  }

  if (type != "stream") {
    console.log("Invalid message");
    return;
  }

  const frameStream = e.data.stream;
  const frameReader = frameStream.getReader();

  console.log("Got stream from main page.");

  frameReader.read().then(function processFrame({done, value}) {
    if(done) {
      self.postMessage("Stream is done.");
      return;
    }

    if (stopped) {
      frameReader.releaseLock();
      frameStream.cancel();
      value.close();
      self.postMessage("Stopped");
      return
    }

    if (++frameCount % 20 == 0) {
      self.postMessage("Read 20 frames");
    }

    value.close();
    frameReader.read().then(processFrame);
  })
}, false);
