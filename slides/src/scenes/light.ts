import { LIGHT_AXIS, VISIBLE_NM, nmToTHz, thzToNm } from '../lib/axis';
import { getEngine } from '../lib/audio/engine';
import {
  coneCurves, css, deuteranope, makeAdapter, xyzToSrgb, xyzToSrgbBright, type Vec3,
} from '../lib/light/cie';
import {
  LINE_SIGMA, NM0, PAINTS, POLY_RED, PURPLE, PURPLES, ROYGBIV, SOURCES, Spectrum, TWIN_RED, lumaOf,
  transmission, type OpticalFilter,
} from '../lib/light/spectra';
import { Sonifier } from '../lib/light/sonify';
import { Waterfall } from '../lib/viz/waterfall';
import { AutoCanvas, FONT } from '../lib/viz/canvas';
import { ResponseCurve } from '../lib/viz/curve';
import { FreqStrip } from '../lib/ui/freqStrip';
import { $, $c, type Scene } from '../lib/scene';

const SUN = SOURCES.Sunlight();
const adaptSun = makeAdapter(SUN.xyz());

// ---------- colour helpers ----------
const spectralCache = new Map<number, Vec3>();
/** Display colour of a pure wavelength, faded toward the edges of vision. */
function spectralColor(nm: number): Vec3 {
  const key = Math.round(nm * 2) / 2;
  let c = spectralCache.get(key);
  if (!c) {
    const xyz = Spectrum.line(key).xyz();
    if (xyz[1] < 1e-9) c = [0, 0, 0];
    else {
      const b = xyzToSrgbBright(adaptSun(xyz));
      const k = Math.min(1, Math.pow(xyz[1] / 0.3, 0.25));
      c = [b[0] * k, b[1] * k, b[2] * k];
    }
    spectralCache.set(key, c);
  }
  return c;
}
const isVisible = (nm: number) => nm >= VISIBLE_NM[0] && nm <= VISIBLE_NM[1];
const invisibleTint: Vec3 = [0.42, 0.42, 0.5];
const fracToNm = (frac: number) => thzToNm(LIGHT_AXIS.freq(frac));

/** What colour does this spectrum look like (brightness-normalised, gently faded if dim). */
function perceived(s: Spectrum): Vec3 {
  const xyz = s.xyz();
  if (!(xyz[1] > 1e-6)) return [0, 0, 0];
  const b = xyzToSrgbBright(adaptSun(xyz));
  // Only fade light that is genuinely near the edge of vision (beyond ~730 nm / below ~410 nm),
  // so deep red at 700 nm and purple stay vivid.
  const k = Math.min(1, Math.sqrt(xyz[1] / (0.003 * Math.max(1e-6, s.max()))));
  return [b[0] * k, b[1] * k, b[2] * k];
}
/** The eye's three bins, absolutely: each cone's sensitivity (peak = 1) applied to the light,
 *  at a fixed exposure where a unit-height line at the cone's peak wavelength = 1. No
 *  per-spectrum normalisation, so adding light can never lower a bin. */
const CONE_PEAK: Vec3 = (() => {
  const p: Vec3 = [0, 0, 0];
  for (let nm = 380; nm <= 780; nm++) {
    const c = coneCurves(nm);
    for (let k = 0; k < 3; k++) p[k] = Math.max(p[k], c[k]);
  }
  return p;
})();
function coneExcitation(s: Spectrum): Vec3 {
  const e: Vec3 = [0, 0, 0];
  const add = (nm: number, w: number) => {
    const c = coneCurves(nm);
    for (let k = 0; k < 3; k++) e[k] += (w * c[k]) / CONE_PEAK[k];
  };
  const LA = LINE_SIGMA * Math.sqrt(2 * Math.PI);
  for (let nm = 360; nm <= 830; nm++) {
    const v = s.broad[nm - NM0];
    if (v) add(nm, v / LA);
  }
  for (const l of s.lines) add(l.nm, l.p);
  return e;
}
/** One fixed photoreceptor-like compression (Naka–Rushton), 1 → 1, so dim signals stay visible. */
const compress = (x: number) => Math.min(1, (x * 1.35) / (x + 0.35));

/** How a surface with reflectance r looks under this light: relative to the
 *  light's own white, with partial adaptation (the eye adjusts, but not fully). */
function surfaceColor(illum: Spectrum, r: (nm: number) => number): Vec3 {
  const W = illum.xyz();
  if (!(W[1] > 1e-6)) return [0, 0, 0];
  const x = illum.filtered(r).xyz();
  return xyzToSrgb(makeAdapter(W, 0.65)([x[0] / W[1], x[1] / W[1], x[2] / W[1]]));
}

/** The eye's bins as drawn: contiguous over the visible range (never mind the real overlap). */
const BIN_REGIONS: { lo: number; hi: number; label: string; tint: Vec3 }[] = [
  { lo: 575, hi: VISIBLE_NM[1], label: 'red-ish', tint: [0.93, 0.25, 0.25] },
  { lo: 490, hi: 575, label: 'green-ish', tint: [0.25, 0.82, 0.38] },
  { lo: VISIBLE_NM[0], hi: 490, label: 'blue-ish', tint: [0.3, 0.45, 1] },
];
const LUMA_TINT: Vec3 = [0.9, 0.9, 0.9];
const LUMA_PX = 80; // css px for the luma column at the right edge
const LINE_AREA = LINE_SIGMA * Math.sqrt(2 * Math.PI);

/** width slider 0..1000 ↔ 4..250 nm (log) */
const sliderToNm = (v: number) => 4 * Math.pow(250 / 4, v / 1000);
const nmToSlider = (w: number) => (1000 * Math.log(w / 4)) / Math.log(250 / 4);

type Stage = 'A' | 'B' | 'C' | 'purple';

export class LightScene implements Scene {
  private engine = getEngine();
  private sonifier: Sonifier | null = null;
  private wfIn: Waterfall;
  private wfOut: Waterfall;
  private strip: FreqStrip;
  private filterCurve: ResponseCurve;
  private itis: AutoCanvas;
  private wfBins: Waterfall;
  private binLabels: AutoCanvas;
  private binRegion = new Int8Array(1); // per column: -2 gap, -1 hatch, 0..2 bins, 3 luma
  private binVals = [0, 0, 0, 0];
  private binsEl: HTMLCanvasElement;
  private swIn: HTMLElement;
  private swOut: HTMLElement;
  private stage: Stage | '' = '';
  private active = false;
  private colorBlind = false;

  private input = new Spectrum();
  private filter: OpticalFilter = { kind: 'none', nm: 530, width: 40, paint: 0 };
  private output = new Spectrum();
  private rowIn: Float32Array = new Float32Array(1);
  private rowOut: Float32Array = new Float32Array(1);
  private rowsDirty = true;
  private sourceName: string | null = null;
  private dragLine: number | null = null;

  constructor(readonly root: HTMLElement) {
    const inCol = $(root, '.col.in');
    const outCol = $(root, '.col.out');
    const tint = (frac: number): Vec3 => {
      const nm = fracToNm(frac);
      if (!isVisible(nm)) return invisibleTint;
      const c = spectralColor(nm);
      const m = Math.max(c[0], c[1], c[2], 0.25);
      return [c[0] / m, c[1] / m, c[2] / m];
    };
    this.wfIn = new Waterfall($c(inCol, 'canvas.wf'), { axis: LIGHT_AXIS, tint });
    this.wfOut = new Waterfall($c(outCol, 'canvas.wf'), { axis: LIGHT_AXIS, tint });
    this.wfIn.ac.onResize(() => (this.rowsDirty = true));
    this.wfOut.ac.onResize(() => (this.rowsDirty = true));
    this.binsEl = $c(outCol, 'canvas.bins');
    this.wfBins = new Waterfall(this.binsEl, { axis: LIGHT_AXIS, tint: (f) => this.binTint(f) });
    this.wfBins.ac.onResize(() => this.layoutBins());
    this.binLabels = new AutoCanvas($c(outCol, 'canvas.bins-labels'));
    this.binLabels.onResize(() => this.drawBinLabels());
    this.layoutBins();
    this.itis = new AutoCanvas($c(inCol, 'canvas.itis'));
    this.itis.onResize(() => this.drawItIs());
    this.swIn = $(inCol, '.see-wrap .swatch');
    this.swOut = $(outCol, '.swatch');

    this.strip = new FreqStrip(
      $c(inCol, 'canvas.strip'),
      {
        axis: LIGHT_AXIS,
        ticks: [1200, 1000, 800, 700, 600, 500, 450, 400, 350, 300].map((nm) => ({
          f: nmToTHz(nm),
          label: `${nm}`,
        })),
        regions: [
          { from: 1, to: nmToTHz(VISIBLE_NM[1]), label: 'infrared' },
          { from: nmToTHz(VISIBLE_NM[0]), to: 1e5, label: 'ultraviolet' },
        ],
        background: (frac) => {
          const nm = fracToNm(frac);
          if (!isVisible(nm)) return '#24242c';
          return css(spectralColor(nm));
        },
        format: (thz) => `${thzToNm(thz).toFixed(0)} nm · ${thz.toFixed(0)} THz`,
        markerColor: () => '#ffffff',
      },
      {
        press: (thz, shift) => {
          const nm = thzToNm(thz);
          if (shift) this.toggleLine(nm);
          else {
            this.dragLine = nm;
            this.setInput(Spectrum.line(nm), null);
          }
        },
        move: (thz) => {
          if (this.dragLine === null) return;
          this.dragLine = thzToNm(thz);
          this.setInput(Spectrum.line(this.dragLine), null);
        },
        release: () => (this.dragLine = null),
      },
    );

    this.filterCurve = new ResponseCurve($c(outCol, 'canvas.filter'), {
      axis: LIGHT_AXIS,
      heights: (freqs, out) => {
        const t = transmission(this.filter);
        for (let i = 0; i < freqs.length; i++) out[i] = t(thzToNm(freqs[i])) * 0.92;
      },
      handles: () =>
        this.filter.kind === 'bandpass'
          ? [{ id: 'bp', f: nmToTHz(this.filter.nm), y: 0.92, color: '#fff' }]
          : [],
      onDrag: (_id, thz, _y, dy) => {
        const width = Math.max(4, Math.min(250, this.filter.width * Math.pow(2, -dy * 3)));
        this.setFilter({ ...this.filter, nm: thzToNm(thz), width });
      },
      onWheel: (_id, d) =>
        this.setFilter({ ...this.filter, width: Math.max(4, Math.min(250, this.filter.width * Math.pow(1.15, d))) }),
      fill: (frac) => {
        const nm = fracToNm(frac);
        const c = isVisible(nm) ? spectralColor(nm) : invisibleTint;
        return `rgba(${c.map((x) => Math.round(x * 255)).join(',')},0.55)`;
      },
      stroke: '#ddd',
      caption: 'filter',
    });

    this.wireChips();
    const slider = this.root.querySelector<HTMLInputElement>('.flt .width input')!;
    slider.addEventListener('input', () =>
      this.setFilter({ ...this.filter, kind: 'bandpass', width: sliderToNm(+slider.value) }),
    );
    slider.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  // ---------- state changes ----------
  private setInput(s: Spectrum, sourceName: string | null) {
    this.input = s;
    this.sourceName = sourceName;
    this.recompute();
  }
  private toggleLine(nm: number) {
    const lines = this.input.lines.filter((l) => Math.abs(l.nm - nm) > 4);
    if (lines.length === this.input.lines.length) lines.push({ nm, p: 1 });
    this.setInput(new Spectrum(lines, this.sourceName ? new Spectrum().broad : this.input.broad), null);
  }
  private setFilter(f: OpticalFilter) {
    this.filter = f;
    this.filterCurve.invalidate();
    this.recompute();
  }
  private recompute() {
    const usesFilter = this.stage === 'B' || this.stage === 'C';
    this.output = usesFilter ? this.input.filtered(transmission(this.filter)) : this.input;
    this.filterCurve.opts.caption = this.filter.kind === 'paint' ? 'paint: what it reflects' : 'filter';
    this.filterCurve.invalidate();
    this.rowsDirty = true;
    this.strip.setMarkers(this.input.lines.length <= 8 ? this.input.lines.map((l) => nmToTHz(l.nm)) : []);
    this.paintSwatches();
    this.drawItIs();
    this.updateSound();
    this.syncChips();
  }

  private paintSwatches() {
    const fix = (c: Vec3) => (this.colorBlind ? deuteranope(c) : c);
    this.swIn.style.background = css(fix(perceived(this.input)));
    // a paint is seen as a surface (with its lightness), not as a light source
    const isPaint = this.filter.kind === 'paint' && (this.stage === 'B' || this.stage === 'C');
    const out = isPaint ? surfaceColor(this.input, PAINTS[this.filter.paint].r) : perceived(this.output);
    this.swOut.style.background = css(fix(out));
    // what the brain gets: three colour bins + brightness
    const b = coneExcitation(this.output).map(compress);
    this.binVals = this.colorBlind ? [(b[0] + b[1]) / 2, (b[0] + b[1]) / 2, b[2], 0] : [b[0], b[1], b[2], 0];
    this.binVals[3] = compress(lumaOf(this.output));
  }

  private updateSound() {
    if (!this.sonifier) return;
    let s: Spectrum | null = null;
    if (this.stage === 'B' || this.stage === 'C') s = this.output;
    else s = this.input;
    this.sonifier.set(this.active ? s : null);
  }

  private ensureSonifier() {
    if (!this.sonifier && this.engine?.armed) {
      this.sonifier = new Sonifier(this.engine.lightBus);
      this.sonifier.setEnabled(this.active);
    }
  }
  onArmed() {
    this.ensureSonifier();
    this.updateSound();
  }

  // ---------- chips ----------
  private wireChips() {
    this.root.querySelectorAll<HTMLButtonElement>('.color-chip').forEach((b) => {
      const nm = +b.dataset.nm!;
      b.style.setProperty('--chip', css(spectralColor(nm)));
    });
    this.root.querySelectorAll<HTMLButtonElement>('.chips button').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const d = b.dataset;
        if (d.act === 'tones') {
          this.ensureSonifier();
          this.sonifier?.toggleMute();
          this.syncChips();
        } else if (d.act === 'stop') this.setInput(new Spectrum(), null);
        else if (d.nm) {
          if (e.shiftKey) this.toggleLine(+d.nm);
          else this.setInput(Spectrum.line(+d.nm), null);
        } else if (d.source) this.setInput(SOURCES[d.source](), d.source);
        else if (d.mix === 'poly') this.setInput(POLY_RED(), 'poly');
        else if (d.mix === 'twin') this.setInput(TWIN_RED(), 'twin');
        else if (d.purple) this.setInput(PURPLES.find((p) => p.id === d.purple)!.spec(), d.purple);
        else if (d.paint) this.setFilter({ ...this.filter, kind: 'paint', paint: +d.paint });
        else if (d.filter) {
          const kind = d.filter as OpticalFilter['kind'];
          this.setFilter({ ...this.filter, kind });
        }
      });
    });
  }
  private syncChips() {
    this.root.querySelectorAll<HTMLButtonElement>('.chips button').forEach((b) => {
      const d = b.dataset;
      let on = false;
      if (d.nm) on = this.input.lines.some((l) => Math.abs(l.nm - +d.nm!) < 0.5) && !this.sourceName;
      if (d.source) on = this.sourceName === d.source;
      if (d.mix) on = this.sourceName === d.mix;
      if (d.purple) on = this.sourceName === d.purple;
      if (d.filter) on = this.filter.kind === d.filter;
      if (d.paint) {
        on = this.filter.kind === 'paint' && this.filter.paint === +d.paint;
        // live dot: this paint's colour under the current light
        b.style.setProperty('--chip', css(surfaceColor(this.input, PAINTS[+d.paint].r)));
      }
      b.classList.toggle('on', on);
    });
    this.root.classList.toggle('bandpass-on', this.filter.kind === 'bandpass');
    const slider = this.root.querySelector<HTMLInputElement>('.flt .width input')!;
    slider.value = String(nmToSlider(this.filter.width));
    this.root.querySelector('.flt .width output')!.textContent = `${Math.round(this.filter.width)} nm`;
    this.root.querySelector('.tone-ind')!.classList.toggle('muted', !!this.sonifier?.muted);
  }

  // ---------- bins: a waterfall with very unusual binning ----------
  private binTint(frac: number): Vec3 {
    // (called while the waterfall is being constructed, so use the element's size)
    if (frac >= 1 - LUMA_PX / Math.max(1, this.binsEl.offsetWidth)) return LUMA_TINT;
    const nm = fracToNm(frac);
    const i = BIN_REGIONS.findIndex((r) => nm >= r.lo && nm < r.hi);
    if (i < 0) return [0, 0, 0];
    // colour-blind: red-ish and green-ish become one (yellowish) bin
    if (this.colorBlind && i < 2) return [0.85, 0.75, 0.3];
    return BIN_REGIONS[i].tint;
  }
  private layoutBins() {
    const w = this.wfBins.width;
    const lumaX = w - LUMA_PX * this.wfBins.ac.dpr;
    const reg = new Int8Array(w);
    for (let x = 0; x < w; x++) {
      if (x >= lumaX) reg[x] = 3;
      else {
        const nm = fracToNm((x + 0.5) / w);
        reg[x] = BIN_REGIONS.findIndex((r) => nm >= r.lo && nm < r.hi);
      }
    }
    // thin dark gaps between bins make the binning obvious
    const gap = Math.max(2, Math.round(3 * this.wfBins.ac.dpr));
    for (let x = w - 1; x > 0; x--) if (reg[x] !== reg[x - 1] && reg[x] !== -2) for (let k = 0; k < gap && x + k < w; k++) reg[x + k] = -2;
    this.binRegion = reg;
    this.drawBinLabels();
  }
  private fillBinRow() {
    const buf = this.wfBins.buffer;
    const reg = this.binRegion;
    if (reg.length !== buf.length) return;
    for (let x = 0; x < buf.length; x++) {
      const r = reg[x];
      // gaps and the infrared/ultraviolet space stay empty: the eye sends nothing for them
      buf[x] = r < 0 ? 0 : this.binVals[r];
    }
    this.wfBins.push();
  }
  private drawBinLabels() {
    const { ctx, w, h, dpr } = this.binLabels;
    ctx.clearRect(0, 0, w, h);
    const lumaX = w - LUMA_PX * dpr;
    const label = (text: string, x0: number, x1: number) => {
      ctx.font = `600 ${15 * dpr}px ${FONT}`;
      const tw = ctx.measureText(text).width + 14 * dpr;
      const cx = (x0 + x1) / 2;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(cx - tw / 2, h - 34 * dpr, tw, 24 * dpr);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, cx, h - 22 * dpr);
    };
    for (const r of BIN_REGIONS) {
      const x0 = LIGHT_AXIS.x(nmToTHz(r.hi), w), x1 = LIGHT_AXIS.x(nmToTHz(r.lo), w);
      label(this.colorBlind && r.lo >= 490 ? 'red/green' : r.label, x0, x1);
    }
    label('luma', lumaX, w);
    // reserved, empty space: say so quietly (static, so it doesn't look like a signal)
    ctx.font = `500 ${14 * dpr}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const ir1 = LIGHT_AXIS.x(nmToTHz(VISIBLE_NM[1]), w), uv0 = LIGHT_AXIS.x(nmToTHz(VISIBLE_NM[0]), w);
    ctx.fillText('infrared: nothing', ir1 / 2, h / 2);
    if (lumaX - uv0 > 90 * dpr) ctx.fillText('UV: nothing', (uv0 + lumaX) / 2, h / 2);
  }

  // ---------- "what it is": the input's power, as area, in its own colours ----------
  private drawItIs() {
    const { ctx, w, h, dpr } = this.itis;
    ctx.clearRect(0, 0, w, h);
    const s = this.input;
    // power per nm, long → short wavelength (matches the axis: red left, violet right)
    const lo = 300, hi = 1200;
    const p = new Float64Array(hi - lo + 1);
    for (let nm = lo; nm <= hi; nm++) p[nm - lo] = s.broad[nm - NM0] ?? 0;
    for (const l of s.lines) {
      const i = Math.round(l.nm) - lo;
      if (i >= 0 && i < p.length) p[i] += l.p * LINE_AREA;
    }
    const total = p.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return;
    let x = 0;
    const hatch: [number, number][] = [];
    for (let nm = hi; nm >= lo; nm--) {
      const dw = (p[nm - lo] / total) * w;
      if (dw <= 0) continue;
      if (isVisible(nm)) {
        const c = spectralColor(nm);
        const m = Math.max(c[0], c[1], c[2], 1e-6);
        ctx.fillStyle = css([c[0] / m, c[1] / m, c[2] / m]);
        ctx.fillRect(x, 0, dw + 0.6, h);
      } else {
        const last = hatch[hatch.length - 1];
        if (last && Math.abs(last[1] - x) < 0.01) last[1] = x + dw;
        else hatch.push([x, x + dw]);
      }
      x += dw;
    }
    for (const [x0, x1] of hatch) {
      ctx.fillStyle = '#24242c';
      ctx.fillRect(x0, 0, x1 - x0, h);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, x1 - x0, h);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 2 * dpr;
      for (let k = x0 - h; k < x1 + h; k += 10 * dpr) {
        ctx.beginPath();
        ctx.moveTo(k, h);
        ctx.lineTo(k + h, 0);
        ctx.stroke();
      }
      ctx.restore();
      const text = x0 < w / 2 ? 'infrared' : 'ultraviolet';
      ctx.font = `600 ${14 * dpr}px ${FONT}`;
      if (x1 - x0 > ctx.measureText(text).width + 16 * dpr) {
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(text, (x0 + x1) / 2, h - 8 * dpr);
      }
    }
  }

  // ---------- scene interface ----------
  activate(on: boolean) {
    this.active = on;
    this.root.classList.toggle('active', on);
    this.ensureSonifier();
    this.sonifier?.setEnabled(on);
    if (on) this.rowsDirty = true;
    this.updateSound();
  }

  setStep(stage: string, build: number) {
    const prev = this.stage;
    this.stage = stage as Stage;
    this.root.dataset.stage = stage;
    this.root.dataset.build = String(build);
    this.strip.showRegions = true;

    if (stage !== prev) {
      // sensible starting points for each step
      if (stage === 'A' && this.input.empty) this.setInput(Spectrum.line(650), null);
      if (stage === 'B') {
        this.setInput(SUN, 'Sunlight');
        this.filter = { kind: 'bandpass', nm: 530, width: 40, paint: 0 };
        this.filterCurve.invalidate();
      }
      if (stage === 'C') {
        this.filter = { kind: 'none', nm: 530, width: 40, paint: 0 };
        this.filterCurve.invalidate();
        this.setInput(TWIN_RED(), 'twin');
      }
      if (stage === 'purple' && !PURPLES.some((p) => p.id === this.sourceName)) this.setInput(PURPLE(), PURPLES[0].id);
    }
    this.recompute();
  }

  frame() {
    if (this.rowsDirty) {
      this.rowsDirty = false;
      this.rowIn = this.fillRow(this.wfIn, this.input, this.rowIn);
      this.rowOut = this.fillRow(this.wfOut, this.output, this.rowOut, this.input.max());
    }
    this.pushRow(this.wfIn, this.rowIn);
    if (this.stage === 'B') this.pushRow(this.wfOut, this.rowOut);
    if (this.stage === 'C' || this.stage === 'purple') this.fillBinRow();
    this.strip.draw();
    this.filterCurve.draw();
  }

  private fillRow(wf: Waterfall, s: Spectrum, into: Float32Array, scaleMax?: number) {
    const w = wf.width;
    const row = into.length === w ? into : new Float32Array(w);
    const m = Math.max(1e-6, scaleMax ?? s.max());
    for (let x = 0; x < w; x++) row[x] = Math.min(1, s.at(fracToNm((x + 0.5) / w)) / m);
    return row;
  }
  private pushRow(wf: Waterfall, row: Float32Array) {
    if (row.length !== wf.width) {
      this.rowsDirty = true;
      return;
    }
    wf.buffer.set(row);
    wf.push();
  }

  key(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    if (k === 't') {
      this.ensureSonifier();
      this.sonifier?.toggleMute();
      this.syncChips();
      return true;
    }
    if (k === 'c') {
      this.colorBlind = !this.colorBlind;
      this.root.classList.toggle('cb', this.colorBlind);
      this.wfBins.retint();
      this.layoutBins();
      this.recompute();
      return true;
    }
    const i = '1234567'.indexOf(e.key);
    if (i >= 0) {
      const c = ROYGBIV[i];
      this.setInput(Spectrum.line(c.nm), null);
      return true;
    }
    return false;
  }
}
