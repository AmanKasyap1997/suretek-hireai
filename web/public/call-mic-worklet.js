// Turns the microphone into 16 kHz 16-bit PCM frames (20 ms each) for an AI
// test call. Each output sample averages the input samples it covers.
class CallMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.frame = new Int16Array(320);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count++;
      this.phase++;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        const value = Math.max(-1, Math.min(1, this.sum / this.count));
        this.sum = 0;
        this.count = 0;
        this.frame[this.filled++] = value < 0 ? value * 0x8000 : value * 0x7fff;
        if (this.filled === this.frame.length) {
          this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
          this.frame = new Int16Array(320);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('call-mic', CallMicProcessor);
