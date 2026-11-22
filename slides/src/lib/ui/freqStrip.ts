import { pointerFrac, type LogAxis } from '../axis';
import { AutoCanvas, FONT } from '../viz/canvas';

export interface Region {
  from: number;
  to: number;
  label: string;
}
export interface StripOptions {
  axis: LogAxis;
  ticks: { f: number; label: string }[];
  regions?: Region[];
  /** per-x css color for the bar body (cached) */
  background?: (xFrac: number) => string;
  /** hover/readout label */
  format: (f: number) => string;
  /** marker colour for a given frequency */
  markerColor?: (f: number) => string;
}

export interface StripHandlers {
  press?: (f: number, shift: boolean) => void;
  move?: (f: number) => void;
  release?: () => void;
}

/** A continuous, clickable frequency ruler. Press & drag = glide. */
export class FreqStrip {
  readonly ac: AutoCanvas;
  private bg: HTMLCanvasElement | null = null;
  private hover: number | null = null;
  private active: number | null = null;
  private dirty = true;
  markers: number[] = [];
  private _showRegions = false;

  constructor(
    readonly el: HTMLCanvasElement,
    readonly opts: StripOptions,
    handlers: StripHandlers = {},
  ) {
    this.ac = new AutoCanvas(el);
    this.ac.onResize(() => {
      this.bg = null;
      this.dirty = true;
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const f = this.freqAt(e);
      if (e.shiftKey) {
        handlers.press?.(f, true);
        return;
      }
      el.setPointerCapture(e.pointerId);
      this.active = f;
      handlers.press?.(f, false);
      this.dirty = true;
    });
    el.addEventListener('pointermove', (e) => {
      const f = this.freqAt(e);
      this.hover = f;
      if (this.active !== null) {
        this.active = f;
        handlers.move?.(f);
      }
      this.dirty = true;
    });
    const end = () => {
      if (this.active === null) return;
      this.active = null;
      handlers.release?.();
      this.dirty = true;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => {
      this.hover = null;
      this.dirty = true;
    });
  }

  set showRegions(v: boolean) {
    if (v !== this._showRegions) {
      this._showRegions = v;
      this.dirty = true;
    }
  }
  setMarkers(m: number[]) {
    this.markers = m;
    this.dirty = true;
  }
  invalidate() {
    this.dirty = true;
  }

  private freqAt(e: PointerEvent) {
    return this.opts.axis.freq(pointerFrac(e, this.el).x);
  }

  private buildBg() {
    const { w, h } = this.ac;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    if (this.opts.background) {
      for (let x = 0; x < w; x++) {
        g.fillStyle = this.opts.background((x + 0.5) / w);
        g.fillRect(x, 0, 1, h);
      }
    } else {
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#2a2d3a');
      grad.addColorStop(1, '#171922');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
    }
    this.bg = c;
  }

  draw() {
    if (!this.dirty) return;
    this.dirty = false;
    const { ctx, w, h, dpr } = this.ac;
    const { axis } = this.opts;
    if (!this.bg) this.buildBg();
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.bg!, 0, 0);

    // regions: infra/ultra (sound) or IR/UV (light)
    if (this._showRegions && this.opts.regions) {
      for (const r of this.opts.regions) {
        const x0 = axis.x(Math.max(r.from, axis.fmin), w);
        const x1 = axis.x(Math.min(r.to, axis.fmax), w);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(x0, 0, x1 - x0, h);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, 0, x1 - x0, h);
        ctx.clip();
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 2 * dpr;
        for (let x = x0 - h; x < x1 + h; x += 10 * dpr) {
          ctx.beginPath();
          ctx.moveTo(x, h);
          ctx.lineTo(x + h, 0);
          ctx.stroke();
        }
        ctx.restore();
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = `600 ${14 * dpr}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const tw = ctx.measureText(r.label).width / 2 + 4 * dpr;
        ctx.fillText(r.label, Math.min(w - tw, Math.max(tw, (x0 + x1) / 2)), 4 * dpr);
      }
    }

    // ticks
    ctx.font = `${13 * dpr}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const t of this.opts.ticks) {
      const x = axis.x(t.f, w);
      if (x < 0 || x > w) continue;
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(Math.round(x), h * 0.62, dpr, h * 0.38);
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(t.label, Math.min(w - 20 * dpr, Math.max(20 * dpr, x)), h * 0.6);
    }

    // held markers + active
    const mark = (f: number, strong: boolean) => {
      const x = axis.x(f, w);
      ctx.fillStyle = this.opts.markerColor?.(f) ?? '#fff';
      ctx.shadowColor = ctx.fillStyle as string;
      ctx.shadowBlur = strong ? 12 : 6;
      ctx.fillRect(x - 1.5 * dpr, 0, 3 * dpr, h);
      ctx.shadowBlur = 0;
    };
    this.markers.forEach((f) => mark(f, false));
    if (this.active !== null) mark(this.active, true);

    // readout
    const rf = this.active ?? this.hover;
    if (rf !== null) {
      const x = axis.x(rf, w);
      const label = this.opts.format(rf);
      ctx.font = `600 ${15 * dpr}px ${FONT}`;
      const tw = ctx.measureText(label).width + 14 * dpr;
      const bx = Math.min(w - tw, Math.max(0, x - tw / 2));
      ctx.fillStyle = 'rgba(10,10,16,0.85)';
      ctx.fillRect(bx, h - 26 * dpr, tw, 24 * dpr);
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + tw / 2, h - 14 * dpr);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillRect(x - 0.5 * dpr, 0, dpr, h - 26 * dpr);
    }
  }
}
