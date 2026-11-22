import { cmf, xyzToLms, type Vec3 } from './cie';

export const NM0 = 300;
export const NM1 = 1200;
const N = NM1 - NM0 + 1;
export const LINE_SIGMA = 1.5;
const LINE_AREA = LINE_SIGMA * Math.sqrt(2 * Math.PI);

export interface Line {
  nm: number;
  /** peak height (same units as the broadband curve) */
  p: number;
}

/** A light spectrum: discrete emission lines + a broadband curve (1 nm grid). */
export class Spectrum {
  constructor(
    public lines: Line[] = [],
    public broad: Float32Array = new Float32Array(N),
  ) {}

  static line(nm: number, p = 1) {
    return new Spectrum([{ nm, p }]);
  }
  static lines(...ls: [number, number][]) {
    return new Spectrum(ls.map(([nm, p]) => ({ nm, p })));
  }
  static fn(f: (nm: number) => number) {
    const b = new Float32Array(N);
    for (let i = 0; i < N; i++) b[i] = f(NM0 + i);
    return new Spectrum([], b);
  }
  static blackbody(T: number, peakAt560 = 1) {
    const planck = (nm: number) => Math.pow(nm, -5) / (Math.exp(1.4388e7 / (nm * T)) - 1);
    const k = peakAt560 / planck(560);
    return Spectrum.fn((nm) => planck(nm) * k);
  }
  static gauss(center: number, sigma: number, p = 1) {
    return Spectrum.fn((nm) => p * Math.exp(-0.5 * ((nm - center) / sigma) ** 2));
  }

  get empty() {
    return this.lines.length === 0 && !this.broad.some((v) => v > 0);
  }

  plus(o: Spectrum, k = 1) {
    const b = new Float32Array(N);
    for (let i = 0; i < N; i++) b[i] = this.broad[i] + k * o.broad[i];
    return new Spectrum([...this.lines, ...o.lines.map((l) => ({ nm: l.nm, p: l.p * k }))], b);
  }
  scaled(k: number) {
    return new Spectrum([], new Float32Array(N)).plus(this, k);
  }
  filtered(t: (nm: number) => number) {
    const b = new Float32Array(N);
    for (let i = 0; i < N; i++) b[i] = this.broad[i] * t(NM0 + i);
    return new Spectrum(this.lines.map((l) => ({ nm: l.nm, p: l.p * t(l.nm) })), b);
  }

  /** display value at a wavelength */
  at(nm: number) {
    let v = 0;
    const f = nm - NM0;
    if (f >= 0 && f < N - 1) {
      const i = Math.floor(f), a = f - i;
      v = this.broad[i] * (1 - a) + this.broad[i + 1] * a;
    }
    for (const l of this.lines) {
      const d = (nm - l.nm) / LINE_SIGMA;
      if (d > -5 && d < 5) v += l.p * Math.exp(-0.5 * d * d);
    }
    return v;
  }

  max() {
    let m = 0;
    for (let i = 0; i < N; i++) m = Math.max(m, this.broad[i]);
    for (const l of this.lines) m = Math.max(m, this.at(l.nm));
    return m;
  }

  /** CIE XYZ (unnormalised) */
  xyz(): Vec3 {
    const out: Vec3 = [0, 0, 0];
    for (let nm = 360; nm <= 830; nm++) {
      const v = this.broad[nm - NM0];
      if (!v) continue;
      const c = cmf(nm);
      out[0] += v * c[0];
      out[1] += v * c[1];
      out[2] += v * c[2];
    }
    for (const l of this.lines) {
      const c = cmf(l.nm);
      out[0] += l.p * LINE_AREA * c[0];
      out[1] += l.p * LINE_AREA * c[1];
      out[2] += l.p * LINE_AREA * c[2];
    }
    return out;
  }
  lms(): Vec3 {
    return xyzToLms(this.xyz());
  }
}

/** Brightness to the eye (luminance), in units of a unit-height line at 555 nm = 1. */
export const lumaOf = (s: Spectrum) => s.xyz()[1] / LINE_AREA;
/** Scale a spectrum to a given brightness (like dimming a lamp). */
export const atLuma = (s: Spectrum, target: number) => {
  const y = lumaOf(s);
  return y > 0 ? s.scaled(target / y) : s;
};
/** Every lamp is set to the same brightness at the source (an input choice, not display normalisation). */
const LAMP_LUMA = 0.6;

// ---------- sources ----------
export const ROYGBIV: { name: string; nm: number }[] = [
  { name: 'Red', nm: 650 },
  { name: 'Orange', nm: 605 },
  { name: 'Yellow', nm: 580 },
  { name: 'Green', nm: 530 },
  { name: 'Blue', nm: 470 },
  { name: 'Indigo', nm: 445 },
  { name: 'Violet', nm: 410 },
];

const RAW_SOURCES: Record<string, () => Spectrum> = {
  Sunlight: () => Spectrum.blackbody(5778, 0.85),
  Incandescent: () => Spectrum.blackbody(2700, 0.35),
  // High-pressure sodium streetlight: the D lines are pressure-broadened into a wide
  // golden hump with a self-absorbed dip at 589 nm, plus weaker sodium lines, strong
  // 819 nm infrared, and faint mercury lines from the amalgam.
  'Sodium lamp': () =>
    Spectrum.fn((nm) => {
      const g = (c: number, w: number, p: number) => p * Math.exp(-0.5 * ((nm - c) / w) ** 2);
      const hump = g(580, 9, 0.9) + g(598, 11, 1) + g(590, 28, 0.22);
      const selfAbsorbed = 1 - 0.92 * Math.exp(-0.5 * ((nm - 589.3) / 2.2) ** 2);
      return hump * selfAbsorbed + g(568.5, 1.8, 0.35) + g(616, 2.2, 0.3) + g(498, 1.5, 0.1) + g(819, 4, 0.55);
    }).plus(Spectrum.lines([436, 0.06], [546, 0.05])),
  // Tri-phosphor tube: mercury lines + the narrow europium-red (611) and terbium-green (543)
  // phosphor peaks (a few nm wide: tones, not noise), a broad blue phosphor, faint continuum.
  Fluorescent: () =>
    Spectrum.lines([365, 0.25], [405, 0.3], [436, 0.75], [546, 1], [578, 0.2], [611, 1.42], [543, 0.9])
      .plus(Spectrum.gauss(450, 18, 0.08))
      .plus(Spectrum.fn((nm) => (nm > 400 && nm < 720 ? 0.006 : 0))),
  'White LED': () => Spectrum.gauss(450, 10, 1).plus(Spectrum.gauss(565, 55, 0.5)),
};
export const SOURCES: Record<string, () => Spectrum> = Object.fromEntries(
  Object.entries(RAW_SOURCES).map(([k, f]) => [k, () => atLuma(f(), LAMP_LUMA)]),
);

/** Find non-negative weights for lines a,b so the mix matches a target's colour (least squares on XYZ). */
export function matchMix(target: Spectrum, nms: number[]): Spectrum {
  const t = target.xyz();
  const cols = nms.map((nm) => Spectrum.line(nm).xyz());
  // normal equations for 2 or 3 unknowns
  const n = cols.length;
  const A: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => cols[i][0] * cols[j][0] + cols[i][1] * cols[j][1] + cols[i][2] * cols[j][2]),
  );
  const bvec = cols.map((c) => c[0] * t[0] + c[1] * t[1] + c[2] * t[2]);
  const w = solve(A, bvec).map((x) => Math.max(0, x));
  return Spectrum.lines(...nms.map((nm, i) => [nm, w[i]] as [number, number]));
}
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let k2 = c; k2 <= n; k2++) M[r][k2] -= k * M[c][k2];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/** Purple: the lowest and highest colours we see, together. 700/400 = 7:4 (a harmonic
 *  seventh). The 0.45 violet:red ratio is the most vivid on screen. */
export const PURPLE = () => atLuma(Spectrum.lines([700, 1], [400, 0.45]), 0.12);
/** A polychromatic red. Its pure twin is found with dominantNm(). */
export const POLY_RED = () => Spectrum.lines([620, 0.45], [690, 1]);

const chroma = (s: Spectrum) => {
  const x = s.xyz();
  const t = x[0] + x[1] + x[2] || 1;
  return [x[0] / t, x[1] / t];
};
/** The single wavelength whose colour is closest to this spectrum's. */
export function dominantNm(s: Spectrum): number {
  const t = chroma(s);
  let best = 550, bd = Infinity;
  for (let nm = 380; nm <= 720; nm += 0.25) {
    const p = chroma(Spectrum.line(nm));
    const d = Math.hypot(p[0] - t[0], p[1] - t[1]);
    if (d < bd) {
      bd = d;
      best = nm;
    }
  }
  return best;
}

// ---------- optical filters ----------
export type FilterKind = 'none' | 'bandpass' | 'red' | 'green' | 'blue' | 'paint';
export interface OpticalFilter {
  kind: FilterKind;
  /** centre (bandpass) in nm */
  nm: number;
  /** full width in nm */
  width: number;
  /** index into PAINTS when kind === 'paint' */
  paint: number;
}
export function transmission(f: OpticalFilter): (nm: number) => number {
  switch (f.kind) {
    case 'none':
      return () => 1;
    case 'bandpass':
      return (nm) => 1 / (1 + Math.pow((nm - f.nm) / (f.width / 2), 8));
    case 'red':
      return (nm) => 0.92 / (1 + Math.exp(-(nm - 595) / 8));
    case 'green':
      return (nm) => 0.85 / (1 + Math.pow((nm - 530) / 38, 6));
    case 'blue':
      return (nm) => 0.9 / (1 + Math.exp((nm - 490) / 9)) * (nm > 380 ? 1 : 0.5);
    case 'paint':
      return PAINTS[f.paint].r;
  }
}

// ---------- surfaces (for the colour-rendering slide) ----------
const logistic = (nm: number, edge: number, k: number) => 1 / (1 + Math.exp(-(nm - edge) / k));
const bump = (nm: number, c: number, s: number) => Math.exp(-0.5 * ((nm - c) / s) ** 2);
/** Everyday surfaces, shown alongside the paints. (No grape: too close to purple.) */
export const SURFACES: { name: string; r: (nm: number) => number }[] = [
  { name: 'Tomato', r: (nm) => 0.05 + 0.72 * logistic(nm, 595, 11) },
  { name: 'Banana', r: (nm) => 0.07 + 0.75 * logistic(nm, 505, 14) },
  { name: 'Leaf', r: (nm) => 0.05 + 0.32 * bump(nm, 550, 28) + 0.5 * logistic(nm, 712, 9) },
  { name: 'Jeans', r: (nm) => 0.05 + 0.32 * bump(nm, 465, 38) + 0.15 * logistic(nm, 760, 20) },
  { name: 'Skin', r: (nm) => 0.14 + 0.45 * logistic(nm, 585, 22) },
];

// ---------- paints (reflectance "filters" for the paints slide) ----------
export interface Paint {
  name: string;
  r: (nm: number) => number;
}

const sageA = (nm: number) => 0.16 + 0.2 * bump(nm, 535, 55) + 0.05 * logistic(nm, 640, 25);

/** Sage B = Sage A + δ, where δ is a "metameric black": wiggles chosen to sit on
 *  fluorescent lines, then projected so sunlight × δ is invisible to all three
 *  colour-matching functions. In sunlight A and B are the same colour; under a
 *  spiky lamp they aren't. */
const sageB: (nm: number) => number = (() => {
  const sun = SOURCES.Sunlight();
  const lo = 360, hi = 830, n = hi - lo + 1;
  const b = new Float64Array(n);
  const A: number[][] = [[], [], []];
  for (let i = 0; i < n; i++) {
    const nm = lo + i;
    b[i] = bump(nm, 611, 9) - 0.7 * bump(nm, 585, 12) - 0.7 * bump(nm, 640, 14) - 0.6 * bump(nm, 546, 7) + 0.5 * bump(nm, 520, 10);
    const s = sun.broad[nm - NM0];
    const c = cmf(nm);
    for (let k = 0; k < 3; k++) A[k][i] = s * c[k];
  }
  // δ = b − Aᵀc with (A Aᵀ) c = A b  ⇒  A δ = 0
  const AAt = [0, 1, 2].map((j) => [0, 1, 2].map((k) => A[j].reduce((acc, v, i) => acc + v * A[k][i], 0)));
  const Ab = [0, 1, 2].map((j) => A[j].reduce((acc, v, i) => acc + v * b[i], 0));
  const c = solve(AAt, Ab);
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) d[i] = b[i] - (c[0] * A[0][i] + c[1] * A[1][i] + c[2] * A[2][i]);
  // largest scale keeping B within [0.02, 0.98]
  let scale = Infinity;
  for (let i = 0; i < n; i++) {
    const a = sageA(lo + i);
    if (d[i] > 0) scale = Math.min(scale, (0.98 - a) / d[i]);
    if (d[i] < 0) scale = Math.min(scale, (a - 0.02) / -d[i]);
  }
  scale *= 0.97;
  return (nm: number) => {
    const f = nm - lo;
    if (f < 0 || f > n - 1) return sageA(nm);
    const i = Math.min(n - 2, Math.floor(f)), t = f - i;
    return sageA(nm) + scale * (d[i] * (1 - t) + d[i + 1] * t);
  };
})();

export const PAINTS: Paint[] = [
  { name: 'Sage A', r: sageA },
  { name: 'Sage B', r: sageB },
  { name: 'Brick', r: (nm) => 0.06 + 0.5 * logistic(nm, 600, 18) - 0.12 * logistic(nm, 690, 25) },
  { name: 'Lavender', r: (nm) => 0.12 + 0.45 * bump(nm, 440, 35) + 0.4 * logistic(nm, 640, 18) },
  ...SURFACES,
];

/** The pure-wavelength twin of POLY_RED, matched in brightness too: a true metamer
 *  (identical in all three cone bins and in luma). */
export const TWIN_RED = () => {
  const poly = POLY_RED();
  return atLuma(Spectrum.line(dominantNm(poly)), lumaOf(poly));
};
