const defaultInit = {
  output: () => {},
  error: () => {},
}

var videoDecoder = new VideoDecoder(defaultInit);
var videoEncoder = new VideoEncoder(defaultInit);
var audioDecoder = new AudioDecoder(defaultInit);
var audioEncoder = new AudioEncoder(defaultInit);

videoDecoder.configure({
    codec: "avc1.64000c",
    codedWidth: 1920,
    codedHeight: 1088,
    visibleRegion: {left: 0, top: 0, width: 1920, height: 1080},
    displayWidth: 1920,
    displayHeight: 1080
});

self.postMessage("Created codecs in worker");
