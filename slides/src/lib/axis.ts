/** Logarithmic frequency axis shared by every panel in a column, so a strip,
 *  a piano key and a waterfall column all line up at the same x. */
export class LogAxis {
  constructor(public readonly fmin: number, public readonly fmax: number) {}

  /** frequency → fraction 0..1 */
  frac(f: number): number {
    return Math.log(f / this.fmin) / Math.log(this.fmax / this.fmin);
  }
  /** fraction 0..1 → frequency */
  freq(frac: number): number {
    return this.fmin * Math.pow(this.fmax / this.fmin, frac);
  }
  x(f: number, width: number): number {
    return this.frac(f) * width;
  }
  f(x: number, width: number): number {
    return this.freq(x / width);
  }
}

/** Sound: a little below and above human hearing. */
export const SOUND_AXIS = new LogAxis(8, 24000);
export const HEARING_LOW = 20;
export const HEARING_HIGH = 20000;

/** Light, in THz: ~1200 nm (IR) to ~300 nm (UV). */
export const LIGHT_AXIS = new LogAxis(250, 1000);
export const C_NM_THZ = 299792.458; // nm·THz
export const nmToTHz = (nm: number) => C_NM_THZ / nm;
export const thzToNm = (thz: number) => C_NM_THZ / thz;
export const VISIBLE_NM: [number, number] = [380, 750];

/** The talk's light→sound mapping: down exactly 40 octaves. */
export const OCTAVE_SHIFT = 40;
export const nmToAudioHz = (nm: number) => (nmToTHz(nm) * 1e12) / 2 ** OCTAVE_SHIFT;

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const hzToMidi = (f: number) => 69 + 12 * Math.log2(f / 440);
export function noteName(midi: number): string {
  const m = Math.round(midi);
  return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}
/** "A4 +3¢" */
export function describeHz(f: number): string {
  const midi = hzToMidi(f);
  const cents = Math.round((midi - Math.round(midi)) * 100);
  const c = cents === 0 ? '' : ` ${cents > 0 ? '+' : '−'}${Math.abs(cents)}¢`;
  return noteName(midi) + c;
}
export function formatHz(f: number): string {
  if (f >= 1000) return `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz`;
  return `${f.toFixed(f < 100 ? 1 : 0)} Hz`;
}

/** Fraction of a pointer event across an element, robust to reveal's scaling. */
export function pointerFrac(e: PointerEvent | MouseEvent, el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
}
