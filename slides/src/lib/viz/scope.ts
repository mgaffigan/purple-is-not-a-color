import { AutoCanvas } from './canvas';

/** Oscilloscope: pressure (↕) over time (→), triggered on a rising zero crossing. */
export class Scope {
  readonly ac: AutoCanvas;
  private buf: Float32Array<ArrayBuffer> | null = null;
  /** visible window in seconds */
  windowSec = 0.03;
  gain = 3;

  constructor(canvas: HTMLCanvasElement) {
    this.ac = new AutoCanvas(canvas);
  }

  draw(an: AnalyserNode) {
    const { ctx, w, h } = this.ac;
    if (!this.buf || this.buf.length !== an.fftSize) this.buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(this.buf);
    const b = this.buf;
    const span = Math.min(b.length >> 1, Math.round(this.windowSec * an.context.sampleRate));
    let start = 0;
    for (let i = 1; i < b.length - span; i++) {
      if (b[i - 1] < 0 && b[i] >= 0) {
        start = i;
        break;
      }
    }
    ctx.clearRect(0, 0, w, h);
    // zero line
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    ctx.strokeStyle = '#7fe3ff';
    ctx.lineWidth = 2.5 * this.ac.dpr;
    ctx.shadowColor = '#3cc8ff';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    const step = Math.max(1, Math.floor(span / w));
    for (let x = 0; x < w; x++) {
      const i = start + Math.floor((x / w) * span);
      let v = 0;
      for (let k = 0; k < step; k++) v += b[i + k] ?? 0;
      v /= step;
      const y = h / 2 - Math.max(-1, Math.min(1, v * this.gain)) * (h / 2 - 4);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  /** RMS level in dBFS of the latest buffer (call after draw). */
  rmsDb(): number {
    if (!this.buf) return -120;
    let s = 0;
    for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
    return 10 * Math.log10(s / this.buf.length + 1e-12);
  }
}
