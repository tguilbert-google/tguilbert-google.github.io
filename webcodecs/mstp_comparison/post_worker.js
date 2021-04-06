var frameCount = 0
var startTime = null
self.addEventListener('message', function(e) {

  var type = e.data.type;

  if (type == "stop") {
    self.postMessage({frames: frameCount, duration: performance.now()-startTime});
    startTime = null;
    return;
  }

  if (type != "frame") {
    console.log("Invalid message");
    return;
  }

  var frame = e.data.frame;

  if (startTime === null)
    startTime = performance.now();

  ++frameCount;

  // Note: frame must be closed here *and* on the sender side.
  frame.close();
}, false);
