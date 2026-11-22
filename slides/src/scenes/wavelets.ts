import { AutoCanvas } from '../lib/viz/canvas';
import { $c, type Scene } from '../lib/scene';

const CELL = 3; // css px per simulation cell
const BARRIER = 0.36; // barrier x as fraction of width
const SOURCES_PER_SLIT = 14;

/** Huygens: every point in a slit re-radiates a circular wavelet; their sum diffracts.
 *  Two slits, no controls — just something lovely to look at. */
export class WaveletScene implements Scene {
  private field: AutoCanvas;
  private rings: AutoCanvas;
  private img: ImageData | null = null;
  private re = new Float32Array(0);
  private im = new Float32Array(0);
  private gw = 0;
  private gh = 0;
  private readonly lambda = 26; // cells
  private dirty = true;
  private t0 = performance.now();
  private lut = new Uint8ClampedArray(256 * 3);

  constructor(readonly root: HTMLElement) {
    this.field = new AutoCanvas($c(root, 'canvas.field'));
    this.rings = new AutoCanvas($c(root, 'canvas.rings'));
    this.field.onResize(() => (this.dirty = true));
    // deep TARDIS blue → cyan → white
    const stops: [number, number[]][] = [
      [0, [2, 8, 28]], [0.45, [0, 59, 111]], [0.7, [40, 150, 220]], [1, [235, 250, 255]],
    ];
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let k = 0;
      while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
      const [t0, a] = stops[k], [t1, b] = stops[k + 1];
      const u = (t - t0) / (t1 - t0);
      for (let c = 0; c < 3; c++) this.lut[i * 3 + c] = a[c] + (b[c] - a[c]) * u;
    }
  }

  private slitCenters(): number[] {
    const mid = this.gh / 2;
    return [mid - this.lambda * 1.6, mid + this.lambda * 1.6];
  }
  private get slitWidth() {
    return this.lambda * 0.7;
  }

  private precompute() {
    const w = this.field.w, h = this.field.h;
    const dpr = this.field.dpr;
    this.gw = Math.max(2, Math.floor(w / (CELL * dpr)));
    this.gh = Math.max(2, Math.floor(h / (CELL * dpr)));
    const { gw, gh } = this;
    this.re = new Float32Array(gw * gh);
    this.im = new Float32Array(gw * gh);
    this.img = new ImageData(gw, gh);
    const k = (2 * Math.PI) / this.lambda;
    const bx = Math.floor(gw * BARRIER);
    const srcs: number[] = [];
    for (const c of this.slitCenters())
      for (let j = 0; j < SOURCES_PER_SLIT; j++)
        srcs.push(c + ((j + 0.5) / SOURCES_PER_SLIT - 0.5) * this.slitWidth);
    const norm = 1.6 / srcs.length;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        if (x < bx) {
          // incoming plane wave, phase-aligned so it arrives at the barrier with phase 0
          const ph = k * (x - bx);
          this.re[i] = Math.cos(ph);
          this.im[i] = Math.sin(ph);
        } else if (x === bx) {
          this.re[i] = this.im[i] = 0;
        } else {
          let r0 = 0, i0 = 0;
          const dx = x - bx;
          for (const sy of srcs) {
            const r = Math.hypot(dx, y - sy);
            const a = 1 / Math.sqrt(1 + r / this.lambda);
            r0 += a * Math.cos(k * r);
            i0 += a * Math.sin(k * r);
          }
          this.re[i] = r0 * norm;
          this.im[i] = i0 * norm;
        }
      }
    }
  }

  activate(on: boolean) {
    this.root.classList.toggle('active', on);
  }

  setStep() {}

  frame(now: number) {
    if (this.dirty) {
      this.dirty = false;
      this.precompute();
    }
    if (!this.img) return;
    const t = Math.max(0, now - this.t0) / 1000; // rAF time can precede t0 on the first frame
    const wt = t * 2 * Math.PI * 0.6;
    const c = Math.cos(wt), s = Math.sin(wt);
    const d = this.img.data;
    const { gw, gh } = this;
    const bx = Math.floor(gw * BARRIER);
    const centers = this.slitCenters();
    const half = this.slitWidth / 2;
    for (let i = 0, n = gw * gh; i < n; i++) {
      const v = this.re[i] * c + this.im[i] * s; // Re(A e^{-iωt})
      const u = Math.tanh(v * 1.4) * 0.5 + 0.5;
      const li = Math.round(u * 255) * 3;
      d[i * 4] = this.lut[li];
      d[i * 4 + 1] = this.lut[li + 1];
      d[i * 4 + 2] = this.lut[li + 2];
      d[i * 4 + 3] = 255;
    }
    // barrier
    for (let y = 0; y < gh; y++) {
      const open = centers.some((cy) => Math.abs(y - cy) < half);
      if (open) continue;
      for (let x = bx - 1; x <= bx + 1; x++) {
        const i = (y * gw + x) * 4;
        d[i] = 200; d[i + 1] = 200; d[i + 2] = 210;
      }
    }
    const ctx = this.field.ctx;
    // draw small then scale up smoothly
    const tmp = (this._tmp ??= document.createElement('canvas'));
    if (tmp.width !== gw || tmp.height !== gh) {
      tmp.width = gw;
      tmp.height = gh;
    }
    tmp.getContext('2d')!.putImageData(this.img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, 0, 0, this.field.w, this.field.h);

    // Huygens wavelet rings, emanating from each slit
    const rc = this.rings.ctx;
    const { w, h, dpr } = this.rings;
    rc.clearRect(0, 0, w, h);
    const sx = (bx + 0.5) * (w / gw);
    const scale = h / gh;
    const lam = this.lambda * scale;
    const phase = ((wt / (2 * Math.PI)) % 1) * lam;
    rc.lineWidth = 1.5 * dpr;
    for (const cy of centers) {
      const y = (cy + 0.5) * scale;
      for (let r = phase; r < w; r += lam) {
        const a = Math.max(0, 0.55 - r / (w * 0.9));
        if (a <= 0) break;
        rc.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`;
        rc.beginPath();
        rc.arc(sx, y, r, -Math.PI / 2, Math.PI / 2);
        rc.stroke();
      }
    }
  }
  private _tmp: HTMLCanvasElement | undefined;
}
