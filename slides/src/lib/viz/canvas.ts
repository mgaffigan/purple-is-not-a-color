/** Keeps a canvas backing store matched to its laid-out size.
 *  Resizes are debounced so CSS layout transitions stay smooth (the canvas
 *  just stretches while animating) and, optionally, old content is preserved. */
export class AutoCanvas {
  readonly ctx: CanvasRenderingContext2D;
  w = 1;
  h = 1;
  private timer = 0;
  private listeners: (() => void)[] = [];

  constructor(readonly canvas: HTMLCanvasElement, private preserve = false) {
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    if (!ctx) throw new Error('no 2d context');
    this.ctx = ctx;
    new ResizeObserver(() => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.resize(), 140);
    }).observe(canvas);
    this.resize();
  }

  get dpr() {
    return Math.min(2, window.devicePixelRatio || 1);
  }

  onResize(fn: () => void) {
    this.listeners.push(fn);
  }

  resize() {
    const w = Math.max(1, Math.round(this.canvas.offsetWidth * this.dpr));
    const h = Math.max(1, Math.round(this.canvas.offsetHeight * this.dpr));
    if (w === this.w && h === this.h) return;
    let old: HTMLCanvasElement | null = null;
    if (this.preserve && this.w > 1) {
      old = document.createElement('canvas');
      old.width = this.w;
      old.height = this.h;
      old.getContext('2d')!.drawImage(this.canvas, 0, 0);
    }
    this.canvas.width = this.w = w;
    this.canvas.height = this.h = h;
    if (old) {
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.drawImage(old, 0, 0, w, h);
    }
    this.listeners.forEach((fn) => fn());
  }
}

/** Canvas text can't use CSS variables. */
export const FONT = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
