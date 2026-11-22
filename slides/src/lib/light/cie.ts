import Color from 'colorjs.io';

/** CIE 1931 2° standard observer, 360–830 nm at 5 nm (x̄, ȳ, z̄).
 *  Source: CIE 015:2018 tables (via the colour-science project). */
// prettier-ignore
const CIE1931 = new Float64Array([
0.0001299,3.917e-06,0.0006061,
0.0002321,6.965e-06,0.001086,
0.0004149,1.239e-05,0.001946,
0.0007416,2.202e-05,0.003486,
0.001368,3.9e-05,0.00645,
0.002236,6.4e-05,0.01055,
0.004243,0.00012,0.02005,
0.00765,0.000217,0.03621,
0.01431,0.000396,0.06785,
0.02319,0.00064,0.1102,
0.04351,0.00121,0.2074,
0.07763,0.00218,0.3713,
0.13438,0.004,0.6456,
0.21477,0.0073,1.03905,
0.2839,0.0116,1.3856,
0.3285,0.01684,1.62296,
0.34828,0.023,1.74706,
0.34806,0.0298,1.7826,
0.3362,0.038,1.77211,
0.3187,0.048,1.7441,
0.2908,0.06,1.6692,
0.2511,0.0739,1.5281,
0.19536,0.09098,1.28764,
0.1421,0.1126,1.0419,
0.09564,0.13902,0.81295,
0.05795,0.1693,0.6162,
0.03201,0.20802,0.46518,
0.0147,0.2586,0.3533,
0.0049,0.323,0.272,
0.0024,0.4073,0.2123,
0.0093,0.503,0.1582,
0.0291,0.6082,0.1117,
0.06327,0.71,0.07825,
0.1096,0.7932,0.05725,
0.1655,0.862,0.04216,
0.22575,0.91485,0.02984,
0.2904,0.954,0.0203,
0.3597,0.9803,0.0134,
0.43345,0.99495,0.00875,
0.51205,1,0.00575,
0.5945,0.995,0.0039,
0.6784,0.9786,0.00275,
0.7621,0.952,0.0021,
0.8425,0.9154,0.0018,
0.9163,0.87,0.00165,
0.9786,0.8163,0.0014,
1.0263,0.757,0.0011,
1.0567,0.6949,0.001,
1.0622,0.631,0.0008,
1.0456,0.5668,0.0006,
1.0026,0.503,0.00034,
0.9384,0.4412,0.00024,
0.85445,0.381,0.00019,
0.7514,0.321,0.0001,
0.6424,0.265,5e-05,
0.5419,0.217,3e-05,
0.4479,0.175,2e-05,
0.3608,0.1382,1e-05,
0.2835,0.107,0,
0.2187,0.0816,0,
0.1649,0.061,0,
0.1212,0.04458,0,
0.0874,0.032,0,
0.0636,0.0232,0,
0.04677,0.017,0,
0.0329,0.01192,0,
0.0227,0.00821,0,
0.01584,0.005723,0,
0.0113592,0.004102,0,
0.00811092,0.002929,0,
0.00579035,0.002091,0,
0.00410946,0.001484,0,
0.00289933,0.001047,0,
0.00204919,0.00074,0,
0.00143997,0.00052,0,
0.000999949,0.0003611,0,
0.000690079,0.0002492,0,
0.000476021,0.0001719,0,
0.000332301,0.00012,0,
0.000234826,8.48e-05,0,
0.000166151,6e-05,0,
0.000117413,4.24e-05,0,
8.30753e-05,3e-05,0,
5.87065e-05,2.12e-05,0,
4.15099e-05,1.499e-05,0,
2.93533e-05,1.06e-05,0,
2.06738e-05,7.4657e-06,0,
1.45598e-05,5.2578e-06,0,
1.0254e-05,3.7029e-06,0,
7.22146e-06,2.6078e-06,0,
5.08587e-06,1.8366e-06,0,
3.58165e-06,1.2934e-06,0,
2.52253e-06,9.1093e-07,0,
1.77651e-06,6.4153e-07,0,
1.25114e-06,4.5181e-07,0
]);

/** Colour-matching functions at any wavelength (linear interpolation). */
export function cmf(nm: number): [number, number, number] {
  const f = (nm - 360) / 5;
  if (!(f >= 0 && f <= 94)) return [0, 0, 0];
  const i = Math.min(93, Math.floor(f)), a = f - i;
  const p = i * 3, q = p + 3;
  return [
    CIE1931[p] * (1 - a) + CIE1931[q] * a,
    CIE1931[p + 1] * (1 - a) + CIE1931[q + 1] * a,
    CIE1931[p + 2] * (1 - a) + CIE1931[q + 2] * a,
  ];
}

export type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];
const mul = (m: Mat3, v: Vec3): Vec3 => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];
function inv(m: Mat3): Mat3 {
  const [[a, b, c], [d, e, f], [g2, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g2), C = d * h - e * g2;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g2) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g2) / det, (a * e - b * d) / det],
  ];
}

/** Hunt–Pointer–Estevez: XYZ → LMS cone responses (our three "bins"). */
const HPE: Mat3 = [
  [0.4002, 0.7076, -0.0808],
  [-0.2263, 1.1653, 0.0457],
  [0, 0, 0.9182],
];
export const xyzToLms = (v: Vec3) => mul(HPE, v);
export const lmsToXyz = (v: Vec3) => mul(inv(HPE), v);
export function coneCurves(nm: number): Vec3 {
  const l = xyzToLms(cmf(nm));
  return [Math.max(0, l[0]), Math.max(0, l[1]), Math.max(0, l[2])];
}

const BRADFORD: Mat3 = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];
const BRADFORD_INV = inv(BRADFORD);
const D65: Vec3 = [0.95047, 1, 1.08883];

/** Adapt from a scene white (e.g. sunlight) to D65 — roughly what the eye does. */
export function makeAdapter(white: Vec3, degree = 1): (v: Vec3) => Vec3 {
  const wn: Vec3 = [white[0] / white[1], 1, white[2] / white[1]];
  const w: Vec3 = [D65[0] + (wn[0] - D65[0]) * degree, 1, D65[2] + (wn[2] - D65[2]) * degree];
  const ws = mul(BRADFORD, w);
  const wd = mul(BRADFORD, D65);
  return (v) => {
    const c = mul(BRADFORD, v);
    return mul(BRADFORD_INV, [(c[0] * wd[0]) / ws[0], (c[1] * wd[1]) / ws[1], (c[2] * wd[2]) / ws[2]]);
  };
}

const XYZ_TO_LIN_SRGB: Mat3 = [
  [3.2406, -1.5372, -0.4986],
  [-0.9689, 1.8758, 0.0415],
  [0.0557, -0.204, 1.057],
];
export const xyzToLinRgb = (v: Vec3) => mul(XYZ_TO_LIN_SRGB, v);
export const linRgbToXyz = (v: Vec3) => mul(inv(XYZ_TO_LIN_SRGB), v);

/** XYZ (D65) → displayable sRGB 0..1, gamut-mapped (CSS Color 4 / OKLCh). */
export function xyzToSrgb(v: Vec3): Vec3 {
  if (!(v[1] > 1e-7)) return [0, 0, 0];
  const c = new Color('xyz-d65', [v[0], v[1], v[2]]).toGamut({ space: 'srgb' }).to('srgb');
  return c.coords.map((x) => Math.max(0, Math.min(1, x ?? 0))) as Vec3;
}

/** Same hue/chroma, but scaled so the brightest linear channel ≈ 1. */
export function xyzToSrgbBright(v: Vec3): Vec3 {
  const lin = xyzToLinRgb(v);
  const m = Math.max(lin[0], lin[1], lin[2], 1e-9);
  // Out-of-gamut (spectral) colours have a negative channel; scaling by the
  // positive max keeps them saturated before gamut mapping pulls them in.
  const k = 1 / m;
  return xyzToSrgb([v[0] * k, v[1] * k, v[2] * k]);
}

export const css = (c: Vec3) =>
  `rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)})`;

// ---- colour-blind (deuteranope) simulation, Viénot/Brettel/Mollon 1999 ----
const V_RGB2LMS: Mat3 = [
  [17.8824, 43.5161, 4.11935],
  [3.45565, 27.1554, 3.86714],
  [0.0299566, 0.184309, 1.46709],
];
const V_LMS2RGB = inv(V_RGB2LMS);
const toLin = (u: number) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));
const toGam = (u: number) => (u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055);
export function deuteranope(c: Vec3): Vec3 {
  const lms = mul(V_RGB2LMS, c.map(toLin) as Vec3);
  lms[1] = 0.494207 * lms[0] + 1.24827 * lms[2];
  return mul(V_LMS2RGB, lms).map((u) => Math.max(0, Math.min(1, toGam(Math.max(0, u))))) as Vec3;
}
