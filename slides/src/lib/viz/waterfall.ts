import type { LogAxis } from '../axis';
import { AutoCanvas } from './canvas';

type RGB = [number, number, number];

/** magma-ish colormap (yes, it passes through purple; that's the joke). */
const MAGMA: [number, string][] = [
  [0, '#000004'], [0.13, '#1c1044'], [0.25, '#4f127b'], [0.38, '#812581'],
  [0.5, '#b5367a'], [0.63, '#e55064'], [0.75, '#fb8761'], [0.88, '#fec287'], [1, '#fcfdbf'],
];
function hex(h: string): RGB {
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
}
export const MAGMA_LUT: Uint8ClampedArray = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < MAGMA.length - 2 && t > MAGMA[k + 1][0]) k++;
    const [t0, c0] = MAGMA[k];
    const [t1, c1] = MAGMA[k + 1];
    const a = (t - t0) / (t1 - t0);
    const A = hex(c0), B = hex(c1);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = A[c] + (B[c] - A[c]) * a;
  }
  return lut;
})();

export interface WaterfallOptions {
  axis: LogAxis;
  /** Optional per-column tint (x fraction → rgb 0..1). Without it, magma. */
  tint?: (xFrac: number) => RGB;
  minDb?: number;
  maxDb?: number;
}

/** Scrolling spectrogram: frequency left→right on a log axis, time flowing downward. */
export class Waterfall {
  readonly ac: AutoCanvas;
  private row!: ImageData;
  private values = new Float32Array(1);
  private binLo = new Float32Array(1);
  private binHi = new Float32Array(1);
  private tintLut: Float32Array | null = null;
  private binHz = 0;
  private dbBuf: Float32Array<ArrayBuffer> | null = null;
  private pow: Float32Array | null = null;
  minDb: number;
  maxDb: number;

  constructor(canvas: HTMLCanvasElement, readonly opts: WaterfallOptions) {
    this.ac = new AutoCanvas(canvas, true);
    this.minDb = opts.minDb ?? -105;
    this.maxDb = opts.maxDb ?? -25;
    this.ac.onResize(() => this.layout());
    this.layout();
  }

  get width() {
    return this.ac.w;
  }

  private layout() {
    const w = this.ac.w;
    this.row = this.ac.ctx.createImageData(w, 1);
    this.values = new Float32Array(w);
    this.binHz = 0; // force bin map recompute
    if (this.opts.tint) {
      this.tintLut = new Float32Array(w * 3);
      for (let x = 0; x < w; x++) {
        const c = this.opts.tint((x + 0.5) / w);
        this.tintLut.set(c, x * 3);
      }
    }
  }

  /** Number of rows pushed so far (handy for animated patterns). */
  rows = 0;

  /** Recompute the per-column tint (e.g. after the tint function's inputs change). */
  retint() {
    this.layout();
  }

  clear() {
    this.ac.ctx.fillStyle = '#000';
    this.ac.ctx.fillRect(0, 0, this.ac.w, this.ac.h);
  }

  /** Values per pixel column, 0..1. Fill then call push(). */
  get buffer() {
    return this.values;
  }

  /** Compute a row from an analyser (dB spectrum), then push it. */
  pushAnalyser(an: AnalyserNode) {
    const w = this.ac.w;
    const binHz = an.context.sampleRate / an.fftSize;
    if (!this.dbBuf || this.dbBuf.length !== an.frequencyBinCount) {
      this.dbBuf = new Float32Array(an.frequencyBinCount);
    }
    if (binHz !== this.binHz || this.binLo.length !== w) {
      this.binHz = binHz;
      this.binLo = new Float32Array(w);
      this.binHi = new Float32Array(w);
      for (let x = 0; x < w; x++) {
        this.binLo[x] = this.opts.axis.f(x, w) / binHz;
        this.binHi[x] = this.opts.axis.f(x + 1, w) / binHz;
      }
    }
    an.getFloatFrequencyData(this.dbBuf);
    const db = this.dbBuf;
    const n = db.length;
    // Work in linear power so every pixel shows power *density*: white noise is
    // flat, pink falls 3 dB/octave, whether a pixel is narrower or wider than a bin.
    if (!this.pow || this.pow.length !== n) this.pow = new Float32Array(n);
    const pow = this.pow;
    for (let i = 0; i < n; i++) pow[i] = Math.pow(10, db[i] / 10);
    const range = this.maxDb - this.minDb;
    for (let x = 0; x < w; x++) {
      // bin i covers [i - 0.5, i + 0.5) in bin units
      const lo = this.binLo[x], hi = this.binHi[x];
      let p: number;
      if (lo >= n - 1) p = 0;
      else if (hi - lo < 1) {
        const c = (lo + hi) / 2;
        const i = Math.floor(c), a = c - i;
        p = pow[i] * (1 - a) + pow[Math.min(n - 1, i + 1)] * a;
      } else {
        let sum = 0;
        const i0 = Math.max(0, Math.round(lo)), i1 = Math.min(n - 1, Math.round(hi));
        for (let i = i0; i <= i1; i++) {
          const ov = Math.min(hi, i + 0.5) - Math.max(lo, i - 0.5);
          if (ov > 0) sum += pow[i] * ov;
        }
        p = sum / (hi - lo);
      }
      const v = 10 * Math.log10(p + 1e-20);
      this.values[x] = Math.min(1, Math.max(0, (v - this.minDb) / range));
    }
    this.push();
  }

  /** Scroll down one row and paint this.values at the top. */
  push() {
    this.rows++;
    const { ctx, w, h } = this.ac;
    ctx.drawImage(ctx.canvas, 0, 0, w, h - 1, 0, 1, w, h - 1);
    const d = this.row.data;
    const vals = this.values;
    const tint = this.tintLut;
    for (let x = 0; x < w; x++) {
      const v = vals[x];
      if (tint) {
        const g = Math.pow(v, 0.8) * 255;
        d[x * 4] = tint[x * 3] * g;
        d[x * 4 + 1] = tint[x * 3 + 1] * g;
        d[x * 4 + 2] = tint[x * 3 + 2] * g;
      } else {
        const i = Math.round(v * 255) * 3;
        d[x * 4] = MAGMA_LUT[i];
        d[x * 4 + 1] = MAGMA_LUT[i + 1];
        d[x * 4 + 2] = MAGMA_LUT[i + 2];
      }
      d[x * 4 + 3] = 255;
    }
    ctx.putImageData(this.row, 0, 0);
  }
}
