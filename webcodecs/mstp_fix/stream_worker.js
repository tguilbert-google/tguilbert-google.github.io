var frameCount = 0
self.addEventListener('message', function(e) {

  var type = e.data.type;

  if (type != "frame") {
    console.log("Invalid message");
    return;
  }

  var frame = e.data.frame;

  if (frame === undefined || frame === null) {
    console.log("No frame!");
    return;
  }

  if (++frameCount % 20 == 0) {
    self.postMessage("Read 20 frames");
  }

  // Note: frame must be closed here *and* on the sender side.
  frame.close();
}, false);
