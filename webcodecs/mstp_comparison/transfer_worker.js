var frameCount = 0
var stopped = false;
var startTime = 0
self.addEventListener('message', function(e) {
  var type = e.data.type;

  if (type == "stop") {
    stopped = true;
    self.postMessage({frames: frameCount, duration: performance.now()-startTime});
    return;
  }

  startTime = performance.now();

  const frameStream = e.data.stream;
  const frameReader = frameStream.getReader();

  frameReader.read().then(function processFrame({done, value}) {
    if(done)
      return;

    if (stopped) {
      frameReader.releaseLock();
      frameStream.cancel();
      value.close();
      return
    }

    ++frameCount;

    value.close();
    frameReader.read().then(processFrame);
  })
}, false);
