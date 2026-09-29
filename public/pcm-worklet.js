// Resample microphone audio from the browser's native AudioContext rate to 24 kHz PCM16.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.phase = 0; this.samples = []; this.last = 0;
  }
  process(inputs, outputs) {
    const source = inputs[0]?.[0];
    if (source) {
      const ratio = sampleRate / 24000;
      for (let i = 0; i < source.length; i++) {
        this.phase += 1;
        this.last = source[i];
        if (this.phase >= ratio) {
          this.phase -= ratio;
          this.samples.push(Math.max(-32768, Math.min(32767, Math.round(this.last * 32767))));
        }
      }
      if (this.samples.length >= 480) {
        const out = new Int16Array(this.samples.splice(0, 480));
        this.port.postMessage(out.buffer, [out.buffer]);
      }
    }
    for (const channel of outputs[0] || []) channel.fill(0);
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
