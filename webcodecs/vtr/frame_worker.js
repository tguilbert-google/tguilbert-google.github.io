var frameCount = 0

self.addEventListener('message', function(e) {
  ++frameCount;
  self.postMessage('Received ' + frameCount + 'th frame. PTS: ' + e.data.timestamp + ' duration ' + e.data.duration);

  e.data.destroy();
}, false);
