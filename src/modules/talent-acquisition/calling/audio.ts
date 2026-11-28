/**
 * Audio for AI calls. Inside HireAI a call's audio is 16-bit little-endian
 * mono PCM at 16 kHz; the phone line (G.711 mu-law, 8 kHz) and each voice AI
 * (16 or 24 kHz PCM) are converted at the edges.
 */
export const CALL_RATE = 16000;

/**
 * A windowed-sinc (Blackman) low-pass filter: passes speech below `cutoff`
 * and removes what would otherwise fold back as a metallic hiss when the
 * sample rate is lowered.
 */
function lowPass(cutoff: number, rate: number, taps = 33) {
  const middle = (taps - 1) / 2;
  const fc = cutoff / rate;
  const kernel = new Float64Array(taps);
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const x = n - middle;
    const sinc =
      x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const window =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * n) / (taps - 1)) +
      0.08 * Math.cos((4 * Math.PI * n) / (taps - 1));
    kernel[n] = sinc * window;
    sum += kernel[n];
  }
  for (let n = 0; n < taps; n++) kernel[n] /= sum;
  return kernel;
}

/**
 * Converts a stream of PCM16 chunks between sample rates, carrying its
 * position (and filter history) across chunks so chunk boundaries don't
 * click. When lowering the rate, a proper low-pass filter runs first; then
 * linear interpolation picks the new samples.
 */
export class Resampler {
  private position = 0;
  private previous = 0;
  private readonly kernel: Float64Array | null;
  private history: Float64Array;

  constructor(
    readonly from: number,
    readonly to: number,
  ) {
    // Just under the output's Nyquist frequency (half its sample rate).
    this.kernel = to < from ? lowPass(0.45 * to, from) : null;
    this.history = new Float64Array(this.kernel ? this.kernel.length - 1 : 0);
  }

  private filter(pcm: Buffer, count: number) {
    const input = new Float64Array(count);
    const kernel = this.kernel;
    if (!kernel) {
      for (let i = 0; i < count; i++) input[i] = pcm.readInt16LE(i * 2);
      return input;
    }
    const taps = kernel.length;
    const all = new Float64Array(taps - 1 + count);
    all.set(this.history);
    for (let i = 0; i < count; i++) all[taps - 1 + i] = pcm.readInt16LE(i * 2);
    for (let i = 0; i < count; i++) {
      let sum = 0;
      for (let k = 0; k < taps; k++) sum += kernel[k] * all[i + taps - 1 - k];
      input[i] = sum;
    }
    this.history = all.slice(all.length - (taps - 1));
    return input;
  }

  push(pcm: Buffer): Buffer {
    const count = pcm.length >> 1;
    if (this.from === this.to || count === 0) return pcm.subarray(0, count * 2);
    const input = this.filter(pcm, count);
    const step = this.from / this.to;
    const output: number[] = [];
    let position = this.position;
    const read = (i: number) => (i < 0 ? this.previous : input[i]);
    for (;;) {
      const i = Math.floor(position);
      if (i + 1 > count - 1) break;
      const a = read(i);
      output.push(a + (read(i + 1) - a) * (position - i));
      position += step;
    }
    this.previous = input[count - 1];
    this.position = position - count;
    const bytes = Buffer.alloc(output.length * 2);
    output.forEach((v, i) => bytes.writeInt16LE(clamp(v), i * 2));
    return bytes;
  }
}

const clamp = (v: number) =>
  Math.max(-32768, Math.min(32767, Math.round(v))) | 0;

/** G.711 mu-law byte to a 16-bit sample. */
export function mulawDecode(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  return sign ? -magnitude : magnitude;
}

/** A 16-bit sample to a G.711 mu-law byte. */
export function mulawEncode(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = sample < 0 ? 0x80 : 0;
  let magnitude = Math.min(Math.abs(sample), CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (magnitude & mask) === 0 && exponent > 0; mask >>= 1)
    exponent--;
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  magnitude = sign | (exponent << 4) | mantissa;
  return ~magnitude & 0xff;
}

export function mulawToPcm(bytes: Buffer): Buffer {
  const pcm = Buffer.alloc(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++)
    pcm.writeInt16LE(mulawDecode(bytes[i]), i * 2);
  return pcm;
}

export function pcmToMulaw(pcm: Buffer): Buffer {
  const count = pcm.length >> 1;
  const bytes = Buffer.alloc(count);
  for (let i = 0; i < count; i++)
    bytes[i] = mulawEncode(pcm.readInt16LE(i * 2));
  return bytes;
}

/** Seconds of 16 kHz PCM16 audio in a buffer. */
export const callSeconds = (pcm: Buffer) => pcm.length / 2 / CALL_RATE;

/**
 * Records a call as a two-channel WAV (candidate left, AI right) at 8 kHz,
 * phone quality. The candidate's audio arrives in real time and sets the
 * clock; the AI's audio arrives faster than it plays, so it's laid down after
 * whatever the AI is still saying. When the candidate interrupts, the AI audio
 * that never played is removed.
 */
export class CallRecorder {
  static readonly RATE = 8000;
  private candidate: Int16Array;
  private ai: Int16Array;
  private candidateEnd = 0;
  private aiEnd = 0;
  private readonly limit: number;
  private readonly candidateRate = new Resampler(CALL_RATE, CallRecorder.RATE);
  private readonly aiRate = new Resampler(CALL_RATE, CallRecorder.RATE);

  constructor(maxSeconds: number) {
    this.limit = maxSeconds * CallRecorder.RATE;
    const start = Math.min(this.limit, 60 * CallRecorder.RATE);
    this.candidate = new Int16Array(start);
    this.ai = new Int16Array(start);
  }

  private room(samples: number) {
    if (samples <= this.candidate.length) return;
    const size = Math.min(
      this.limit,
      Math.max(samples, this.candidate.length * 2),
    );
    const grow = (from: Int16Array) => {
      const to = new Int16Array(size);
      to.set(from);
      return to;
    };
    this.candidate = grow(this.candidate);
    this.ai = grow(this.ai);
  }

  private write(track: 'candidate' | 'ai', at: number, pcm: Buffer) {
    const count = Math.min(pcm.length >> 1, this.limit - at);
    if (count <= 0) return at;
    this.room(at + count);
    const target = track === 'candidate' ? this.candidate : this.ai;
    for (let i = 0; i < count; i++) target[at + i] = pcm.readInt16LE(i * 2);
    return at + count;
  }

  addCandidate(pcm16k: Buffer) {
    this.candidateEnd = this.write(
      'candidate',
      this.candidateEnd,
      this.candidateRate.push(pcm16k),
    );
  }

  addAi(pcm16k: Buffer) {
    this.aiEnd = this.write(
      'ai',
      Math.max(this.aiEnd, this.candidateEnd),
      this.aiRate.push(pcm16k),
    );
  }

  /** The candidate interrupted: drop the AI audio that hadn't played yet. */
  interrupt() {
    if (this.aiEnd > this.candidateEnd)
      this.ai.fill(0, this.candidateEnd, this.aiEnd);
    this.aiEnd = Math.min(this.aiEnd, this.candidateEnd);
  }

  get seconds() {
    return Math.max(this.candidateEnd, this.aiEnd) / CallRecorder.RATE;
  }

  /** The recording as a WAV file, or null when nothing was recorded. */
  wav(): Buffer | null {
    const samples = Math.max(this.candidateEnd, this.aiEnd);
    if (!samples) return null;
    const data = samples * 4;
    const out = Buffer.alloc(44 + data);
    out.write('RIFF', 0, 'ascii');
    out.writeUInt32LE(36 + data, 4);
    out.write('WAVE', 8, 'ascii');
    out.write('fmt ', 12, 'ascii');
    out.writeUInt32LE(16, 16);
    out.writeUInt16LE(1, 20); // PCM
    out.writeUInt16LE(2, 22); // stereo
    out.writeUInt32LE(CallRecorder.RATE, 24);
    out.writeUInt32LE(CallRecorder.RATE * 4, 28);
    out.writeUInt16LE(4, 32);
    out.writeUInt16LE(16, 34);
    out.write('data', 36, 'ascii');
    out.writeUInt32LE(data, 40);
    // Phone audio arrives much quieter than the AI's voice: level each side.
    const candidate = levelled(this.candidate, samples);
    const ai = levelled(this.ai, samples);
    for (let i = 0; i < samples; i++) {
      out.writeInt16LE(candidate(i), 44 + i * 4);
      out.writeInt16LE(ai(i), 46 + i * 4);
    }
    return out;
  }
}

/** Speech is raised until its loud parts (99.9th percentile) reach this. */
const LEVEL_TARGET = 20000;
/** At most 18 dB louder, so a near-silent line isn't turned into hiss. */
const MAX_GAIN = 8;
/** Above this, peaks are compressed smoothly instead of clipping... */
const LIMIT_KNEE = 24000;
/** ...and never reach full scale. */
const LIMIT_CEILING = 32000;

/**
 * A channel raised to a common loudness (never lowered), with a soft limiter
 * on the few peaks that would otherwise distort. Returns a sample reader.
 */
export function levelled(track: Int16Array, samples: number) {
  // The 99.9th percentile of loudness, from a histogram (no sorting).
  const bins = new Uint32Array(257);
  for (let i = 0; i < samples; i++) bins[Math.abs(track[i]) >> 7]++;
  let rank = Math.floor(samples * 0.999);
  let loud = 0;
  for (let bin = 0; bin < bins.length; bin++) {
    rank -= bins[bin];
    if (rank < 0) {
      loud = (bin + 1) << 7;
      break;
    }
  }
  const gain = loud ? Math.min(MAX_GAIN, Math.max(1, LEVEL_TARGET / loud)) : 1;
  const room = LIMIT_CEILING - LIMIT_KNEE;
  return (i: number) => {
    const value = (track[i] ?? 0) * gain;
    const size = Math.abs(value);
    if (size <= LIMIT_KNEE) return Math.round(value);
    const limited = LIMIT_KNEE + room * Math.tanh((size - LIMIT_KNEE) / room);
    return Math.round(Math.sign(value) * limited);
  };
}
