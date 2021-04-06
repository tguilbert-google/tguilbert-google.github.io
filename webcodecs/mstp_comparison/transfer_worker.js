var frameCount = 0
var stopped = false;
var startTime = null
self.addEventListener('message', function(e) {
  var type = e.data.type;

  if (type == "stop") {
    stopped = true;
    self.postMessage({frames: frameCount, duration: performance.now()-startTime});
    return;
  }

  const frameStream = e.data.stream;
  const frameReader = frameStream.getReader();

  frameReader.read().then(function processFrame({done, value}) {
    if (startTime === null)
      startTime = performance.now();

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
