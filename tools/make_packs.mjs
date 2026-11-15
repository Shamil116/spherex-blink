// Pre-download the cutouts of the preset targets into docs/packs/ so the presets open instantly, even on a slow
// network (run: node tools/make_packs.mjs [slug ...]). Uses the same code as the page (docs/core.js).
// This file was written with the help of an AI coding assistant (see README, "Use of AI").
import { mkdirSync, writeFileSync } from 'node:fs';
import * as C from '../docs/core.js';
import { PRESETS } from '../docs/presets.js';
import { WEB, readJson, pool } from './nodefetch.mjs';

const meta = readJson('index/meta.json'), wave = readJson('wave.json'), only = process.argv.slice(2);
mkdirSync(new URL('packs/', WEB), { recursive: true });
for (const p of PRESETS.filter((q) => q.pack && (!only.length || only.includes(q.pack)))) {
  const { n, scale } = C.gridFor(p.fov), t0 = Date.now();
  let rows = await C.findImages(meta, new URL('index/', WEB).href, () => [p.ra, p.dec], [[p.ra, p.dec]], 0.03);
  if (rows.length > 420) rows = rows.filter((_, k) => k % Math.ceil(rows.length / 420) === 0);      // dense polar fields: thin out
  let done = 0;
  const frames = (await pool(rows, 10, async (r) => {
    const f = await C.fetchFrame(r, p.ra, p.dec, n, scale, wave).catch(() => null);
    if (++done % 40 === 0) console.log(`  ${p.pack}: ${done} / ${rows.length}`);
    return f;
  })).filter(Boolean);
  const bin = new Float32Array(frames.length * n * n);
  frames.forEach((f, k) => bin.set(f.img, k * n * n));
  writeFileSync(new URL(`packs/${p.pack}.bin`, WEB), Buffer.from(bin.buffer));
  writeFileSync(new URL(`packs/${p.pack}.json`, WEB), JSON.stringify({
    name: p.name, ra: p.ra, dec: p.dec, fov: p.fov, n, scale, made: new Date().toISOString(),
    frames: frames.map(({ img, ...rest }) => rest),
  }));
  console.log(`${p.pack}: ${frames.length} of ${rows.length} exposures, ${(bin.byteLength / 1e6).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
