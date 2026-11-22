import { pointerFrac, type LogAxis } from '../axis';
import { AutoCanvas, FONT } from './canvas';

export interface Handle {
  id: string;
  f: number;
  /** y as 0 (bottom) .. 1 (top) */
  y: number;
  label?: string;
  color?: string;
}

export interface CurveOptions {
  axis: LogAxis;
  /** response at each pixel column, as a 0..1 height fraction */
  heights: (freqs: Float32Array<ArrayBuffer>, out: Float32Array<ArrayBuffer>) => void;
  handles: () => Handle[];
  onDrag?: (id: string, f: number, y: number, dy: number) => void;
  onWheel?: (id: string, delta: number) => void;
  fill?: string | ((xFrac: number) => string);
  stroke?: string;
  gridLines?: { y: number; label: string }[];
  caption?: string;
}

/** A frequency-response plot on the shared log axis with draggable handles. */
export class ResponseCurve {
  readonly ac: AutoCanvas;
  private freqs = new Float32Array(1);
  private hs = new Float32Array(1);
  private drag: { id: string; y: number } | null = null;
  private dirty = true;
  private fillCanvas: HTMLCanvasElement | null = null;

  constructor(readonly el: HTMLCanvasElement, readonly opts: CurveOptions) {
    this.ac = new AutoCanvas(el);
    this.ac.onResize(() => this.layout());
    this.layout();
    el.addEventListener('pointerdown', (e) => {
      const p = pointerFrac(e, el);
      const hit = this.nearest(p.x, 1 - p.y);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      this.drag = { id: hit.id, y: 1 - p.y };
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const p = pointerFrac(e, el);
      const y = 1 - p.y;
      opts.onDrag?.(this.drag.id, opts.axis.freq(p.x), y, y - this.drag.y);
      this.drag.y = y;
    });
    const up = () => (this.drag = null);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener(
      'wheel',
      (e) => {
        const p = pointerFrac(e, el);
        const hit = this.nearest(p.x, 1 - p.y, 0.25);
        if (!hit || !opts.onWheel) return;
        e.preventDefault();
        e.stopPropagation();
        opts.onWheel(hit.id, Math.sign(e.deltaY));
      },
      { passive: false },
    );
  }

  private layout() {
    const w = this.ac.w;
    this.freqs = new Float32Array(w);
    this.hs = new Float32Array(w);
    for (let x = 0; x < w; x++) this.freqs[x] = this.opts.axis.f(x + 0.5, w);
    this.fillCanvas = null;
    this.dirty = true;
  }

  private nearest(xf: number, yf: number, maxDist = 0.12) {
    let best: Handle | null = null;
    let bd = maxDist;
    for (const h of this.opts.handles()) {
      const d = Math.hypot((this.opts.axis.frac(h.f) - xf) * 2.5, (h.y - yf) * 0.35);
      if (d < bd) {
        bd = d;
        best = h;
      }
    }
    return best;
  }

  invalidate() {
    this.dirty = true;
  }

  draw() {
    if (!this.dirty) return;
    this.dirty = false;
    const { ctx, w, h, dpr } = this.ac;
    const pad = 6 * dpr;
    const yOf = (v: number) => h - pad - v * (h - 2 * pad);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(0, 0, w, h);

    ctx.font = `${12 * dpr}px ${FONT}`;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    for (const g of this.opts.gridLines ?? []) {
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(0, Math.round(yOf(g.y)), w, dpr);
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText(g.label, 4 * dpr, yOf(g.y) - 2 * dpr);
    }

    this.opts.heights(this.freqs, this.hs);
    const path = new Path2D();
    path.moveTo(0, h);
    for (let x = 0; x < w; x++) path.lineTo(x, yOf(Math.max(0, Math.min(1, this.hs[x]))));
    path.lineTo(w, h);
    path.closePath();

    const fill = this.opts.fill ?? 'rgba(120,200,255,0.25)';
    if (typeof fill === 'string') {
      ctx.fillStyle = fill;
      ctx.fill(path);
    } else {
      if (!this.fillCanvas) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = 1;
        const g = c.getContext('2d')!;
        for (let x = 0; x < w; x++) {
          g.fillStyle = fill((x + 0.5) / w);
          g.fillRect(x, 0, 1, 1);
        }
        this.fillCanvas = c;
      }
      ctx.save();
      ctx.clip(path);
      ctx.drawImage(this.fillCanvas, 0, 0, w, h);
      ctx.restore();
    }
    ctx.strokeStyle = this.opts.stroke ?? '#9ad8ff';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const y = yOf(Math.max(0, Math.min(1, this.hs[x])));
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    for (const hd of this.opts.handles()) {
      const x = this.opts.axis.x(hd.f, w);
      const y = yOf(Math.max(0, Math.min(1, hd.y)));
      ctx.beginPath();
      ctx.arc(x, y, 9 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = hd.color ?? '#ffd166';
      ctx.fill();
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = '#111';
      ctx.stroke();
      if (hd.label) {
        ctx.fillStyle = '#111';
        ctx.font = `700 ${11 * dpr}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(hd.label, x, y + 0.5 * dpr);
      }
    }
    if (this.opts.caption) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = `600 ${13 * dpr}px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(this.opts.caption, w - 6 * dpr, 4 * dpr);
    }
  }
}
