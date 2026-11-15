// SPHEREx Blink - core library (no dependencies; runs in the browser and in Node >= 18).
// Reads NASA SPHEREx Level-2 spectral images straight from the public Amazon S3 bucket with HTTP range requests:
// a ~35 kB header slice gives the pointing (WCS), then only the detector rows that cover the requested sky patch
// are downloaded. No server is involved.
// This file was written with the help of an AI coding assistant (see README, "Use of AI").

export const S3 = 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/';
export const NPIX_DET = 2040;            // detector is 2040 x 2040 pixels
export const NATIVE_ARCSEC = 6.15;       // native pixel scale
const D2R = Math.PI / 180, R2D = 180 / Math.PI, ASEC = 3600 * R2D;
const OBLIQUITY = 23.4392911 * D2R;      // J2000 mean obliquity of the ecliptic

// Output grid for a field of view (arcmin): pixels of half the native size up to 6 arcmin, native size beyond.
export function gridFor(fovArcmin) {
  const scale = fovArcmin <= 6 ? NATIVE_ARCSEC / 2 : NATIVE_ARCSEC;
  return { scale, n: Math.round(fovArcmin * 60 / scale) | 1 };
}

// ---------------------------------------------------------------- FITS headers
// Parse one FITS header starting at byte `start`. Returns {h: {KEY: value}, dataStart} or null if END is not in `bytes`.
export function parseHeader(bytes, start = 0) {
  const h = {};
  for (let off = start; off + 80 <= bytes.length; off += 80) {
    const card = String.fromCharCode.apply(null, bytes.subarray(off, off + 80));
    const key = card.slice(0, 8).trim();
    if (key === 'END') return { h, dataStart: start + Math.ceil((off + 80 - start) / 2880) * 2880 };
    if (card[8] !== '=') continue;
    let v = card.slice(10);
    if (v.trimStart()[0] === "'") {
      v = v.slice(v.indexOf("'") + 1);
      h[key] = v.slice(0, v.search(/'(?!')/)).trim();          // closing quote ('' is an escaped quote)
    } else {
      v = v.split('/')[0].trim();
      h[key] = v === 'T' ? true : v === 'F' ? false : Number(v);
    }
  }
  return null;
}

// ---------------------------------------------------------------- world coordinates (TAN projection + SIP distortion)
export function makeWcs(h) {
  const cd1 = h.CDELT1 ?? 1, cd2 = h.CDELT2 ?? 1;
  const cd = h.CD1_1 !== undefined
    ? [h.CD1_1, h.CD1_2 ?? 0, h.CD2_1 ?? 0, h.CD2_2]
    : [cd1 * (h.PC1_1 ?? 1), cd1 * (h.PC1_2 ?? 0), cd2 * (h.PC2_1 ?? 0), cd2 * (h.PC2_2 ?? 1)];
  const det = cd[0] * cd[3] - cd[1] * cd[2];
  const poly = (name) => {
    const order = h[name + '_ORDER'] ?? 0, terms = [];
    for (let p = 0; p <= order; p++) for (let q = 0; q <= order - p; q++) {
      const c = h[`${name}_${p}_${q}`];
      if (c) terms.push([p, q, c]);
    }
    return terms;
  };
  return {
    crpix1: h.CRPIX1, crpix2: h.CRPIX2, ra0: h.CRVAL1, dec0: h.CRVAL2, cd,
    cdInv: [cd[3] / det, -cd[1] / det, -cd[2] / det, cd[0] / det],
    A: poly('A'), B: poly('B'), AP: poly('AP'), BP: poly('BP'),
  };
}
const evalPoly = (terms, u, v) => { let s = 0; for (const [p, q, c] of terms) s += c * u ** p * v ** q; return s; };

// Gnomonic (tangent-plane) projection about (ra0, dec0): sky (deg) -> standard coordinates (deg; xi east, eta north)
export function project(ra, dec, ra0, dec0) {
  const d = dec * D2R, d0 = dec0 * D2R, da = (ra - ra0) * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(da);
  return [R2D * Math.cos(d) * Math.sin(da) / cosc,
          R2D * (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(da)) / cosc];
}
export function deproject(xi, eta, ra0, dec0) {
  const x = xi * D2R, y = eta * D2R, d0 = dec0 * D2R;
  const den = Math.cos(d0) - y * Math.sin(d0);
  let ra = ra0 + R2D * Math.atan2(x, den);
  ra = ((ra % 360) + 360) % 360;
  return [ra, R2D * Math.atan2(Math.sin(d0) + y * Math.cos(d0), Math.hypot(x, den))];
}
// pixel (0-based x = column, y = row) <-> sky (deg)
export function pix2sky(w, x, y) {
  const u = x + 1 - w.crpix1, v = y + 1 - w.crpix2;
  const f = u + evalPoly(w.A, u, v), g = v + evalPoly(w.B, u, v);
  return deproject(w.cd[0] * f + w.cd[1] * g, w.cd[2] * f + w.cd[3] * g, w.ra0, w.dec0);
}
export function sky2pix(w, ra, dec) {
  const [xi, eta] = project(ra, dec, w.ra0, w.dec0);
  const U = w.cdInv[0] * xi + w.cdInv[1] * eta, V = w.cdInv[2] * xi + w.cdInv[3] * eta;
  let u = U + evalPoly(w.AP, U, V), v = V + evalPoly(w.BP, U, V);
  for (let it = 0; it < 3; it++) {            // polish with the forward distortion (the AP/BP fit is approximate)
    u += U - (u + evalPoly(w.A, u, v));
    v += V - (v + evalPoly(w.B, u, v));
  }
  return [u + w.crpix1 - 1, v + w.crpix2 - 1];
}

// ---------------------------------------------------------------- wavelength (per-detector 9x9 lookup table)
// tab = {x, y, wave, band} from docs/wave.json; x, y are 0-based detector pixels. Returns [wavelength, bandwidth] in microns.
export function wavelength(tab, x, y) {
  const locate = (grid, t) => {
    let i = 0;
    while (i < grid.length - 2 && t > grid[i + 1]) i++;
    return [i, (t - grid[i]) / (grid[i + 1] - grid[i])];
  };
  const [ix, fx] = locate(tab.x, x + 1), [iy, fy] = locate(tab.y, y + 1);
  const bil = (m) => (1 - fy) * ((1 - fx) * m[iy][ix] + fx * m[iy][ix + 1]) + fy * ((1 - fx) * m[iy + 1][ix] + fx * m[iy + 1][ix + 1]);
  return [bil(tab.wave), bil(tab.band)];
}

// ---------------------------------------------------------------- sky index (written by tools/build_index.py)
const nBins = (band, bandDeg) => Math.max(1, Math.round(360 / bandDeg * Math.cos((-90 + bandDeg * (band + 0.5)) * D2R)));

// Index cells that can hold an image centred within `radius` deg of (ra, dec).
export function cellsNear(ra, dec, radius, bandDeg) {
  const out = [], nBand = Math.round(180 / bandDeg);
  const b0 = Math.max(0, Math.floor((dec - radius + 90) / bandDeg)), b1 = Math.min(nBand - 1, Math.floor((dec + radius + 90) / bandDeg));
  for (let b = b0; b <= b1; b++) {
    const n = nBins(b, bandDeg), width = 360 / n;
    const decEdge = Math.min(89.999, Math.max(Math.abs(-90 + bandDeg * b), Math.abs(-90 + bandDeg * (b + 1)), Math.abs(dec)));
    const half = Math.abs(dec) + radius >= 90 ? 180 : radius / Math.cos(decEdge * D2R);
    if (half >= 180) { for (let i = 0; i < n; i++) out.push([b, i]); continue; }
    const seen = new Set();
    for (let k = Math.floor((ra - half) / width); k <= Math.floor((ra + half) / width); k++) seen.add(((k % n) + n) % n);
    for (const i of seen) out.push([b, i]);
  }
  return out;
}

const cellCache = new Map();
async function loadCell(base, b, i) {
  const key = `${base}c_${b}_${i}.json`;
  if (!cellCache.has(key)) cellCache.set(key, fetch(key).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return cellCache.get(key);
}

// Is sky point (ra, dec) inside the detector footprint centred at (rc, dc) with +y axis at position angle pa?
export function inFootprint(ra, dec, rc, dc, pa, halfDeg) {
  if (Math.abs(dec - dc) > 2 * halfDeg + 1) return false;
  const [xi, eta] = project(ra, dec, rc, dc), s = Math.sin(pa * D2R), c = Math.cos(pa * D2R);
  return Math.abs(-xi * c + eta * s) < halfDeg && Math.abs(xi * s + eta * c) < halfDeg;
}

export function imageUrl(meta, p, q, s, d) {
  const [rel, pp, ver] = meta.prefixes[p];
  return `${meta.s3}${rel}/level2/${pp}/${ver}/${d}/level2_${pp}_${String(q).padStart(4, '0')}_${s}D${d}_spx_${ver}.fits`;
}

// All Level-2 images whose footprint contains the position given by posAt(mjd) -> [ra, dec].
// For a fixed target pass () => [ra, dec]; for a moving one pass an ephemeris interpolator plus the positions to
// look around (`where`: list of [ra, dec] along the track).
export async function findImages(meta, base, posAt, where, marginDeg = 0.05) {
  const cells = new Map();
  for (const [ra, dec] of where)
    for (const [b, i] of cellsNear(ra, dec, meta.half_deg * Math.SQRT2 + 0.2, meta.band_deg)) cells.set(`${b}_${i}`, [b, i]);
  const shards = await Promise.all([...cells.values()].map(([b, i]) => loadCell(base, b, i)));
  const rows = [];
  for (const s of shards) {
    if (!s) continue;
    for (let k = 0; k < s.p.length; k++) {
      const [ra, dec] = posAt(s.t[k]);
      if (inFootprint(ra, dec, s.r[k], s.c[k], s.a[k], meta.half_deg + marginDeg))
        rows.push({ url: imageUrl(meta, s.p[k], s.q[k], s.s[k], s.d[k]), det: s.d[k], mjd: s.t[k], ra, dec,
                    release: meta.prefixes[s.p[k]][0], obs: `${meta.prefixes[s.p[k]][1]}_${String(s.q[k]).padStart(4, '0')}_${s.s[k]}` });
    }
  }
  rows.sort((a, b) => a.mjd - b.mjd);
  return rows;
}

// ---------------------------------------------------------------- image cutouts
async function getRange(url, start, end, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
      if (r.status === 404) return null;
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (signal?.aborted) throw e;
    }
    if (attempt >= 3) throw new Error(`cannot read ${url}`);
    await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
  }
}

export function median(values) {            // of a Float64Array/Array copy; NaN must be filtered out by the caller
  if (!values.length) return NaN;
  const a = Float64Array.from(values).sort(), m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

// Download one image's pixels around (ra, dec) and resample them onto a north-up, east-left grid of n x n pixels
// of `scale` arcsec, centred on (ra, dec). Returns null when the image does not cover the centre.
// Result: {img Float32Array(n*n) in MJy/sr with the local sky level subtracted (NaN = no data), sky, noise, mjd,
//          wave, band (microns at the centre), wgrad [d wave / d column, d wave / d row], exptime, fwhm, x, y, url...}
export async function fetchFrame(row, ra, dec, n, scale, waveTabs, signal) {
  const head = await getRange(row.url, 0, 40319, signal);
  if (!head) return null;
  const prim = parseHeader(head, 0);
  const ext = prim && parseHeader(head, prim.dataStart);
  if (!ext) throw new Error(`unexpected FITS layout in ${row.url}`);
  const h = ext.h, w = makeWcs(h), nx = h.NAXIS1, ny = h.NAXIS2;
  const [xc, yc] = sky2pix(w, ra, dec);
  if (!(xc >= 0 && xc <= nx - 1 && yc >= 0 && yc <= ny - 1)) return null;

  // detector pixel of every output pixel
  const c = (n - 1) / 2, px = new Float32Array(n * n), py = new Float32Array(n * n);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const [r, d] = deproject(-(i - c) * scale / 3600, -(j - c) * scale / 3600, ra, dec);
    const [x, y] = sky2pix(w, r, d);
    px[j * n + i] = x; py[j * n + i] = y;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(nx - 1, Math.ceil(x1));
  y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(ny - 1, Math.ceil(y1));
  const first = ext.dataStart + (y0 * nx + x0) * 4, last = ext.dataStart + (y1 * nx + x1) * 4 + 3;
  const raw = await getRange(row.url, first, last, signal);
  if (!raw) return null;
  // decode the rectangle we need (FITS is big-endian) and drop dead pixels: nothing real is far below the sky level
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const w0 = x1 - x0 + 1, h0 = y1 - y0 + 1, sub = new Float32Array(w0 * h0), good = [];
  for (let y = 0; y < h0; y++) for (let x = 0; x < w0; x++) {
    const v = view.getFloat32((y * nx + x) * 4, false);
    sub[y * w0 + x] = v;
    if (Number.isFinite(v)) good.push(v);
  }
  const sky0 = median(good), sig0 = 1.4826 * median(good.map((v) => Math.abs(v - sky0)));
  for (let k = 0; k < sub.length; k++) if (!(sub[k] > sky0 - 6 * sig0) || sub[k] === 0) sub[k] = NaN;
  // hot pixels and single-pixel cosmic-ray hits: a bright pixel whose four neighbours hold almost no light cannot be
  // a star, because the telescope blurs every real source over more than one pixel (the FLAGS extension that
  // marks them is tile-compressed and cannot be read by byte range)
  const hot = [];
  for (let y = 0; y < h0; y++) for (let x = 0; x < w0; x++) {
    const v = sub[y * w0 + x] - sky0;
    if (!(v > 12 * sig0)) continue;
    let m = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < w0 && yy >= 0 && yy < h0) { const u = sub[yy * w0 + xx] - sky0; if (u > m) m = u; }
    }
    if (m < 0.07 * v) hot.push(y * w0 + x);
  }
  for (const k of hot) sub[k] = NaN;

  // bilinear resampling; a bad neighbour is ignored unless it is the nearest pixel
  const img = new Float32Array(n * n), finite = [];
  for (let k = 0; k < n * n; k++) {
    const x = px[k] - x0, y = py[k] - y0, ix = Math.floor(x), iy = Math.floor(y);
    if (ix < 0 || ix + 1 >= w0 || iy < 0 || iy + 1 >= h0) { img[k] = NaN; continue; }
    const fx = x - ix, fy = y - iy;
    if (Number.isNaN(sub[(iy + (fy >= 0.5)) * w0 + ix + (fx >= 0.5)])) { img[k] = NaN; continue; }
    let s = 0, sw = 0;
    for (const [dx, dy, wt] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
      const v = sub[(iy + dy) * w0 + ix + dx];
      if (v === v) { s += wt * v; sw += wt; }
    }
    img[k] = s / sw;
    finite.push(img[k]);
  }
  // local sky (zodiacal light dominates) and noise from the median and the median absolute deviation
  const sky = median(finite), noise = 1.4826 * median(finite.map((v) => Math.abs(v - sky)));
  for (let k = 0; k < n * n; k++) img[k] -= sky;

  const tab = waveTabs?.[String(h.DETECTOR)];
  const [wave, band] = tab ? wavelength(tab, xc, yc) : [NaN, NaN];
  let wgrad = [0, 0];
  if (tab) {
    const kc = Math.round(c) * n + Math.round(c), wl = (k) => wavelength(tab, px[k], py[k])[0];
    wgrad = [wl(Math.min(kc + 1, n * n - 1)) - wl(kc), wl(Math.min(kc + n, n * n - 1)) - wl(kc)];
  }
  return {
    img, sky, noise, wave, band, wgrad, n, scale, x: xc, y: yc,
    mjd: h['MJD-AVG'] ?? row.mjd, date: h['DATE-AVG'] ?? '', det: h.DETECTOR ?? row.det, obs: h.OBSID ?? row.obs,
    exptime: h.XPOSURE ?? NaN, fwhm: h.PSF_FWHM ?? NaN, url: row.url, release: row.release,
    bytes: head.length + raw.length, frac: finite.length / (n * n),
  };
}

// ---------------------------------------------------------------- Solar-system geometry for the "Planet X" stack
// Heliocentric position of the Earth (AU, equatorial J2000). Low-precision solar theory (Astronomical Almanac),
// good to ~0.01 deg / 1e-4 AU for 1950-2050 - ample for parallax of bodies beyond 30 AU.
export function earthHelio(mjd) {
  const nDays = mjd - 51544.5, T = nDays / 36525;
  const g = (357.528 + 0.9856003 * nDays) * D2R;
  const lon = (280.460 + 0.9856474 * nDays + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g) - 1.3969 * T) * D2R;   // precessed to J2000
  const R = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
  return [-R * Math.cos(lon), -R * Math.cos(OBLIQUITY) * Math.sin(lon), -R * Math.sin(OBLIQUITY) * Math.sin(lon)];
}
const unit = (ra, dec) => [Math.cos(dec * D2R) * Math.cos(ra * D2R), Math.cos(dec * D2R) * Math.sin(ra * D2R), Math.sin(dec * D2R)];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

// Where would a Solar-system body be at each time, if at time tRef it is seen at (ra, dec) and it sits at
// heliocentric distance `dist` AU? Motion = parallax (Earth's orbit) + a circular, prograde orbit around the Sun
// whose plane is tilted by `tilt` deg to the ecliptic (set orbit=false for parallax only).
// Returns [[east, north], ...] offsets in arcsec relative to (ra, dec).
export function track(ra, dec, mjds, tRef, dist, tilt = 0, orbit = true) {
  const u = unit(ra, dec), E0 = earthHelio(tRef), eu = dot(E0, u);
  const rho = -eu + Math.sqrt(eu * eu - dot(E0, E0) + dist * dist);            // geocentric distance at tRef
  const X = [E0[0] + rho * u[0], E0[1] + rho * u[1], E0[2] + rho * u[2]];
  const pole = [0, -Math.sin(OBLIQUITY), Math.cos(OBLIQUITY)];                  // ecliptic north pole
  const xh = norm(X), pro = norm(cross(pole, xh)), up = cross(xh, pro);
  const speed = orbit ? (2 * Math.PI / 365.25) / Math.sqrt(dist) : 0;          // AU per day
  const ct = Math.cos(tilt * D2R), st = Math.sin(tilt * D2R);
  const V = [0, 1, 2].map((k) => speed * (ct * pro[k] + st * up[k]));
  return mjds.map((t) => {
    const E = earthHelio(t), dt = t - tRef;
    const P = [0, 1, 2].map((k) => X[k] + V[k] * dt - E[k]), l = Math.hypot(...P);
    const [xi, eta] = project(R2D * Math.atan2(P[1], P[0]), R2D * Math.asin(P[2] / l), ra, dec);
    return [xi * 3600, eta * 3600];
  });
}

// ---------------------------------------------------------------- stacking and photometry
// Combine frames (Float32Array n*n each) after shifting frame k by offsets[k] = [east, north] arcsec, so that a
// source following that track lands on the same pixel in every frame. mode: 'mean' (inverse-variance weighted),
// 'median', or 'clip' (weighted mean without the highest few values per pixel - removes cosmic rays and hot pixels).
// Returns {img, sigma (expected noise per pixel, for 'mean'/'clip'), count}.
export function stack(frames, weights, n, scale, offsets = null, mode = 'clip') {
  const m = frames.length, img = new Float32Array(n * n), sigma = new Float32Array(n * n), count = new Uint16Array(n * n);
  const sx = new Int32Array(m), sy = new Int32Array(m);
  if (offsets) for (let k = 0; k < m; k++) { sx[k] = Math.round(-offsets[k][0] / scale); sy[k] = Math.round(-offsets[k][1] / scale); }
  const vals = new Float64Array(m), wts = new Float64Array(m);
  const TOP_MAX = 64, topV = new Float64Array(TOP_MAX), topW = new Float64Array(TOP_MAX);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let c = 0;
    for (let k = 0; k < m; k++) {
      // east is to the left: a source displaced east by dx sits at column i - dx/scale; north (up) is row j - dy/scale
      const ii = i + sx[k], jj = j + sy[k];
      if (ii < 0 || ii >= n || jj < 0 || jj >= n) continue;
      const v = frames[k][jj * n + ii];
      if (v === v) { vals[c] = v; wts[c] = weights[k]; c++; }
    }
    const o = j * n + i;
    count[o] = c;
    if (!c) { img[o] = NaN; sigma[o] = NaN; continue; }
    if (mode === 'median') { img[o] = median(vals.subarray(0, c)); sigma[o] = NaN; continue; }
    // 'clip' = trimmed mean: leave out the highest values (1 of 3-7, else the top 10 %, at least 2). A real source is
    // in every exposure of its visit, so it survives; cosmic-ray hits, hot pixels and the streak of a bright body
    // passing through are in a few exposures only.
    let sw = 0, swv = 0;
    for (let k = 0; k < c; k++) { sw += wts[k]; swv += wts[k] * vals[k]; }
    if (mode === 'clip' && c >= 3) {
      const nTop = c >= 8 ? Math.min(TOP_MAX, Math.max(2, Math.round(0.1 * c))) : 1;
      let filled = 0;                                       // topV[0..filled) ascending = the highest values so far
      for (let k = 0; k < c; k++) {
        const v = vals[k];
        if (filled === nTop && v <= topV[0]) continue;
        let p = filled < nTop ? filled++ : 0;               // append, or overwrite the smallest
        if (p === 0) { while (p + 1 < filled && topV[p + 1] < v) { topV[p] = topV[p + 1]; topW[p] = topW[p + 1]; p++; } }
        else { while (p > 0 && topV[p - 1] > v) { topV[p] = topV[p - 1]; topW[p] = topW[p - 1]; p--; } }
        topV[p] = v; topW[p] = wts[k];
      }
      for (let k = 0; k < filled; k++) { sw -= topW[k]; swv -= topW[k] * topV[k]; }
    }
    img[o] = swv / sw; sigma[o] = 1 / Math.sqrt(sw);
  }
  return { img, sigma, count };
}

// Aperture photometry on a resampled frame: flux in microJansky inside radius rAp (arcsec) around pixel (ci, cj),
// local background from the median of an annulus. Returns [flux, error].
export function aperture(frame, ci, cj, rAp = 9, rIn = 18, rOut = 30) {
  const { img, n, scale, noise } = frame, r = Math.ceil(rOut / scale), ring = [];
  let sum = 0, np = 0;
  for (let j = Math.max(0, Math.floor(cj - r)); j <= Math.min(n - 1, Math.ceil(cj + r)); j++)
    for (let i = Math.max(0, Math.floor(ci - r)); i <= Math.min(n - 1, Math.ceil(ci + r)); i++) {
      const v = img[j * n + i], d = Math.hypot(i - ci, j - cj) * scale;
      if (v !== v) { if (d <= rAp) return [NaN, NaN]; continue; }
      if (d <= rAp) { sum += v; np++; } else if (d >= rIn && d <= rOut) ring.push(v);
    }
  if (!np || ring.length < 10) return [NaN, NaN];
  const bg = median(ring), toUJy = 23.5044 * scale * scale;                   // MJy/sr -> microJy per pixel
  // resampled pixels are correlated: noise per native pixel ~ frame.noise, aperture holds np*(scale/6.15)^2 of them
  const nNative = Math.max(1, np * (scale / NATIVE_ARCSEC) ** 2);
  return [(sum - bg * np) * toUJy, noise * Math.sqrt(nNative) * (NATIVE_ARCSEC / scale) ** 2 * toUJy];
}

// ---------------------------------------------------------------- moving-object search ("Planet X stack")
export function robust(img) {               // [median, sigma] of the finite pixels
  const v = [];
  for (let k = 0; k < img.length; k++) if (img[k] === img[k]) v.push(img[k]);
  if (v.length < 5) return [0, 1];
  const med = median(v), sig = 1.4826 * median(v.map((x) => Math.abs(x - med)));
  return [med, sig || 1];
}
export function smooth(img, n) {            // 3x3 binomial filter, NaN-aware: a cheap matched filter for point sources
  const out = new Float32Array(n * n), w = [1, 2, 1];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let s = 0, sw = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || ii >= n || jj < 0 || jj >= n) continue;
      const v = img[jj * n + ii];
      if (v === v) { const k = w[di + 1] * w[dj + 1]; s += k * v; sw += k; }
    }
    out[j * n + i] = sw ? s / sw : NaN;
  }
  return out;
}

// Exposures minus the fixed sky. The fixed sky is the per-pixel median of all exposures of the same detector
// (a body that moves, or is present in one epoch only, drops out of a median); pixels on bright stars are masked.
// frames: [{img, noise, mjd, det}] -> [{img, noise, mjd, det, frame}] sorted by time.
export function residuals(frames, n, scale) {
  const out = [];
  for (let d = 1; d <= 6; d++) {
    const fr = frames.filter((f) => f.det === d);
    if (fr.length < 3) continue;
    const tmpl = stack(fr.map((f) => f.img), fr.map(() => 1), n, scale, null, 'median').img;
    const [, sig] = robust(tmpl), mask = new Uint8Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (tmpl[j * n + i] > 6 * sig)
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii >= 0 && ii < n && jj >= 0 && jj < n) mask[jj * n + ii] = 1;
      }
    for (const f of fr) {
      const img = new Float32Array(n * n);
      for (let k = 0; k < n * n; k++) img[k] = mask[k] ? NaN : f.img[k] - tmpl[k];
      out.push({ img, noise: f.noise, mjd: f.mjd, det: d, frame: f });
    }
  }
  return out.sort((a, b) => a.mjd - b.mjd);
}

// Shift-and-stack of residual exposures along the track of a body at `dist` AU that is at the field centre
// direction (ra, dec) at time tRef. Returns a signal-to-noise map {img}, its peak value and pixel index, the
// offsets used, and the largest number of overlapping exposures.
export function trackStack(res, ra, dec, n, scale, tRef, dist, tilt = 0) {
  const offs = track(ra, dec, res.map((r) => r.mjd), tRef, dist, tilt);
  const st = stack(res.map((r) => r.img), res.map((r) => 1 / (r.noise * r.noise || 1)), n, scale, offs, 'clip');
  const z = new Float32Array(n * n);
  let used = 0;
  for (let k = 0; k < n * n; k++) if (st.count[k] > used) used = st.count[k];
  for (let k = 0; k < n * n; k++) z[k] = st.count[k] >= Math.max(4, 0.25 * used) ? st.img[k] / st.sigma[k] : NaN;
  const img = smooth(z, n), [med, sig] = robust(img);
  let peak = -Infinity, at = 0;
  for (let k = 0; k < n * n; k++) {
    const i = k % n, j = (k / n) | 0;
    if (i < 3 || i >= n - 3 || j < 3 || j >= n - 3) { img[k] = NaN; continue; }
    img[k] = (img[k] - med) / sig;
    if (img[k] > peak) { peak = img[k]; at = k; }
  }
  return { img, peak, at, offs, used };
}

// Add (sign = 1) or remove (sign = -1) an artificial point source of `flux` microJy (same at every wavelength) that
// moves like a body at `dist` AU and sits at pixel `at` = [column, row] at time tRef. Used to measure what the
// stack can recover (injection-recovery test).
export function inject(frames, n, scale, ra, dec, at, tRef, dist, flux, sign = 1) {
  const offs = track(ra, dec, frames.map((f) => f.mjd), tRef, dist, 0);
  frames.forEach((f, k) => {
    const ci = at[0] - offs[k][0] / scale, cj = at[1] - offs[k][1] / scale, sg = (f.fwhm || 7) / 2.355 / scale;
    const amp = sign * flux / (2 * Math.PI * sg * sg * 23.5044 * scale * scale);            // microJy -> peak MJy/sr
    for (let j = Math.max(0, Math.floor(cj - 4 * sg)); j <= Math.min(n - 1, Math.ceil(cj + 4 * sg)); j++)
      for (let i = Math.max(0, Math.floor(ci - 4 * sg)); i <= Math.min(n - 1, Math.ceil(ci + 4 * sg)); i++)
        f.img[j * n + i] += amp * Math.exp(-((i - ci) ** 2 + (j - cj) ** 2) / (2 * sg * sg));
  });
}

// A pixel near `near` = [column, row] with no masked star within `half` pixels in any residual exposure:
// a fair place to put a test source (a spot under the star mask could never be recovered).
export function clearPixel(res, n, near, half = 3) {
  const blocked = new Uint8Array(n * n);
  for (const r of res) for (let k = 0; k < n * n; k++) if (r.img[k] !== r.img[k]) blocked[k] = 1;
  let best = null, bd = Infinity;
  for (let j = half + 3; j < n - half - 3; j++) for (let i = half + 3; i < n - half - 3; i++) {
    const d = (i - near[0]) ** 2 + (j - near[1]) ** 2;
    if (d >= bd) continue;
    let ok = true;
    for (let dj = -half; dj <= half && ok; dj++) for (let di = -half; di <= half; di++) if (blocked[(j + dj) * n + i + di]) { ok = false; break; }
    if (ok) { bd = d; best = [i, j]; }
  }
  return best || near;
}

// Try every distance (and orbit tilt) and keep the sharpest stack for each distance.
// Returns [{d, tilt, peak, at}] ; `onStep(k, total)` may be async (lets a page stay responsive).
export const SCAN_DISTANCES = Array.from({ length: 56 }, (_, k) => 10 ** (1.3 + k * (3.35 - 1.3) / 55));     // 20 - 2240 AU
export const SCAN_TILTS = [-30, -20, -10, 0, 10, 20, 30];
export async function scan(res, ra, dec, n, scale, tRef, onStep = null, dists = SCAN_DISTANCES, tilts = SCAN_TILTS) {
  const out = [];
  for (const [k, d] of dists.entries()) {
    let best = { peak: -Infinity };
    for (const t of tilts) { const st = trackStack(res, ra, dec, n, scale, tRef, d, t); if (st.peak > best.peak) best = { peak: st.peak, tilt: t, at: st.at }; }
    out.push({ d, ...best });
    if (onStep) await onStep(k + 1, dists.length);
  }
  return out;
}

export const mjdToDate = (mjd) => new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10);
export { D2R, R2D, ASEC };
