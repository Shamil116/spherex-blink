// Self-check of docs/core.js against astropy (run: node tests/test_core.mjs). Fixtures: the first 40 kB of a real
// SPHEREx Level-2 file and values computed with astropy for the same file.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import * as C from '../docs/core.js';

const here = new URL('.', import.meta.url);
const bytes = new Uint8Array(readFileSync(new URL('header_D1.bin', here)));
const truth = JSON.parse(readFileSync(new URL('truth.json', here)));
const wave = JSON.parse(readFileSync(new URL('../docs/wave.json', here)));

const prim = C.parseHeader(bytes, 0), ext = C.parseHeader(bytes, prim.dataStart);
assert.equal(prim.dataStart, 2880);
assert.equal(ext.dataStart, 28800);
assert.equal(ext.h.NAXIS1, 2040);
assert.equal(ext.h.OBSID, '2025W17_4B_0001_1');
const w = C.makeWcs(ext.h);

let worstSky = 0, worstPix = 0, worstLam = 0;
truth.pts.forEach(([x, y], k) => {
  const [ra, dec] = C.pix2sky(w, x, y), [tra, tdec] = truth.sky[k];
  worstSky = Math.max(worstSky, Math.hypot((ra - tra) * Math.cos(dec * C.D2R), dec - tdec) * 3600);
  const [bx, by] = C.sky2pix(w, tra, tdec);
  worstPix = Math.max(worstPix, Math.hypot(bx - x, by - y));
  worstLam = Math.max(worstLam, Math.abs(C.wavelength(wave['1'], x, y)[0] - truth.lam[k][0]));
});
console.log(`pix->sky worst error ${worstSky.toExponential(2)} arcsec; sky->pix ${worstPix.toExponential(2)} px; wavelength ${worstLam.toExponential(2)} um`);
assert(worstSky < 0.01 && worstPix < 0.01 && worstLam < 1e-4);

let worstEarth = 0;
for (const [mjd, x, y, z] of truth.earth) {
  const e = C.earthHelio(mjd);
  worstEarth = Math.max(worstEarth, Math.hypot(e[0] - x, e[1] - y, e[2] - z));
}
console.log(`Earth position worst error ${worstEarth.toExponential(2)} AU`);
assert(worstEarth < 5e-4);

// parallax: a body at 500 AU seen at the ecliptic, half a year apart, shifts by about 2 x 206265/500 arcsec
const tr = C.track(90, 23.44, [61000, 61000 + 182.6], 61000, 500, 0, false);
const shift = Math.hypot(tr[1][0] - tr[0][0], tr[1][1] - tr[0][1]);
console.log(`500 AU half-year parallax shift ${shift.toFixed(0)} arcsec`);
assert(shift > 300 && shift < 830);

// stacking: a source moved by a known offset is recovered at full height only with the matching shift
const n = 21, f0 = new Float32Array(n * n), f1 = new Float32Array(n * n);
f0[10 * n + 10] = 1; f1[8 * n + 13] = 1;            // 3 px west (right), 2 px north (up)
const s = C.stack([f0, f1], [1, 1], n, 3, [[0, 0], [-9, 6]], 'mean');
assert.equal(s.img[10 * n + 10], 1);
assert.equal(C.stack([f0, f1], [1, 1], n, 3, null, 'mean').img[10 * n + 10], 0.5);

// index cells: the cell of a position is among the cells searched around it
assert(C.cellsNear(10, 89.5, 2.7, 3).length >= 1 && C.cellsNear(359.9, 0, 2.7, 3).some(([b, i]) => i === 0));
assert(C.inFootprint(45, 17, 45.2, 15.5, 345, 1.745) && !C.inFootprint(45, 20, 45.2, 15.5, 345, 1.745));
console.log('all checks passed');

// trimmed mean: one wild value among ten is ignored, and the result equals the mean of the kept values
{
  const fr = Array.from({ length: 10 }, (_, k) => Float32Array.of(k === 3 ? 1e6 : k === 7 ? 50 : 1));
  const t = C.stack(fr, fr.map(() => 1), 1, 3, null, 'clip');
  assert.equal(t.img[0], 1);
  assert.equal(C.stack(fr.slice(0, 3), [1, 1, 1], 1, 3, null, 'clip').img[0], 1);
  console.log('trimmed mean ok');
}
