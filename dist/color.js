/**
 * Color-science helpers for the ColorReader match app.
 *
 * - labToRgb: render a CIELAB value as an approximate on-screen sRGB swatch (D65/2°).
 * - ciede2000: perceptual color difference ΔE00 between two Lab values.
 * - closeness: map a ΔE00 into a human label + 0–100 score for the UI.
 *
 * All Lab here is CIELAB, D65 / 2° observer — the same convention the reference
 * datasets are normalized to. (The device returns Lab directly; see driver.)
 */
// --------------------------------------------------------------------------
// CIELAB (D65/2°) → sRGB, for drawing swatches. Values are clamped to [0,255];
// out-of-gamut Lab is approximated, which is fine for an illustrative swatch.
// --------------------------------------------------------------------------
const D65 = { X: 95.047, Y: 100.0, Z: 108.883 };
function labToXyz({ L, a, b }) {
    const fy = (L + 16) / 116;
    const fx = fy + a / 500;
    const fz = fy - b / 200;
    const eps = 216 / 24389; // (6/29)^3
    const kappa = 24389 / 27; // (29/3)^3
    const fInv = (t) => (t ** 3 > eps ? t ** 3 : (116 * t - 16) / kappa);
    return [fInv(fx) * D65.X, fInv(fy) * D65.Y, fInv(fz) * D65.Z];
}
function gamma(c) {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
}
/** CIELAB → CSS `rgb(...)` string (approximate, gamut-clamped). */
export function labToRgb(lab) {
    const [X, Y, Z] = labToXyz(lab).map((v) => v / 100);
    const rl = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
    const gl = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
    const bl = X * 0.0557 + Y * -0.204 + Z * 1.057;
    return `rgb(${gamma(rl)}, ${gamma(gl)}, ${gamma(bl)})`;
}
/** True if the Lab renders in-gamut on sRGB (no channel clamped). */
export function inGamut(lab) {
    const [X, Y, Z] = labToXyz(lab).map((v) => v / 100);
    const chans = [
        X * 3.2406 + Y * -1.5372 + Z * -0.4986,
        X * -0.9689 + Y * 1.8758 + Z * 0.0415,
        X * 0.0557 + Y * -0.204 + Z * 1.057,
    ];
    return chans.every((c) => c >= -0.001 && c <= 1.001);
}
// --------------------------------------------------------------------------
// CIEDE2000 (ΔE00). Reference: Sharma, Wu & Dalal (2005).
// --------------------------------------------------------------------------
const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
export function ciede2000(a, b) {
    const kL = 1, kC = 1, kH = 1;
    const C1 = Math.hypot(a.a, a.b);
    const C2 = Math.hypot(b.a, b.b);
    const Cbar = (C1 + C2) / 2;
    const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
    const a1p = (1 + G) * a.a;
    const a2p = (1 + G) * b.a;
    const C1p = Math.hypot(a1p, a.b);
    const C2p = Math.hypot(a2p, b.b);
    const h1p = hue(a.b, a1p);
    const h2p = hue(b.b, a2p);
    const dLp = b.L - a.L;
    const dCp = C2p - C1p;
    let dhp = 0;
    if (C1p * C2p !== 0) {
        const diff = h2p - h1p;
        if (Math.abs(diff) <= 180)
            dhp = diff;
        else if (diff > 180)
            dhp = diff - 360;
        else
            dhp = diff + 360;
    }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp) / 2);
    const Lbarp = (a.L + b.L) / 2;
    const Cbarp = (C1p + C2p) / 2;
    let hbarp = h1p + h2p;
    if (C1p * C2p !== 0) {
        if (Math.abs(h1p - h2p) > 180)
            hbarp = h1p + h2p < 360 ? hbarp + 360 : hbarp - 360;
        hbarp /= 2;
    }
    const T = 1 -
        0.17 * Math.cos(rad(hbarp - 30)) +
        0.24 * Math.cos(rad(2 * hbarp)) +
        0.32 * Math.cos(rad(3 * hbarp + 6)) -
        0.2 * Math.cos(rad(4 * hbarp - 63));
    const dtheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
    const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
    const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
    const Sc = 1 + 0.045 * Cbarp;
    const Sh = 1 + 0.015 * Cbarp * T;
    const Rt = -Math.sin(rad(2 * dtheta)) * Rc;
    return Math.sqrt((dLp / (kL * Sl)) ** 2 +
        (dCp / (kC * Sc)) ** 2 +
        (dHp / (kH * Sh)) ** 2 +
        Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh)));
}
function hue(b, ap) {
    if (ap === 0 && b === 0)
        return 0;
    let h = deg(Math.atan2(b, ap));
    if (h < 0)
        h += 360;
    return h;
}
export function closeness(dE) {
    let label;
    if (dE < 1)
        label = 'Exact match';
    else if (dE < 2)
        label = 'Very close';
    else if (dE < 3.5)
        label = 'Close';
    else if (dE < 5)
        label = 'Noticeably off';
    else if (dE < 10)
        label = 'Different';
    else
        label = 'Very different';
    // Map ΔE 0→100, ~10→~20, tapering; clamp to [0,100].
    const score = Math.round(Math.max(0, Math.min(100, 100 * Math.exp(-dE / 6))));
    return { label, score };
}
