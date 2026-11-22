import * as Tone from 'tone';
import { nmToAudioHz, VISIBLE_NM } from '../axis';
import { LINE_SIGMA, NM0, type Spectrum } from './spectra';

const LINE_AREA = LINE_SIGMA * Math.sqrt(2 * Math.PI);
const MAX_LINES = 8;
const BANK = 48;

/** Only what we can see makes a sound: invisible light stays silent. */
function visibleWeight(nm: number) {
  const [lo, hi] = VISIBLE_NM;
  if (nm <= lo || nm >= hi) return 0;
  const edge = 25;
  if (nm < lo + edge) return 0.5 - 0.5 * Math.cos((Math.PI * (nm - lo)) / edge);
  if (nm > hi - edge) return 0.5 - 0.5 * Math.cos((Math.PI * (hi - nm)) / edge);
  return 1;
}

interface Voice {
  osc: Tone.Oscillator;
  gain: Tone.Gain;
}

/** Plays a light spectrum 40 octaves down: lines as pure tones, broadband as a dense cloud. */
export class Sonifier {
  private lines: Voice[] = [];
  private bank: Voice[] = [];
  private bankEdges: number[] = [];
  private bus: Tone.Gain;
  muted = false;
  private enabled = true;
  level = 0.22;

  constructor(out: Tone.InputNode) {
    this.bus = new Tone.Gain(1).connect(out);
    const mk = (f: number): Voice => {
      const gain = new Tone.Gain(0).connect(this.bus);
      const osc = new Tone.Oscillator(f, 'sine').connect(gain).start();
      return { osc, gain };
    };
    for (let i = 0; i < MAX_LINES; i++) this.lines.push(mk(440));
    const [lo, hi] = VISIBLE_NM;
    for (let i = 0; i <= BANK; i++) this.bankEdges.push(hi * Math.pow(lo / hi, i / BANK));
    for (let i = 0; i < BANK; i++) {
      const nm = Math.sqrt(this.bankEdges[i] * this.bankEdges[i + 1]);
      const detune = Math.pow(2, ((Math.random() - 0.5) * 16) / 1200);
      this.bank.push(mk(nmToAudioHz(nm) * detune));
    }
  }

  /** true = audible */
  setEnabled(on: boolean) {
    this.enabled = on;
    this.bus.gain.rampTo(on && !this.muted ? 1 : 0, 0.15);
  }
  toggleMute() {
    this.muted = !this.muted;
    this.setEnabled(this.enabled);
    return this.muted;
  }

  set(spec: Spectrum | null) {
    const lineAmps: { f: number; a: number }[] = [];
    const bankAmps = new Array<number>(BANK).fill(0);
    if (spec) {
      for (const l of spec.lines) {
        const a = l.p * LINE_AREA * visibleWeight(l.nm);
        if (a > 1e-4) lineAmps.push({ f: nmToAudioHz(l.nm), a });
      }
      for (let i = 0; i < BANK; i++) {
        const a0 = Math.ceil(this.bankEdges[i + 1]), a1 = Math.floor(this.bankEdges[i]);
        let s = 0;
        for (let nm = a0; nm <= a1; nm++) s += (spec.broad[nm - NM0] ?? 0) * visibleWeight(nm);
        bankAmps[i] = s;
      }
    }
    lineAmps.sort((a, b) => b.a - a.a);
    lineAmps.length = Math.min(lineAmps.length, MAX_LINES);
    const total = lineAmps.reduce((s, l) => s + l.a, 0) + bankAmps.reduce((s, a) => s + a, 0);
    const k = total > 1e-6 ? this.level / total : 0;
    // Broadband energy is spread over many partials; give it a perceptual lift.
    const kb = k * 2.2;
    this.lines.forEach((v, i) => {
      const l = lineAmps[i];
      if (l) {
        v.osc.frequency.rampTo(l.f, 0.03);
        v.gain.gain.rampTo(l.a * k, 0.08);
      } else v.gain.gain.rampTo(0, 0.08);
    });
    this.bank.forEach((v, i) => v.gain.gain.rampTo(Math.min(0.05, bankAmps[i] * kb), 0.12));
  }
}
