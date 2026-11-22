import * as Tone from 'tone';
import { midiToHz } from '../axis';

/** Simple "piano": additive harmonics with 1/n-ish amplitudes, struck envelope. */
/** The Pärt recording is mastered very quietly (peaks at −26.6 dBFS, ~−45 dBFS average);
 *  +24 dB brings its peaks to about −2.6 dBFS. */
const TRACK_GAIN = 16;
/** −12 dB: the generator sits ~8 dB below the (normalised) intro recording. */
const GEN_LEVEL = 0.25;

const PIANO_PARTIALS = [1, 0.55, 0.35, 0.22, 0.15, 0.1, 0.07, 0.05, 0.035];

export const CHORDS: Record<string, number[]> = {
  'C major': [60, 64, 67],
  'A minor': [57, 60, 64],
  'G7': [55, 59, 62, 65],
  'Octaves': [36, 48, 60, 72, 84],
  'Cluster': [60, 61, 62, 63, 64],
};

type Deg = 'I' | 'ii' | 'iii' | 'IV' | 'V' | 'vi';
const TRIADS: Record<Deg, number[]> = {
  I: [0, 4, 7], ii: [2, 5, 9], iii: [4, 7, 11], IV: [5, 9, 12], V: [7, 11, 14], vi: [9, 12, 16],
};
const NEXT: Record<Deg, Deg[]> = {
  I: ['IV', 'V', 'vi', 'ii', 'IV', 'vi'],
  ii: ['V', 'V', 'IV'],
  iii: ['vi', 'IV'],
  IV: ['V', 'I', 'ii', 'V'],
  V: ['I', 'vi', 'I'],
  vi: ['ii', 'IV', 'IV', 'iii'],
};

interface Held {
  osc: Tone.Oscillator;
  gain: Tone.Gain;
}

export class SoundVoices {
  private glide: Held;
  private latched = new Map<number, Held>();
  private piano: Tone.PolySynth;
  private chordSynth: Tone.PolySynth;
  private noises: Record<'white' | 'pink', Tone.Noise>;
  private padLoop: Tone.Loop | null = null;
  private track: HTMLAudioElement | null = null;
  private trackGain: GainNode | null = null;
  private trackTimer = 0;
  activeChord: string | null = null;
  activeNoise: 'white' | 'pink' | null = null;

  /** Generator level. The intro recording (used to set speaker gain) plays ~8 dB above this. */
  private gen: Tone.Gain;

  constructor(private out: Tone.ToneAudioNode) {
    this.gen = new Tone.Gain(GEN_LEVEL).connect(out);
    this.glide = this.makeHeld(440);
    this.piano = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'custom', partials: PIANO_PARTIALS },
      envelope: { attack: 0.004, decay: 2.4, sustain: 0, release: 0.5 },
      volume: -9,
    }).connect(this.gen);
    this.piano.maxPolyphony = 48;
    this.chordSynth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'custom', partials: [1, 0.45, 0.25, 0.12, 0.06] },
      envelope: { attack: 0.06, decay: 0.2, sustain: 0.9, release: 0.6 },
      volume: -15,
    }).connect(this.gen);
    this.noises = {
      white: new Tone.Noise({ type: 'white', volume: -16 }).connect(this.gen),
      pink: new Tone.Noise({ type: 'pink', volume: -12 }).connect(this.gen),
    };
  }

  private makeHeld(f: number): Held {
    const gain = new Tone.Gain(0).connect(this.gen);
    const osc = new Tone.Oscillator(f, 'sine').connect(gain).start();
    return { osc, gain };
  }

  // ---- pure tone on the strip (press, drag = glissando, release) ----
  startGlide(f: number) {
    this.glide.osc.frequency.cancelScheduledValues(Tone.now());
    this.glide.osc.frequency.setValueAtTime(f, Tone.now());
    this.glide.gain.gain.rampTo(0.22, 0.02);
  }
  moveGlide(f: number) {
    this.glide.osc.frequency.rampTo(f, 0.03);
  }
  stopGlide() {
    this.glide.gain.gain.rampTo(0, 0.08);
  }

  /** Shift-click: hold a tone until clicked again. Returns current held list. */
  toggleLatch(f: number): number[] {
    for (const [hf, h] of this.latched) {
      if (Math.abs(Math.log2(hf / f)) < 1 / 24) {
        this.releaseHeld(h);
        this.latched.delete(hf);
        return [...this.latched.keys()];
      }
    }
    const h = this.makeHeld(f);
    h.gain.gain.rampTo(0.15, 0.03);
    this.latched.set(f, h);
    return [...this.latched.keys()];
  }
  private releaseHeld(h: Held) {
    h.gain.gain.rampTo(0, 0.1);
    setTimeout(() => {
      h.osc.dispose();
      h.gain.dispose();
    }, 400);
  }
  get latchedFreqs() {
    return [...this.latched.keys()];
  }

  // ---- keyboard: pure sine at the key's fundamental, held; steps (no glide) ----
  private keyTone: Held | null = null;
  startKey(midi: number) {
    this.keyTone ??= this.makeHeld(440);
    this.keyTone.osc.frequency.cancelScheduledValues(Tone.now());
    this.keyTone.osc.frequency.setValueAtTime(midiToHz(midi), Tone.now());
    this.keyTone.gain.gain.rampTo(0.22, 0.01);
  }
  moveKey(midi: number) {
    this.keyTone?.osc.frequency.setValueAtTime(midiToHz(midi), Tone.now());
  }
  stopKey() {
    this.keyTone?.gain.gain.rampTo(0, 0.05);
  }

  // ---- chords (sustained) ----
  setChord(name: string | null) {
    this.chordSynth.releaseAll();
    this.activeChord = name;
    if (name) this.chordSynth.triggerAttack(CHORDS[name].map(midiToHz));
  }

  setNoise(type: 'white' | 'pink' | null) {
    for (const k of ['white', 'pink'] as const) {
      const n = this.noises[k];
      if (k === type && n.state !== 'started') n.start();
      if (k !== type && n.state === 'started') n.stop();
    }
    this.activeNoise = type;
  }

  // ---- title-slide ambience (fallback when the recording can't play) ----
  /** A bright, broken-chord progression: struck notes, each one a clean stack on the waterfall. */
  startProgression() {
    if (this.padLoop) return;
    let deg: Deg = 'I';
    const tonic = 60;
    this.padLoop = new Tone.Loop((time) => {
      const tri = TRIADS[deg].map((s) => s + tonic);
      const pattern = [tri[0] - 12, tri[0], tri[1], tri[2], tri[0] + 12, tri[2], tri[1], tri[0]];
      pattern.forEach((m, i) => this.piano.triggerAttackRelease(midiToHz(m), 0.5, time + i * 0.19, 0.55));
      const opts = NEXT[deg];
      deg = opts[Math.floor(Math.random() * opts.length)];
    }, 8 * 0.19).start(0.1);
    Tone.getTransport().start();
  }
  stopProgression() {
    if (!this.padLoop) return;
    this.padLoop.stop();
    this.padLoop.dispose();
    this.padLoop = null;
  }

  // ---- a recording, streamed (decoding 10 minutes of audio would cost ~230 MB) ----
  /** Fade a recording in. Resolves false if it can't play. Resumes where it left off. */
  async startTrack(url: string): Promise<boolean> {
    clearTimeout(this.trackTimer);
    this.trackStopping = false;
    if (!this.track) {
      const raw = Tone.getContext().rawContext as unknown as AudioContext;
      this.track = new Audio(url);
      this.track.loop = true;
      this.track.preload = 'auto';
      this.trackGain = raw.createGain();
      this.trackGain.gain.value = 0;
      raw.createMediaElementSource(this.track).connect(this.trackGain);
      Tone.connect(this.trackGain as unknown as Tone.OutputNode, this.out);
    }
    const g = this.trackGain!.gain;
    const t = Tone.now();
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(TRACK_GAIN, t + 2.5);
    try {
      await this.track.play();
      return true;
    } catch (e) {
      console.warn('track failed to play', e);
      return false;
    }
  }
  get trackPlaying() {
    return !!this.track && !this.track.paused && !this.trackStopping;
  }
  private trackStopping = false;
  stopTrack() {
    if (!this.track || !this.trackGain) return;
    const g = this.trackGain.gain;
    const t = Tone.now();
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + 1.5);
    const el = this.track;
    this.trackStopping = true;
    this.trackTimer = window.setTimeout(() => {
      el.pause();
      this.trackStopping = false;
    }, 1600);
  }

  stopAll() {
    this.stopGlide();
    this.stopKey();
    for (const h of this.latched.values()) this.releaseHeld(h);
    this.latched.clear();
    this.setChord(null);
    this.setNoise(null);
    this.stopProgression();
    this.stopTrack();
  }
}
