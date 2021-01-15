var frameCount = 0

self.addEventListener('message', function(e) {
  const frameStream = e.data;
  const frameReader = frameStream.getReader();

  console.log("Got stream from main page.");

  frameReader.read().then(function processFrame({done, frame}) {
    if(done) {
      console.log("Frame stream is complete.");
      return;
    }

    ++frameCount;
    if(frame === undefined) {
      self.postMessage('Got undefined instead of frame. (count:' + frameCount + ')');
    } else {
      self.postMessage('Read ' + frameCount + 'th frame. PTS: ' + frame.timestamp + ' duration ' + frame.duration);

      frame.destroy();
    }

    frameReader.read().then(processFrame);
  })
}, false);
