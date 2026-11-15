// Network smoke test of docs/core.js (run: node tests/fetch_demo.mjs [ra dec]).
// Finds SPHEREx images covering a position through the static index, downloads a few cutouts from Amazon S3
// and prints what came back.
import { readFileSync } from 'node:fs';
import * as C from '../docs/core.js';

const [ra, dec] = process.argv.length > 3 ? process.argv.slice(2, 4).map(Number) : [133.795129, -7.245147];   // WISE 0855
const web = new URL('../docs/', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, web)));
const meta = read('index/meta.json'), wave = read('wave.json');
// the index is read from disk here; the browser fetches the same files over HTTP
globalThis.fetch = ((orig) => (url, opt) => (String(url).startsWith('file:')
  ? Promise.resolve({ ok: true, json: async () => JSON.parse(readFileSync(new URL(url))) }).catch(() => ({ ok: false }))
  : orig(url, opt)))(globalThis.fetch);

const rows = await C.findImages(meta, new URL('index/', web).href, () => [ra, dec], [[ra, dec]]);
console.log(`${rows.length} images cover RA ${ra} Dec ${dec}; first ${C.mjdToDate(rows[0].mjd)}, last ${C.mjdToDate(rows.at(-1).mjd)}`);
const pick = rows.filter((_, k) => k % Math.ceil(rows.length / 8) === 0);
const t0 = Date.now();
const frames = await Promise.all(pick.map((r) => C.fetchFrame(r, ra, dec, 78, 3.075, wave)));
console.log(`${pick.length} cutouts in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
for (const f of frames) {
  if (!f) { console.log('  (image does not cover the position after all)'); continue; }
  console.log(`  D${f.det} ${f.date} ${f.wave.toFixed(3)} um  sky ${f.sky.toFixed(3)} MJy/sr  noise ${f.noise.toFixed(4)}  covered ${(100 * f.frac).toFixed(0)}%  ${(f.bytes / 1024).toFixed(0)} kB`);
}
