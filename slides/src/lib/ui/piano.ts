import { midiToHz, noteName, pointerFrac, type LogAxis } from '../axis';
import { AutoCanvas, FONT } from '../viz/canvas';

const BLACK = new Set([1, 3, 6, 8, 10]);
const isBlack = (m: number) => BLACK.has(((m % 12) + 12) % 12);
const LOW = 21; // A0
const HIGH = 108; // C8

export interface PianoHandlers {
  press: (midi: number) => void;
  move: (midi: number) => void;
  release: () => void;
}

/** 88-key keyboard where every key sits at its true log-frequency position,
 *  so it lines up with the waterfall columns above it. Hold a key for a tone;
 *  drag across keys and the pitch moves in discrete steps. */
export class Piano {
  readonly ac: AutoCanvas;
  private lit = new Map<number, number>(); // midi → time released (for fade)
  private down = false;
  private last: number | null = null;

  constructor(readonly el: HTMLCanvasElement, readonly axis: LogAxis, private handlers: PianoHandlers) {
    this.ac = new AutoCanvas(el);
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      this.down = true;
      this.hit(e);
    });
    el.addEventListener('pointermove', (e) => this.down && this.hit(e));
    const up = () => {
      if (!this.down) return;
      this.down = false;
      if (this.last !== null) this.lit.set(this.last, performance.now());
      this.last = null;
      this.handlers.release();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** semitone width in px */
  private get sw() {
    return this.ac.w * (this.axis.frac(midiToHz(61)) - this.axis.frac(midiToHz(60)));
  }
  private cx(m: number) {
    return this.axis.x(midiToHz(m), this.ac.w);
  }
  private whiteSpan(m: number): [number, number] {
    const s = this.sw;
    const l = this.cx(m) - s / 2 - (m > LOW && isBlack(m - 1) ? s / 2 : 0);
    const r = this.cx(m) + s / 2 + (m < HIGH && isBlack(m + 1) ? s / 2 : 0);
    return [l, r];
  }

  private keyAt(e: PointerEvent): number | null {
    const p = pointerFrac(e, this.el);
    const x = p.x * this.ac.w;
    const s = this.sw;
    const nearest = Math.round(
      69 + 12 * Math.log2(this.axis.freq(p.x) / 440),
    );
    if (p.y < 0.62) {
      for (const m of [nearest - 1, nearest, nearest + 1]) {
        if (m >= LOW && m <= HIGH && isBlack(m) && Math.abs(x - this.cx(m)) <= s / 2) return m;
      }
    }
    for (const m of [nearest - 2, nearest - 1, nearest, nearest + 1, nearest + 2]) {
      if (m < LOW || m > HIGH || isBlack(m)) continue;
      const [l, r] = this.whiteSpan(m);
      if (x >= l && x < r) return m;
    }
    return null;
  }

  private hit(e: PointerEvent) {
    const m = this.keyAt(e);
    if (m === null || m === this.last) return;
    const first = this.last === null;
    if (this.last !== null) this.lit.set(this.last, performance.now());
    this.last = m;
    if (first) this.handlers.press(m);
    else this.handlers.move(m);
  }

  draw() {
    const { ctx, w, h, dpr } = this.ac;
    const now = performance.now();
    ctx.clearRect(0, 0, w, h);
    const glow = (m: number) => {
      if (m === this.last) return 1;
      const t = this.lit.get(m);
      if (t === undefined) return 0;
      const a = 1 - (now - t) / 300;
      if (a <= 0) {
        this.lit.delete(m);
        return 0;
      }
      return a;
    };
    for (let m = LOW; m <= HIGH; m++) {
      if (isBlack(m)) continue;
      const [l, r] = this.whiteSpan(m);
      const g = glow(m);
      ctx.fillStyle = g ? `rgb(${255 - 80 * g},${255 - 30 * g},255)` : '#eceae4';
      ctx.fillRect(l + 0.5 * dpr, 0, r - l - dpr, h);
      if (m % 12 === 0 && r - l > 8 * dpr) {
        ctx.fillStyle = '#555';
        ctx.font = `${Math.min(12, (r - l) / dpr / 2.2) * dpr}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(noteName(m), (l + r) / 2, h - 3 * dpr);
      }
    }
    const s = this.sw;
    for (let m = LOW; m <= HIGH; m++) {
      if (!isBlack(m)) continue;
      const g = glow(m);
      ctx.fillStyle = g ? `rgb(${60 + 120 * g},${90 + 120 * g},${140 + 115 * g})` : '#16161a';
      ctx.fillRect(this.cx(m) - s * 0.45, 0, s * 0.9, h * 0.62);
    }
  }
}
