var frameCount = 0

self.addEventListener('message', function(e) {
  if(++frameCount%10 == 0) {
    self.postMessage('Received ' + frameCount + 'th frame. PTS: ' + e.data.timestamp);
  }

  e.data.close();
}, false);