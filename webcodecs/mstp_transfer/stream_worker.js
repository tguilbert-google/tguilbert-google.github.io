var frameCount = 0

self.addEventListener('message', function(e) {
  const frameStream = e.data;
  const frameReader = frameStream.getReader();

  console.log("Got stream from main page.");

  frameReader.read().then(function processFrame({done, value}) {
    if(done) {
      console.log("Frame stream is complete.");
      return;
    }

    ++frameCount;
    if(value === undefined) {
      self.postMessage('Got undefined instead of frame. (count:' + frameCount + ')');
    } else {
      self.postMessage('Read ' + frameCount + 'th frame. PTS: ' + value.timestamp + ' duration ' + value.duration);

      value.destroy();
    }

    frameReader.read().then(processFrame);
  })
}, false);
