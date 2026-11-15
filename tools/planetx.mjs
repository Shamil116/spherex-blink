// Planet X search from the command line, with the same code the web page runs (docs/core.js).
//
//   node tools/planetx.mjs pack <slug> [--dets 12] [--inject <microJy> <AU>]   scan a pre-downloaded pack (docs/packs/)
//   node tools/planetx.mjs field <ra> <dec> [--fov 10] [--dets 12] [--save <slug>] [--inject <microJy> <AU>]
//                                                                       download one field from the archive and scan it
//
// For every epoch it removes the fixed sky, shift-and-stacks the exposures along the track of a body at each trial
// distance (20-2240 AU) and orbit tilt, and reports the sharpest point. With --inject it first adds an artificial
// moving point source, to show what the search can recover. One JSON line per run is appended to
// results/planetx.jsonl.
// This file was written with the help of an AI coding assistant (see README, "Use of AI").
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as C from '../docs/core.js';
import { WEB, readJson, pool } from './nodefetch.mjs';

const args = process.argv.slice(2), mode = args[0];
const opt = (name, count = 1) => { const k = args.indexOf(`--${name}`); return k < 0 ? null : args.slice(k + 1, k + 1 + count); };
let ra, dec, n, scale, frames, label;

if (mode === 'pack') {
  const meta = readJson(`packs/${args[1]}.json`), bin = readFileSync(new URL(`packs/${args[1]}.bin`, WEB));
  ({ ra, dec, n, scale } = meta); label = meta.name;
  const data = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
  frames = meta.frames.map((f, k) => ({ ...f, img: data.slice(k * n * n, (k + 1) * n * n) }));
} else if (mode === 'field') {
  ra = +args[1]; dec = +args[2]; label = `field ${ra} ${dec}`;
  ({ n, scale } = C.gridFor(+(opt('fov')?.[0] ?? 10)));
  const dets = (opt('dets')?.[0] ?? '123456').split('').map(Number);
  const meta = readJson('index/meta.json'), wave = readJson('wave.json');
  const rows = (await C.findImages(meta, new URL('index/', WEB).href, () => [ra, dec], [[ra, dec]], 0.03)).filter((r) => dets.includes(r.det));
  console.log(`${label}: downloading ${rows.length} exposures (detectors ${dets.join('')})…`);
  frames = (await pool(rows, 10, (r) => C.fetchFrame(r, ra, dec, n, scale, wave).catch(() => null))).filter(Boolean);
  const save = opt('save')?.[0];
  if (save) {                                               // keep the cutouts as a pack: reusable here and in the page
    const bin = new Float32Array(frames.length * n * n);
    frames.forEach((f, k) => bin.set(f.img, k * n * n));
    mkdirSync(new URL('packs/', WEB), { recursive: true });
    writeFileSync(new URL(`packs/${save}.bin`, WEB), Buffer.from(bin.buffer));
    writeFileSync(new URL(`packs/${save}.json`, WEB), JSON.stringify({ name: label, ra, dec, fov: +(opt('fov')?.[0] ?? 10), n, scale, made: new Date().toISOString(), frames: frames.map(({ img, ...rest }) => rest) }));
  }
} else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 11).join('\n'));
  process.exit(1);
}
if (mode === 'pack' && opt('dets')) { const keep = opt('dets')[0].split('').map(Number); frames = frames.filter((f) => keep.includes(f.det)); label += ` (detectors ${keep.join('')})`; }
frames.sort((a, b) => a.mjd - b.mjd);

// epochs: visits separated by more than 25 days
const epochs = [[frames[0]]];
for (let k = 1; k < frames.length; k++) (frames[k].mjd - frames[k - 1].mjd > 25 ? epochs.push([frames[k]]) : epochs.at(-1).push(frames[k]));
const skyOf = (at) => C.deproject(-((at % n) - (n - 1) / 2) * scale / 3600, -(((at / n) | 0) - (n - 1) / 2) * scale / 3600, ra, dec);
console.log(`${label}: ${frames.length} exposures, ${epochs.length} epochs, grid ${n} x ${n} px of ${scale} arcsec`);

const inj = opt('inject', 2)?.map(Number);
const result = { label, ra, dec, fov_arcmin: +(n * scale / 60).toFixed(1), exposures: frames.length, utc: new Date().toISOString(), epochs: [] };
for (const ep of epochs) {
  if (ep.length < 12) continue;                            // too few exposures to stack
  const tRef = C.median(ep.map((f) => f.mjd)), inEpoch = (r) => r.mjd >= ep[0].mjd && r.mjd <= ep.at(-1).mjd;
  // one visit at a time: the fixed-sky model uses every epoch, the stack only this one
  const res0 = C.residuals(frames, n, scale).filter(inEpoch), at = C.clearPixel(res0, n, [Math.round(n * 0.62), Math.round(n * 0.4)]);
  const blind = await C.scan(res0, ra, dec, n, scale, tRef);
  const top = blind.reduce((a, b) => (b.peak > a.peak ? b : a)), [pra, pdec] = skyOf(top.at);
  const row = { epoch: C.mjdToDate(tRef), exposures: ep.length, best_au: +top.d.toFixed(0), tilt: top.tilt, peak_sigma: +top.peak.toFixed(1),
    median_peak_sigma: +C.median(blind.map((o) => o.peak)).toFixed(1), ra: +pra.toFixed(5), dec: +pdec.toFixed(5) };
  let msg = `  epoch ${row.epoch} (${ep.length} exp): sharpest stack ${row.peak_sigma} sigma at ${row.best_au} AU, tilt ${row.tilt} deg, RA ${row.ra} Dec ${row.dec} (median over distances ${row.median_peak_sigma})`;
  if (inj) {                                               // injection-recovery: add a fake body, search again, take it out
    C.inject(frames, n, scale, ra, dec, at, tRef, inj[1], inj[0], 1);
    const sc = await C.scan(C.residuals(frames, n, scale).filter(inEpoch), ra, dec, n, scale, tRef);
    C.inject(frames, n, scale, ra, dec, at, tRef, inj[1], inj[0], -1);
    const got = sc.reduce((a, b) => (b.peak > a.peak ? b : a)), sep = Math.hypot((got.at % n) - at[0], ((got.at / n) | 0) - at[1]) * scale;
    Object.assign(row, { injected_uJy: inj[0], injected_au: inj[1], injected_ab: +(-2.5 * Math.log10(inj[0] * 1e-6 / 3631)).toFixed(2),
      recovered_sigma: +got.peak.toFixed(1), recovered_au: +got.d.toFixed(0), offset_arcsec: +sep.toFixed(1), recovered: sep < 12 && got.peak >= Math.max(9, top.peak + 1) });
    msg += `; injected ${inj[0]} uJy (AB ${row.injected_ab}) at ${inj[1]} AU -> ${row.recovered ? 'RECOVERED' : 'not recovered'}: ${row.recovered_sigma} sigma, ${row.offset_arcsec} arcsec from the injected position`;
  }
  result.epochs.push(row);
  console.log(msg);
}
mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
appendFileSync(new URL('../results/planetx.jsonl', import.meta.url), JSON.stringify(result) + '\n');
