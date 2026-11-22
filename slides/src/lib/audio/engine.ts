import * as Tone from 'tone';

/** reveal's speaker view loads the deck in preview iframes with ?receiver.
 *  Those copies must stay silent and never ask for the mic. */
export const isReceiver =
  typeof location !== 'undefined' && /receiver/i.test(location.search);

export type BandType = 'bypass' | 'lowpass' | 'highpass' | 'bandpass' | 'peaking';
export interface Band {
  type: BandType;
  freq: number;
  q: number;
  gain: number;
}
export interface EqSettings {
  bands: [Band, Band];
  /** Narrow band-pass (4 cascaded high-Q stages) for "noise → tone". */
  narrow: { on: boolean; freq: number; octaves: number };
  /** "Adult ears" preset */
  hearing: boolean;
}
export const BYPASS: EqSettings = {
  bands: [
    { type: 'bypass', freq: 200, q: 0.7, gain: 0 },
    { type: 'bypass', freq: 3000, q: 0.7, gain: 0 },
  ],
  narrow: { on: false, freq: 440, octaves: 1 },
  hearing: false,
};

const NARROW_STAGES = 4;

/** A typical adult's ears, as filters: 4th-order cuts below 20 Hz (infrasound)
 *  and above ~13 kHz (age-related high-frequency loss; teenagers reach 17–20 kHz,
 *  most people in their 40s ~13–14 kHz). By 20 kHz it's down ~20 dB. */
const HEARING: { type: BiquadFilterType; f: number; q: number }[] = [
  { type: 'highpass', f: 20, q: 0.5412 },
  { type: 'highpass', f: 20, q: 1.3066 },
  { type: 'lowpass', f: 13000, q: 0.5412 },
  { type: 'lowpass', f: 13000, q: 1.3066 },
];

/** Web Audio takes lowpass/highpass Q in dB (resonance), other types linear. */
function qParam(type: BiquadFilterType, q: number) {
  return type === 'lowpass' || type === 'highpass' ? 20 * Math.log10(q) : q;
}

/** Q for a band-pass whose -3 dB width is `oct` octaves. */
export function qForOctaves(oct: number) {
  const r = Math.pow(2, oct);
  return Math.sqrt(r) / (r - 1);
}

/** A chain of native biquads. Two copies exist: one for what we hear,
 *  one that filters the mic for display only. */
class EqChain {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly nodes: BiquadFilterNode[] = [];
  private makeup: GainNode;

  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.makeup = ctx.createGain();
    let prev: AudioNode = this.input;
    for (let i = 0; i < 2 + NARROW_STAGES + HEARING.length; i++) {
      const b = ctx.createBiquadFilter();
      b.type = 'allpass';
      prev.connect(b);
      prev = b;
      this.nodes.push(b);
    }
    prev.connect(this.makeup);
    this.makeup.connect(this.output);
  }

  apply(s: EqSettings) {
    const t = this.input.context.currentTime;
    s.bands.forEach((band, i) => {
      const n = this.nodes[i];
      n.type = band.type === 'bypass' ? 'allpass' : band.type;
      n.frequency.setTargetAtTime(band.freq, t, 0.02);
      n.Q.setTargetAtTime(band.type === 'bypass' ? 0.0001 : qParam(band.type, band.q), t, 0.02);
      n.gain.setTargetAtTime(band.gain, t, 0.02);
    });
    const q = qForOctaves(s.narrow.octaves);
    for (let i = 0; i < NARROW_STAGES; i++) {
      const n = this.nodes[2 + i];
      n.type = s.narrow.on ? 'bandpass' : 'allpass';
      n.frequency.setTargetAtTime(s.narrow.freq, t, 0.02);
      n.Q.setTargetAtTime(s.narrow.on ? q : 0.0001, t, 0.02);
    }
    HEARING.forEach((h, i) => {
      const n = this.nodes[2 + NARROW_STAGES + i];
      n.type = s.hearing ? h.type : 'allpass';
      n.frequency.setTargetAtTime(h.f, t, 0.02);
      n.Q.setTargetAtTime(s.hearing ? qParam(h.type, h.q) : 0.0001, t, 0.02);
    });
    // White noise power ∝ bandwidth; make the narrow band audible.
    const bwHz = s.narrow.freq * (Math.pow(2, s.narrow.octaves) - 1);
    const mk = s.narrow.on ? Math.min(60, 0.35 * Math.sqrt(20000 / bwHz)) : 1;
    this.makeup.gain.setTargetAtTime(mk, t, 0.05);
  }
}

class Engine {
  readonly raw: AudioContext;
  readonly master: Tone.Gain;
  /** All sound-lab generators feed this. */
  readonly genBus: Tone.Gain;
  /** Light sonification feeds this (no analysers). */
  readonly lightBus: Tone.Gain;
  readonly inAn: AnalyserNode;
  readonly outAn: AnalyserNode;
  private eqMain: EqChain;
  private eqMic: EqChain;
  private micGain: GainNode;
  eq: EqSettings = structuredClone(BYPASS);

  armed = false;
  micState: 'off' | 'pending' | 'on' | 'denied' = 'off';
  micMuted = false;
  private micWanted = false;
  private listeners = new Set<() => void>();

  constructor() {
    this.raw = Tone.getContext().rawContext as unknown as AudioContext;
    const raw = this.raw;
    const limiter = new Tone.Limiter(-2).toDestination();
    this.master = new Tone.Gain(0.9).connect(limiter);
    this.genBus = new Tone.Gain(1);
    this.lightBus = new Tone.Gain(1).connect(this.master);

    this.inAn = raw.createAnalyser();
    this.outAn = raw.createAnalyser();
    for (const an of [this.inAn, this.outAn]) {
      an.fftSize = 8192;
      an.smoothingTimeConstant = 0.35;
      an.minDecibels = -120;
      an.maxDecibels = 0;
    }
    // Analysers need to be pulled; route them into a silent sink.
    const sink = raw.createGain();
    sink.gain.value = 0;
    sink.connect(raw.destination);
    this.inAn.connect(sink);
    this.outAn.connect(sink);

    this.eqMain = new EqChain(raw);
    this.eqMic = new EqChain(raw);
    this.genBus.connect(this.inAn as unknown as Tone.InputNode);
    this.genBus.connect(this.eqMain.input as unknown as Tone.InputNode);
    this.eqMain.output.connect(this.outAn);
    Tone.connect(this.eqMain.output as unknown as Tone.OutputNode, this.master);

    this.micGain = raw.createGain();
    this.micGain.gain.value = 0;
    this.micGain.connect(this.inAn);
    this.micGain.connect(this.eqMic.input);
    this.eqMic.output.connect(this.outAn); // analysis only — never to speakers
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
  }
  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  /** Call from a user gesture in the deck window. */
  async arm() {
    if (this.armed) return;
    await Tone.start();
    this.armed = true;
    this.emit();
    this.openMic();
  }

  private async openMic() {
    if (this.micState !== 'off') return;
    this.micState = 'pending';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const src = this.raw.createMediaStreamSource(stream);
      src.connect(this.micGain);
      this.micState = 'on';
    } catch (e) {
      console.warn('mic unavailable', e);
      this.micState = 'denied';
    }
    this.updateMic();
  }

  /** Scenes say whether the mic should be live (sound slides only). */
  setMicWanted(on: boolean) {
    this.micWanted = on;
    this.updateMic();
  }
  toggleMicMute() {
    this.micMuted = !this.micMuted;
    this.updateMic();
  }
  get micLive() {
    return this.micState === 'on' && this.micWanted && !this.micMuted;
  }
  private updateMic() {
    this.micGain.gain.setTargetAtTime(this.micLive ? 1 : 0, this.raw.currentTime, 0.05);
    this.emit();
  }

  setEq(s: EqSettings) {
    this.eq = structuredClone(s);
    this.eqMain.apply(this.eq);
    this.eqMic.apply(this.eq);
  }

  /** |H(f)| of the whole chain for the given frequencies. */
  eqResponse(freqs: Float32Array<ArrayBuffer>, out: Float32Array<ArrayBuffer>) {
    out.fill(1);
    const mag = new Float32Array(freqs.length);
    const ph = new Float32Array(freqs.length);
    const e = this.eq;
    // Compute from settings with an offline biquad so the curve updates instantly
    // (the live nodes glide toward targets).
    const stages: { type: BiquadFilterType; f: number; q: number; g: number }[] = [];
    for (const b of e.bands)
      if (b.type !== 'bypass') stages.push({ type: b.type, f: b.freq, q: b.q, g: b.gain });
    if (e.narrow.on)
      for (let i = 0; i < NARROW_STAGES; i++)
        stages.push({ type: 'bandpass', f: e.narrow.freq, q: qForOctaves(e.narrow.octaves), g: 0 });
    if (e.hearing) for (const h of HEARING) stages.push({ type: h.type, f: h.f, q: h.q, g: 0 });
    for (const s of stages) {
      const n = scratchBiquad();
      n.type = s.type;
      n.frequency.value = s.f;
      n.Q.value = qParam(s.type, s.q);
      n.gain.value = s.g;
      n.getFrequencyResponse(freqs, mag, ph);
      for (let i = 0; i < out.length; i++) out[i] *= mag[i];
    }
    return out;
  }
}

let scratch: BiquadFilterNode | null = null;
function scratchBiquad() {
  if (!scratch) {
    const off = new OfflineAudioContext(1, 128, 48000);
    scratch = off.createBiquadFilter();
  }
  return scratch;
}

let engine: Engine | null = null;
/** null inside reveal's speaker-view iframes. */
export function getEngine(): Engine | null {
  if (isReceiver) return null;
  if (!engine) engine = new Engine();
  return engine;
}
export type { Engine };
