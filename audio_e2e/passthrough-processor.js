class PassthroughProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    // 1 in 1 out
    const input = inputs[0];
    const output = outputs[0];

    for (let ch = 0; ch < input.length; ++ch) {
      const input_ch = input[ch];
      const output_ch = output[ch];

      for (let i = 0; i < input_ch.length; ++i) {
        output_ch[i] = input_ch[i];
      }
    }
    return true;

  }
}

registerProcessor("passthrough-processor", PassthroughProcessor);