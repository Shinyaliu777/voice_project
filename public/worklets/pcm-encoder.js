/**
 * pcm-encoder AudioWorklet
 *
 * Pulls Float32 frames from the input, downsamples from the device's native
 * sample rate to a configurable target (16kHz by default for Soniox), and
 * emits 16-bit little-endian PCM batches (~200 ms each) over the worklet
 * port. Also emits an RMS "level" value periodically for the waveform meter.
 *
 * Messages from main:
 *   { type: "config", targetSampleRate: 16000 }
 *
 * Messages to main:
 *   { type: "pcm",   buffer: ArrayBuffer }      // transferable
 *   { type: "level", value: number }            // 0..1
 */

const DEFAULT_TARGET_RATE = 16000;
// 200 ms at 16 kHz = 3200 samples per flush; aim near that regardless of rate.
const FLUSH_MS = 200;
// Send a level event roughly every ~5 process() calls.
const LEVEL_EVERY = 5;

class PcmEncoderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.targetSampleRate = DEFAULT_TARGET_RATE;
    this.flushSamples = Math.max(
      1,
      Math.round((this.targetSampleRate * FLUSH_MS) / 1000)
    );

    // Linear-decimation accumulator: integer step counter vs. ratio of source to target.
    this.ratio = sampleRate / this.targetSampleRate;
    this.position = 0; // fractional position into the input stream
    this.acc = 0; // accumulator for averaging input samples between output picks
    this.accCount = 0; // how many input samples we've folded into `acc`

    // Output buffer of Int16s waiting to be flushed.
    this.outBuf = new Int16Array(this.flushSamples);
    this.outIdx = 0;

    this.processCallCount = 0;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "config") {
        const next = Number(data.targetSampleRate);
        if (Number.isFinite(next) && next > 0) {
          this.targetSampleRate = next;
          this.flushSamples = Math.max(
            1,
            Math.round((this.targetSampleRate * FLUSH_MS) / 1000)
          );
          this.ratio = sampleRate / this.targetSampleRate;
          this.position = 0;
          this.acc = 0;
          this.accCount = 0;
          this.outBuf = new Int16Array(this.flushSamples);
          this.outIdx = 0;
        }
      }
    };
  }

  process(inputs /*, outputs, parameters */) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    this.processCallCount++;

    // ----- level meter (RMS over this block) -----
    if (this.processCallCount % LEVEL_EVERY === 0) {
      let sumSq = 0;
      for (let i = 0; i < channel.length; i++) {
        const s = channel[i];
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / channel.length);
      this.port.postMessage({ type: "level", value: rms });
    }

    // ----- decimation / averaging downsample -----
    // For each input sample, fold into `acc`. Whenever `position` crosses
    // a target-sample boundary, take the average and emit one output sample.
    for (let i = 0; i < channel.length; i++) {
      this.acc += channel[i];
      this.accCount++;
      this.position += 1;

      while (this.position >= this.ratio) {
        const avg = this.accCount > 0 ? this.acc / this.accCount : 0;
        // Float32 [-1,1] -> Int16 with clamp
        const clamped = Math.max(-32768, Math.min(32767, Math.round(avg * 32767)));
        this.outBuf[this.outIdx++] = clamped;
        this.acc = 0;
        this.accCount = 0;
        this.position -= this.ratio;

        if (this.outIdx >= this.outBuf.length) {
          this.flushPcm();
        }
      }
    }

    return true;
  }

  flushPcm() {
    if (this.outIdx === 0) return;
    // Transfer just the filled slice. We need a stand-alone ArrayBuffer because
    // a sliced view shares the parent buffer and we want a clean transfer.
    const out = new Int16Array(this.outIdx);
    out.set(this.outBuf.subarray(0, this.outIdx));
    this.port.postMessage(
      { type: "pcm", buffer: out.buffer },
      [out.buffer]
    );
    // Reset the persistent output buffer for next batch.
    this.outBuf = new Int16Array(this.flushSamples);
    this.outIdx = 0;
  }
}

registerProcessor("pcm-encoder", PcmEncoderProcessor);
