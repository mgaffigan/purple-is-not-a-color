import * as Tone from 'tone';
import { nmToAudioHz, VISIBLE_NM } from '../axis';
import { qForOctaves } from '../audio/engine';
import { LINE_SIGMA, NM0, type Spectrum } from './spectra';

const LINE_AREA = LINE_SIGMA * Math.sqrt(2 * Math.PI);
const MAX_LINES = 8;
/** Broadband light → noise through this many band-pass filters across the visible octave. */
const BANDS = 24;
const BAND_Q = qForOctaves(1 / BANDS);
/** Tone's noise is stereo with independent channels, each uniform in [-1, 1] (variance 1/3).
 *  We fold it to mono (like the tones, identical in both speakers): averaging two
 *  uncorrelated channels halves the variance. */
const NOISE_VAR = 1 / 6;

// ---- perceived loudness (simple critical-band model) ----
const bark = (f: number) => 13 * Math.atan(0.00076 * f) + 3.5 * Math.atan((f / 7500) ** 2);
/** Excitation spread over the Bark scale (steep below, shallow above, like masking),
 *  then Stevens' power law per band. Relative units; only ratios matter. */
function loudness(comps: { z: number; p: number }[]): number {
  if (!comps.length) return 0;
  let zmin = Infinity, zmax = -Infinity;
  for (const c of comps) {
    zmin = Math.min(zmin, c.z);
    zmax = Math.max(zmax, c.z);
  }
  let N = 0;
  for (let z = zmin - 2; z <= zmax + 4; z += 0.1) {
    let E = 0;
    for (const c of comps) {
      const dz = z - c.z;
      E += c.p * Math.pow(10, -(dz < 0 ? -27 * dz : 12 * dz) / 10);
    }
    N += Math.pow(E, 0.23) * 0.1;
  }
  return N;
}

/** Only what we can see makes a sound: invisible light stays silent. */
function visibleWeight(nm: number) {
  const [lo, hi] = VISIBLE_NM;
  if (nm <= lo || nm >= hi) return 0;
  const edge = 25;
  if (nm < lo + edge) return 0.5 - 0.5 * Math.cos((Math.PI * (nm - lo)) / edge);
  if (nm > hi - edge) return 0.5 - 0.5 * Math.cos((Math.PI * (hi - nm)) / edge);
  return 1;
}

interface LineVoice {
  osc: Tone.Oscillator;
  gain: Tone.Gain;
}
interface Band {
  gain: Tone.Gain;
  filter: Tone.Filter;
  /** equivalent noise bandwidth of the band-pass, Hz (follows the light's width) */
  enbw: number;
  edges: [number, number]; // nm, long → short
}
/** Narrowest band-pass we'll tune to (a few-Hz-wide band ≈ a pure tone with a slow wobble). */
const MAX_Q = 1000; // 1 nm at 530 nm ≈ a 1 Hz band: essentially a pure tone

/**
 * Plays a light spectrum exactly 40 octaves down, the same way the sound lab works:
 * emission lines are pure sine tones; broadband light is white noise shaped by a
 * band-pass filter bank (an EQ), so sunlight sounds like band-limited white noise.
 *
 * Loudness: the spectrum's *shape* follows the light, but its overall level is set so
 * every spectrum is perceived about as loud as one pure line (power spread over several
 * critical bands sounds louder than the same power in one tone). A compressor at the end
 * catches transients while dragging or switching.
 */
export class Sonifier {
  private lines: LineVoice[] = [];
  private bands: Band[] = [];
  private bus: Tone.Gain;
  private bandZ: number[] = [];
  muted = false;
  private enabled = true;
  /** Level change applied to reach equal loudness (dB; negative = turned down). For inspection. */
  loudnessCorrectionDb = 0;
  /** peak amplitude of a single pure line (sets overall loudness) */
  level = 0.055; // same level as the sound lab's generator, below the intro recording

  constructor(out: Tone.InputNode) {
    // Safety net only: steady spectra peak below about −10 dBFS and never touch it, so the
    // loudness normalisation above stays exact. (Web Audio adds a fixed makeup gain.)
    const comp = new Tone.Compressor({ threshold: -6, ratio: 4, knee: 3, attack: 0.01, release: 0.25 }).connect(out);
    this.bus = new Tone.Gain(1).connect(comp);
    for (let i = 0; i < MAX_LINES; i++) {
      const gain = new Tone.Gain(0).connect(this.bus);
      const osc = new Tone.Oscillator(440, 'sine').connect(gain).start();
      this.lines.push({ osc, gain });
    }
    const [lo, hi] = VISIBLE_NM;
    for (let i = 0; i < BANDS; i++) {
      const e0 = hi * Math.pow(lo / hi, i / BANDS);
      const e1 = hi * Math.pow(lo / hi, (i + 1) / BANDS);
      const f = nmToAudioHz(Math.sqrt(e0 * e1));
      const gain = new Tone.Gain(0).connect(this.bus);
      const native = gain.input as unknown as GainNode; // fold stereo noise to mono
      native.channelCount = 1;
      native.channelCountMode = 'explicit';
      // independent noise per band, so band powers add (no coherent overlap between neighbours)
      const filter = new Tone.Filter({ type: 'bandpass', frequency: f, Q: BAND_Q }).connect(gain);
      new Tone.Noise('white').start().connect(filter);
      this.bands.push({ gain, filter, enbw: (Math.PI / 2) * (f / BAND_Q), edges: [e0, e1] });
      this.bandZ.push(bark(f));
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
    // visible power in each line and each band
    const linePow: { f: number; p: number }[] = [];
    const bandPow = new Array<number>(BANDS).fill(0);
    if (spec) {
      for (const l of spec.lines) {
        const p = l.p * LINE_AREA * visibleWeight(l.nm);
        if (p > 1e-6) linePow.push({ f: nmToAudioHz(l.nm), p });
      }
      this.bands.forEach((b, i) => {
        // power in this band, plus where it sits and how wide it is
        let s = 0, m1 = 0, m2 = 0;
        for (let nm = Math.ceil(b.edges[1]); nm <= Math.floor(b.edges[0]); nm++) {
          const w = (spec.broad[nm - NM0] ?? 0) * visibleWeight(nm);
          s += w;
          m1 += w * nm;
          m2 += w * nm * nm;
        }
        bandPow[i] = s;
        if (s <= 0) return;
        // Tune the filter to the light actually in the band: centred on it, and as narrow as it
        // is (equivalent-rectangle width). White light fills the band → the band's own width;
        // a 1 nm slice → a ~1 Hz band ≈ a pure tone.
        const mean = m1 / s;
        const widthNm = Math.max(1, Math.sqrt(12 * Math.max(0, m2 / s - mean * mean)));
        const fc = nmToAudioHz(mean);
        const q = Math.min(MAX_Q, Math.max(BAND_Q, mean / widthNm));
        b.filter.frequency.rampTo(fc, 0.05);
        b.filter.Q.rampTo(q, 0.05);
        b.enbw = (Math.PI / 2) * (fc / q);
        this.bandZ[i] = bark(fc);
      });
    }
    linePow.sort((a, b) => b.p - a.p);
    linePow.length = Math.min(linePow.length, MAX_LINES);
    const total = linePow.reduce((s, l) => s + l.p, 0) + bandPow.reduce((s, p) => s + p, 0);
    // Start from equal power (the whole spectrum gets the power of one pure line)…
    const target = (this.level * this.level) / 2;
    const nyquist = Tone.getContext().sampleRate / 2;
    const lineP = linePow.map((l) => (total > 0 ? (target * l.p) / total : 0));
    const bandP = bandPow.map((p) => (total > 0 ? (target * p) / total : 0));
    // …then scale to equal *loudness*: as loud as one pure line at 500 Hz.
    const comps = [
      ...linePow.map((l, i) => ({ z: bark(l.f), p: lineP[i] })),
      ...this.bandZ.map((z, i) => ({ z, p: bandP[i] })),
    ].filter((c) => c.p > 0);
    const N = loudness(comps);
    const ampScale = N > 0 ? Math.pow(loudness([{ z: bark(500), p: target }]) / N, 1 / (2 * 0.23)) : 0;
    this.loudnessCorrectionDb = ampScale > 0 ? 20 * Math.log10(ampScale) : 0;

    this.lines.forEach((v, i) => {
      const l = linePow[i];
      if (l && total > 0) {
        v.osc.frequency.rampTo(l.f, 0.03);
        v.gain.gain.rampTo(Math.sqrt(2 * lineP[i]) * ampScale, 0.08); // sine power = a²/2
      } else v.gain.gain.rampTo(0, 0.08);
    });
    this.bands.forEach((b, i) => {
      const got = (NOISE_VAR * b.enbw) / nyquist; // power out of the filter at unity gain
      b.gain.gain.rampTo(Math.sqrt(bandP[i] / got) * ampScale, 0.12);
    });
  }
}
