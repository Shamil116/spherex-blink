// SPHEREx Blink - user interface. All astronomy and data access is in core.js.
// This file was written with the help of an AI coding assistant (see README, "Use of AI").
import * as C from './core.js';
import { PRESETS } from './presets.js';

const $ = (id) => document.getElementById(id);
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'];   // one colour per epoch
const DET_RANGE = { 1: '0.75-1.1', 2: '1.1-1.6', 3: '1.6-2.4', 4: '2.4-3.8', 5: '3.8-4.4', 6: '4.4-5.0' };
const MAX_EPOCHS = SERIES.length, MAX_FRAMES = 700;
const yearOf = (mjd) => 2000 + (mjd - 51544.5) / 365.25;

const S = {
  meta: null, wave: null, ra: null, dec: null, name: '', n: 0, scale: 3.075, fov: 4,
  rows: [], epochs: [], frames: [], cache: new Map(), abort: null, loading: false,
  view: 'epochs', group: 0, idx: 0, seq: [], timer: null,
  ap: null, stars: { gaia: [], wise: [] }, pm: null, invert: false,
  dist: 500, tilt: 0, refEpoch: 0, resid: null, scan: null, injected: null, spec: [],
};

// ---------------------------------------------------------------- input: coordinates or a name
function parseSexa(s, hours) {
  const m = s.trim().match(/^([+-]?)(\d+)[:hd° ]\s*(\d+)[:m' ]\s*([\d.]+)/i);
  if (!m) return NaN;
  const v = (+m[2] + m[3] / 60 + m[4] / 3600) * (m[1] === '-' ? -1 : 1);
  return hours ? v * 15 : v;
}
async function resolveTarget(text) {
  text = text.trim();
  let m = text.match(/^([+-]?[\d.]+)[\s,]+([+-]?[\d.]+)$/);
  if (m) return { ra: +m[1], dec: +m[2], name: '' };
  m = text.match(/^(\d+[:h ]\s*\d+[:m ]\s*[\d.]+s?)[\s,]+([+-]?\d+[:d° ]\s*\d+[:m' ]\s*[\d.]+)/i);
  if (m) return { ra: parseSexa(m[1], true), dec: parseSexa(m[2], false), name: '' };
  const preset = PRESETS.find((p) => p.name.toLowerCase() === text.toLowerCase());
  if (preset) return { ...preset };
  for (const host of ['vizier.cfa.harvard.edu', 'cds.unistra.fr']) {          // CDS Sesame name resolver (and a mirror)
    try {
      const t = await (await fetch(`https://${host}/viz-bin/nph-sesame/-oI/SNV?${encodeURIComponent(text)}`, { signal: AbortSignal.timeout(9000) })).text();
      const j = t.match(/^%J\s+([\d.]+)\s+([+-]?[\d.]+)/m), p = t.match(/^%P\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)/m);
      if (!j) continue;
      let ra = +j[1], dec = +j[2], pm = null;
      if (p && Math.hypot(+p[1], +p[2]) > 100) {      // fast star: catalogue position is for 2000.0, move it to 2026.0
        ra += (+p[1] * 26 / 3.6e6) / Math.cos(dec * C.D2R); dec += +p[2] * 26 / 3.6e6; pm = [+p[1], +p[2], 2026.0];
      }
      return { ra, dec, name: text, pm };
    } catch { /* try the next host */ }
  }
  throw new Error(`Cannot understand "${text}". Type RA and Dec in degrees, for example: 133.7951 -7.2451`);
}

// ---------------------------------------------------------------- loading
function groupEpochs(rows) {
  if (!rows.length) return [];
  let groups = [[rows[0]]];
  for (let k = 1; k < rows.length; k++) (rows[k].mjd - rows[k - 1].mjd > 25 ? groups.push([rows[k]]) : groups.at(-1).push(rows[k]));
  if (groups.length === 1) {                 // continuous coverage (near the ecliptic poles): cut into equal time bins
    const t0 = rows[0].mjd, span = rows.at(-1).mjd - t0, nb = Math.min(MAX_EPOCHS, Math.max(1, Math.ceil(span / 45)));
    groups = Array.from({ length: nb }, () => []);
    for (const r of rows) groups[Math.min(nb - 1, Math.floor((r.mjd - t0) / span * nb))].push(r);
    groups = groups.filter((g) => g.length);
  }
  while (groups.length > MAX_EPOCHS) {       // merge the two closest neighbours
    let best = 0, gap = Infinity;
    for (let k = 0; k + 1 < groups.length; k++) { const d = groups[k + 1][0].mjd - groups[k].at(-1).mjd; if (d < gap) { gap = d; best = k; } }
    groups.splice(best, 2, groups[best].concat(groups[best + 1]));
  }
  return groups.map((g, e) => {
    g.forEach((r) => { r.epoch = e; });
    return { t0: g[0].mjd, t1: g.at(-1).mjd, label: `${C.mjdToDate(g[0].mjd)} to ${C.mjdToDate(g.at(-1).mjd).slice(5)}`, short: C.mjdToDate(g[Math.floor(g.length / 2)].mjd).slice(0, 7) };
  });
}
function selectRows(rows, depth, dets) {
  const out = [];
  for (let e = 0; e < S.epochs.length; e++) for (const d of dets) {
    const g = rows.filter((r) => r.epoch === e && r.det === d);
    if (g.length <= depth) { out.push(...g); continue; }
    for (let k = 0; k < depth; k++) out.push(g[Math.round(k * (g.length - 1) / (depth - 1 || 1))]);   // evenly spread in time = in wavelength
  }
  return [...new Set(out)].sort((a, b) => a.mjd - b.mjd);
}
const status = (html) => { $('status').innerHTML = html; };
const progress = (f) => { $('bar').firstElementChild.style.width = `${100 * f}%`; };

async function load() {
  S.abort?.abort();
  const abort = S.abort = new AbortController();
  stop();
  let target;
  try { status('Looking up the target…'); target = await resolveTarget($('q').value); } catch (e) { status(e.message); return; }
  if (!(target.ra >= 0 && target.ra <= 360 && Math.abs(target.dec) <= 90)) { status('RA must be 0-360 and Dec -90 to +90 degrees.'); return; }
  const fov = +$('fov').value, { scale, n } = C.gridFor(fov);
  const sameField = S.ra === target.ra && S.dec === target.dec && S.n === n;
  Object.assign(S, { ra: target.ra, dec: target.dec, name: target.name || '', pm: target.pm || null, fov, scale, n, loading: true });
  S.pmAp = !!S.pm;
  if (!sameField) Object.assign(S, { frames: [], ap: [(n - 1) / 2, (n - 1) / 2], stars: { gaia: [], wise: [] }, resid: null, scan: null, injected: null, idx: 0, seq: [] });
  $('q').value = `${S.ra.toFixed(5)} ${S.dec.toFixed(5)}`;
  $('go').disabled = true; $('stop').disabled = false; $('inject').textContent = 'Inject test planet';
  history.replaceState(null, '', `?ra=${S.ra.toFixed(5)}&dec=${S.dec.toFixed(5)}&fov=${fov}&depth=${$('depth').value}&view=${S.view}${S.group ? `&det=${S.group}` : ''}${S.name ? `&name=${encodeURIComponent(S.name)}` : ''}`);
  try {
    status('Searching the SPHEREx index…');
    S.rows = await C.findImages(S.meta, 'index/', () => [S.ra, S.dec], [[S.ra, S.dec]], 0.03);
    S.epochs = groupEpochs(S.rows);
    fillEpochSelects();
    if (!S.rows.length) { status('No SPHEREx images cover this position in the index.'); return; }
    const dets = [...document.querySelectorAll('#dets button.on')].map((b) => +b.dataset.det);
    let wanted = selectRows(S.rows, +$('depth').value, dets);
    if (wanted.length > MAX_FRAMES) wanted = wanted.filter((_, k) => k % Math.ceil(wanted.length / MAX_FRAMES) === 0);
    const have = new Set(S.frames.map((f) => f.url)), todo = wanted.filter((r) => !have.has(r.url));
    const epochOf = new Map(S.rows.map((r) => [r.url, r.epoch]));          // frames that came from a pack get their epoch here
    for (const f of S.frames) f.epoch = epochOf.get(f.url) ?? Math.max(0, S.epochs.findLastIndex((e) => e.t0 <= f.mjd));
    if (!S.stars.gaia.length) loadStars();
    rebuild();
    let done = 0, bytes = 0, failed = 0, lastDraw = 0;
    const t0 = performance.now(), queue = todo.slice();
    const worker = async () => {
      for (let row; (row = queue.shift());) {
        if (abort.signal.aborted) return;
        try {
          const f = await C.fetchFrame(row, S.ra, S.dec, n, scale, S.wave, abort.signal);
          if (f) { f.epoch = row.epoch; bytes += f.bytes; S.frames.push(f); }
        } catch (e) { if (abort.signal.aborted) return; failed++; }
        done++;
        progress(done / todo.length);
        status(`${S.rows.length} exposures cover this position in ${S.epochs.length} epoch${S.epochs.length > 1 ? 's' : ''}. Downloading ${done} / ${todo.length} (${(bytes / 1e6).toFixed(0)} MB)…`);
        if (performance.now() - lastDraw > 1500) { lastDraw = performance.now(); rebuild(true); }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    if (abort.signal.aborted) return;
    status(`<b>${S.frames.length}</b> of ${S.rows.length} exposures loaded (${S.epochs.length} epoch${S.epochs.length > 1 ? 's' : ''}, ${C.mjdToDate(S.rows[0].mjd)} to ${C.mjdToDate(S.rows.at(-1).mjd)}; ${(bytes / 1e6).toFixed(0)} MB in ${((performance.now() - t0) / 1000).toFixed(0)} s)${failed ? `; ${failed} failed` : ''}.` +
      (S.frames.length < S.rows.length ? ' Raise "exposures per detector" for more.' : ''));
  } catch (e) {
    if (!abort.signal.aborted) status(`Something went wrong: ${e.message}`);
  } finally {
    if (S.abort === abort) { S.loading = false; $('go').disabled = false; $('stop').disabled = true; S.resid = null; rebuild(); }
  }
}

// Gaia DR3 and CatWISE2020 sources through CDS VizieR (tries mirrors; the overlay is optional)
async function loadStars() {
  const cats = { gaia: ['I/355/gaiadr3', 'RA_ICRS,DE_ICRS,pmRA,pmDE,Gmag', 2016.0], wise: ['II/365/catwise', 'RA_ICRS,DE_ICRS,pmRA,pmDE,W1mproPM', 2015.4] };
  const ra = S.ra, dec = S.dec;
  for (const [key, [source, cols, epoch]] of Object.entries(cats)) {
    for (const host of ['vizier.cfa.harvard.edu', 'vizier.cds.unistra.fr', 'vizier.idia.ac.za']) {
      try {
        const url = `https://${host}/viz-bin/asu-tsv?-source=${source}&-c=${ra}${dec >= 0 ? '%2B' : ''}${dec}&-c.rm=${(S.fov * 0.75).toFixed(2)}&-out=${cols}&-out.max=400`;
        const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
        if (!r.ok) continue;
        const rowsTxt = (await r.text()).split('\n').filter((l) => /^\s*[\d.]+\t/.test(l));
        if (ra !== S.ra || dec !== S.dec) return;
        S.stars[key] = rowsTxt.map((l) => l.split('\t').map(Number)).map(([r_, d_, pr, pd, mag]) => {
          const k = key === 'wise' ? 1000 : 1;                               // CatWISE lists arcsec/yr, Gaia mas/yr
          return { ra: r_, dec: d_, pm: [(pr || 0) * k, (pd || 0) * k, epoch], mag };
        });
        S.stars[key] = S.stars[key].filter((s) => s.mag === s.mag).sort((x, y) => x.mag - y.mag).slice(0, 120);
        draw();
        break;
      } catch { /* next mirror */ }
    }
  }
}

// ---------------------------------------------------------------- what is on screen
const inGroup = (f) => !S.group || f.det === S.group;
const groupName = () => (S.group ? `detector ${S.group} (${DET_RANGE[S.group]} µm)` : 'all detectors (0.75-5.0 µm)');

function coadd(frames, offsets = null) {
  const st = C.stack(frames.map((f) => f.img), frames.map((f) => 1 / (f.noise * f.noise || 1)), S.n, S.scale, offsets, 'clip');
  return st;
}

function residuals() {            // star-subtracted exposures of the reference epoch (the fixed-sky model uses every epoch)
  S.resid ??= C.residuals(S.frames, S.n, S.scale);
  return S.resid.filter((r) => r.frame.epoch === S.refEpoch);
}
function refTime() {
  const fr = S.frames.filter((f) => f.epoch === S.refEpoch);
  return fr.length ? C.median(fr.map((f) => f.mjd)) : (S.frames.length ? C.median(S.frames.map((f) => f.mjd)) : 61000);
}
const trackStack = (dist, tilt, res = residuals()) => C.trackStack(res, S.ra, S.dec, S.n, S.scale, refTime(), dist, tilt);

function rebuild(keepIndex = false) {
  const frames = S.frames.filter(inGroup).sort((a, b) => a.mjd - b.mjd), seq = [];
  if (S.view === 'frames') {
    for (const f of frames) seq.push({ img: f.img, sigma: f.noise, mjd: f.mjd, frame: f });
  } else if (S.view === 'epochs' || S.view === 'diff') {
    const per = S.epochs.map((ep, e) => {
      const fr = frames.filter((f) => f.epoch === e);
      if (!fr.length) return null;
      const st = coadd(fr);
      return { img: st.img, sigma: C.robust(st.img)[1], mjd: C.median(fr.map((f) => f.mjd)), epoch: e, count: fr.length };
    });
    if (S.view === 'epochs') seq.push(...per.filter(Boolean));
    else {
      const a = per[+$('diffA').value], b = per[+$('diffB').value];
      if (a && b) {
        const img = new Float32Array(S.n * S.n);
        for (let k = 0; k < img.length; k++) img[k] = a.img[k] - b.img[k];
        seq.push({ img, sigma: C.robust(img)[1], mjd: a.mjd, diff: [a, b], symmetric: true });
      }
    }
  } else if (S.view === 'px' && !S.loading && S.frames.length) {
    const res = residuals();
    if (res.length >= 6) {
      const st = trackStack(S.dist, S.tilt, res);
      seq.push({ img: st.img, sigma: 1, mjd: refTime(), px: st, snr: true });
      const j = (st.at / S.n) | 0, i = st.at % S.n;
      $('pxinfo').innerHTML = `Stack of the ${res.length} star-subtracted exposures of epoch ${S.refEpoch + 1} along the ${S.dist.toFixed(0)} AU track (tilt ${S.tilt}°). ` +
        `Brightest point: <b>${st.peak.toFixed(1)} σ</b> at ${fmtSky(i, j)}.` + (st.peak >= 9 ? ' That is a strong signal: vet it (exposure movie, other epochs, Gaia/WISE overlays).' : ' Below about 9 σ is what noise and leftover artefacts produce.') + whereNext(i, j);
    } else $('pxinfo').textContent = 'Not enough exposures in this epoch: pick another epoch to stack or load more.';
  }
  S.seq = seq;
  S.idx = keepIndex ? Math.min(S.idx, Math.max(0, seq.length - 1)) : Math.min(S.idx, Math.max(0, seq.length - 1));
  $('pos').max = Math.max(0, seq.length - 1);
  spectrum();
  draw();
}

function fmtSky(i, j) {
  const c = (S.n - 1) / 2, [ra, dec] = C.deproject(-(i - c) * S.scale / 3600, -(j - c) * S.scale / 3600, S.ra, S.dec);
  return `RA ${ra.toFixed(5)}° Dec ${dec >= 0 ? '+' : ''}${dec.toFixed(5)}°`;
}
// sky position (with proper motion, at the date of the frame) -> image pixel
function starPixel(s, mjd) {
  const [xi, eta] = C.project(s.ra, s.dec, S.ra, S.dec), dt = yearOf(mjd) - s.pm[2], c = (S.n - 1) / 2;
  return [c - (xi * 3600 + s.pm[0] * dt / 1000) / S.scale, c - (eta * 3600 + s.pm[1] * dt / 1000) / S.scale];
}

const view = $('view'), over = $('over');
function draw() {
  const item = S.seq[S.idx], n = S.n;
  const W = over.width = over.clientWidth * devicePixelRatio, H = over.height = over.clientHeight * devicePixelRatio;
  const g = over.getContext('2d');
  $('pos').value = S.idx;
  if (!item) {
    view.width = view.height = 1; view.getContext('2d').fillRect(0, 0, 1, 1);
    $('caption').textContent = S.frames.length ? 'Nothing to show for this choice of detector and view.' : (S.loading ? 'Downloading…' : 'No images loaded yet.');
    $('details').innerHTML = '<span>—</span><span></span>';
    return;
  }
  // image: asinh stretch of the signal-to-noise ratio, so every frame has the same look
  view.width = view.height = n;
  const ctx = view.getContext('2d'), im = ctx.createImageData(n, n), contrast = +$('contrast').value;
  const hi = item.symmetric ? 60 / contrast ** 3 : 400 / contrast ** 4, lo = item.symmetric ? -hi : -2.5, soft = 4;
  const a0 = Math.asinh(lo / soft), a1 = Math.asinh(hi / soft);
  for (let k = 0; k < n * n; k++) {
    const v = item.img[k] / item.sigma;
    let t = (Math.asinh(Math.max(lo, Math.min(hi, v)) / soft) - a0) / (a1 - a0);
    if (S.invert) t = 1 - t;
    const o = 4 * k, c = Math.round(255 * t);
    if (v !== v) { im.data[o] = 46; im.data[o + 1] = 26; im.data[o + 2] = 30; } else { im.data[o] = im.data[o + 1] = im.data[o + 2] = c; }
    im.data[o + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);

  // overlays
  const X = (i) => (i + 0.5) / n * W, px = W / n, dpr = devicePixelRatio;
  g.lineWidth = 1.5 * dpr; g.font = `${12 * dpr}px system-ui, sans-serif`;
  for (const [key, colour, r] of [['gaia', '#199e70', 5], ['wise', '#9085e9', 8]]) {
    if (!$(key).classList.contains('on')) continue;
    g.strokeStyle = colour;
    g.globalAlpha = 0.8;
    for (const s of S.stars[key]) { const [i, j] = starPixel(s, item.mjd); g.beginPath(); g.arc(X(i), X(j), r * dpr, 0, 7); g.stroke(); }
    g.globalAlpha = 1;
  }
  if (S.pm) {
    const [i, j] = starPixel({ ra: S.ra, dec: S.dec, pm: S.pm }, item.mjd);
    g.strokeStyle = '#d95926'; g.beginPath(); g.arc(X(i), X(j), 11 * dpr, 0, 7); g.stroke();
  }
  if ($('marker').classList.contains('on') && S.ap) {
    g.strokeStyle = '#f0efec'; g.setLineDash([4 * dpr, 3 * dpr]);
    let [i, j] = S.ap;
    if (item.frame && S.follow) [i, j] = S.follow(item.frame);
    else if (S.pmAp && S.pm) [i, j] = starPixel({ ra: S.ra, dec: S.dec, pm: S.pm }, item.mjd);
    g.beginPath(); g.arc(X(i), X(j), 9 / S.scale * px, 0, 7); g.stroke(); g.setLineDash([]);
  }
  if (item.px) {                                         // peak of the Planet X stack
    const i = item.px.at % n, j = (item.px.at / n) | 0;
    g.strokeStyle = '#fab219'; g.strokeRect(X(i) - 9 * dpr, X(j) - 9 * dpr, 18 * dpr, 18 * dpr);
  }
  // compass and scale bar
  g.strokeStyle = g.fillStyle = '#f0efec'; g.lineWidth = 1.5 * dpr;
  const bar = 60 / S.scale * px, m = 14 * dpr;
  g.beginPath(); g.moveTo(m, H - m); g.lineTo(m + bar, H - m); g.stroke(); g.fillText("1 arcmin", m, H - m - 6 * dpr);
  g.beginPath(); g.moveTo(W - m, m + 34 * dpr); g.lineTo(W - m, m); g.moveTo(W - m, m + 34 * dpr); g.lineTo(W - m - 34 * dpr, m + 34 * dpr); g.stroke();
  g.fillText('N', W - m - 14 * dpr, m + 10 * dpr); g.fillText('E', W - m - 46 * dpr, m + 30 * dpr);

  // caption and details
  const f = item.frame, det = [];
  let cap;
  if (f) {
    cap = `<b>${f.date.replace('T', ' ').slice(0, 16)} UTC</b> · detector ${f.det} · <b>${f.wave.toFixed(3)} µm</b> · exposure ${S.idx + 1} of ${S.seq.length} · <a href="${f.url}" title="Download the full FITS image from the NASA archive">FITS</a>`;
    det.push(['Observation', f.obs], ['Data release', f.release.toUpperCase()], ['Time (UTC)', f.date.replace('T', ' ').slice(0, 19)],
      ['Detector', `${f.det} (${DET_RANGE[f.det]} µm)`], ['Wavelength here', `${f.wave.toFixed(4)} µm, channel width ${f.band.toFixed(4)} µm`],
      ['Exposure time', `${f.exptime.toFixed(1)} s`], ['Star image width', `${f.fwhm.toFixed(1)} arcsec (pixel ${C.NATIVE_ARCSEC} arcsec)`],
      ['Sky brightness', `${f.sky.toFixed(3)} MJy/sr (mostly zodiacal light, subtracted)`], ['Noise per pixel', `${f.noise.toFixed(4)} MJy/sr`],
      ['Detector pixel', `x ${f.x.toFixed(0)}, y ${f.y.toFixed(0)} of 2040`], ['Field covered', `${(100 * f.frac).toFixed(0)} %${f.frac < 0.98 ? ' (edge of detector or bad pixels)' : ''}`]);
  } else if (item.diff) {
    cap = `<b>Difference</b>: epoch ${S.epochs[item.diff[0].epoch].label} minus ${S.epochs[item.diff[1].epoch].label} · ${groupName()}. White = brighter in the first, black = brighter in the second. A moving star shows as a white-black pair.`;
    det.push(['Images added', `${item.diff[0].count} minus ${item.diff[1].count}`]);
  } else if (item.px) {
    cap = `<b>Planet X stack</b> of epoch ${S.refEpoch + 1} (${S.epochs[S.refEpoch]?.label}) for a circular orbit at ${S.dist.toFixed(0)} AU · signal-to-noise map · up to ${item.px.used} exposures overlap. The yellow box marks the brightest point; click it to read its spectrum.`;
    det.push(['Reference time', C.mjdToDate(item.mjd)], ['Peak', `${item.px.peak.toFixed(1)} σ`]);
  } else {
    cap = `<b>Epoch ${item.epoch + 1} of ${S.epochs.length}: ${S.epochs[item.epoch].label}</b> · ${item.count} exposures added · ${groupName()}`;
    det.push(['Epoch', S.epochs[item.epoch].label], ['Images added', String(item.count)], ['Band', groupName()]);
  }
  $('caption').innerHTML = cap;
  $('details').innerHTML = det.map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join('');
}

// If the brightest point is a body at the assumed distance, where is it in the other epochs? (links reopen the tool there)
function whereNext(i, j) {
  const c = (S.n - 1) / 2, [ra, dec] = C.deproject(-(i - c) * S.scale / 3600, -(j - c) * S.scale / 3600, S.ra, S.dec), rows = [];
  S.epochs.forEach((ep, e) => {
    if (e === S.refEpoch) return;
    const [o] = C.track(ra, dec, [(ep.t0 + ep.t1) / 2], refTime(), S.dist, S.tilt), [r2, d2] = C.deproject(o[0] / 3600, o[1] / 3600, ra, dec);
    rows.push(`epoch ${e + 1} (${ep.short}): <a href="?ra=${r2.toFixed(5)}&dec=${d2.toFixed(5)}&fov=${S.fov}&depth=${$('depth').value}&view=epochs">RA ${r2.toFixed(4)}° Dec ${d2.toFixed(4)}°</a>, ${(Math.hypot(o[0], o[1]) / 60).toFixed(1)} arcmin away`);
  });
  return rows.length ? `<br>If it is a body at ${S.dist.toFixed(0)} AU, look for it here in the other epochs: ${rows.join('; ')}.` : '';
}

// ---------------------------------------------------------------- spectrum
function spectrum() {
  const pts = [], c = (S.n - 1) / 2;
  S.follow = null;
  if (S.ap && S.frames.length) {
    if (S.view === 'px' || S.tracked) {                 // follow the moving body: aperture rides the track
      const frames = S.frames, offs = C.track(S.ra, S.dec, frames.map((f) => f.mjd), refTime(), S.dist, S.tilt), at = new Map();
      frames.forEach((f, k) => at.set(f, [S.ap[0] - offs[k][0] / S.scale, S.ap[1] - offs[k][1] / S.scale]));
      S.follow = (f) => at.get(f);
    } else if (S.pmAp && S.pm) S.follow = (f) => starPixel({ ra: S.ra, dec: S.dec, pm: S.pm }, f.mjd);   // ride the star's proper motion
    const tracking = S.view === 'px' || S.tracked;
    for (const f of S.frames) {
      if (tracking && f.epoch !== S.refEpoch) continue;       // a single-visit track says nothing about other epochs
      const [i, j] = S.follow ? S.follow(f) : S.ap;
      if (!(i >= 4 && i < S.n - 4 && j >= 4 && j < S.n - 4)) continue;
      const [flux, err] = C.aperture(f, i, j);
      if (flux === flux) pts.push({ wave: f.wave + f.wgrad[0] * (i - c) + f.wgrad[1] * (j - c), band: f.band, flux, err, f });
    }
  }
  S.spec = pts;
  $('specnote').textContent = !S.follow ? 'Click the image to move the aperture.' : S.pmAp && S.view !== 'px' && !S.tracked ? 'Aperture follows the star as it moves.' : `Aperture follows the ${S.dist.toFixed(0)} AU track.`;
  drawSpectrum();
}
function drawSpectrum(hover = null) {
  const cv = $('spec'), dpr = devicePixelRatio, W = cv.width = cv.clientWidth * dpr, H = cv.height = 230 * dpr, g = cv.getContext('2d');
  const L = 52 * dpr, R = 10 * dpr, T = 10 * dpr, B = 34 * dpr, pts = S.spec;
  g.font = `${11.5 * dpr}px system-ui, sans-serif`; g.textBaseline = 'middle';
  const x0 = 0.7, x1 = 5.1;
  let ys = pts.map((p) => p.flux).sort((a, b) => a - b), yLo = 0, yHi = 1;
  if (ys.length) {
    const p3 = ys[Math.floor(0.03 * (ys.length - 1))], p97 = ys[Math.floor(0.97 * (ys.length - 1))], errMed = C.median(pts.map((p) => p.err));
    yHi = Math.max(p97 + 0.2 * (p97 - p3), 4 * errMed); yLo = Math.min(0, p3 - 0.1 * (p97 - p3), -1.5 * errMed);
  }
  const unit = yHi >= 2000 ? ['mJy', 1000] : ['µJy', 1];
  const X = (w) => L + (w - x0) / (x1 - x0) * (W - L - R), Y = (f) => H - B - (f - yLo) / (yHi - yLo) * (H - T - B);
  g.strokeStyle = '#33332f'; g.fillStyle = '#8f8e86'; g.lineWidth = dpr;
  g.textAlign = 'center';
  for (let w = 1; w <= 5; w++) { g.beginPath(); g.moveTo(X(w), T); g.lineTo(X(w), H - B); g.stroke(); g.fillText(String(w), X(w), H - B + 10 * dpr); }
  g.fillText('wavelength (µm)', (L + W - R) / 2, H - 8 * dpr);
  g.textAlign = 'right';
  const step = niceStep((yHi - yLo) / 4);
  for (let v = Math.ceil(yLo / step) * step; v <= yHi; v += step) { g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(W - R, Y(v)); g.stroke(); g.fillText(fmtNum(v / unit[1]), L - 6 * dpr, Y(v)); }
  g.save(); g.translate(11 * dpr, (T + H - B) / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.fillText(`flux (${unit[0]})`, 0, 0); g.restore();
  if (yLo < 0) { g.strokeStyle = '#6b6a63'; g.beginPath(); g.moveTo(L, Y(0)); g.lineTo(W - R, Y(0)); g.stroke(); }
  cv._map = [];
  for (const p of pts) {
    const px = X(p.wave), py = Math.max(T, Math.min(H - B, Y(p.flux))), col = SERIES[p.f.epoch % SERIES.length];
    g.strokeStyle = col; g.globalAlpha = 0.45; g.lineWidth = dpr;
    g.beginPath(); g.moveTo(px, Math.max(T, Y(p.flux + p.err))); g.lineTo(px, Math.min(H - B, Y(p.flux - p.err))); g.stroke();
    g.globalAlpha = 1; g.fillStyle = col; g.strokeStyle = '#1a1a19'; g.lineWidth = 1.5 * dpr;
    g.beginPath(); g.arc(px, py, (p === hover ? 6 : 4) * dpr, 0, 7); g.fill(); g.stroke();
    cv._map.push([px / dpr, py / dpr, p]);
  }
  if (!pts.length) { g.fillStyle = '#8f8e86'; g.textAlign = 'center'; g.fillText(S.frames.length ? 'No valid measurements at this position' : 'Load images to see a spectrum', W / 2, H / 2); }
  const used = [...new Set(pts.map((p) => p.f.epoch))].sort((a, b) => a - b);
  $('legend').innerHTML = used.map((e) => `<span><i style="background:${SERIES[e % SERIES.length]}"></i>${S.epochs[e]?.label ?? ''}</span>`).join('');
}
const niceStep = (raw) => { const p = 10 ** Math.floor(Math.log10(raw)), m = raw / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; };
const fmtNum = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(2).replace(/\.?0+$/, '') || '0');

function downloadCsv() {
  const rows = ['mjd,date_utc,epoch,detector,wavelength_um,channel_width_um,flux_uJy,flux_err_uJy,observation,fits_url'];
  for (const p of [...S.spec].sort((a, b) => a.wave - b.wave))
    rows.push([p.f.mjd.toFixed(5), p.f.date, p.f.epoch + 1, p.f.det, p.wave.toFixed(5), p.band.toFixed(5), p.flux.toFixed(2), p.err.toFixed(2), p.f.obs, p.f.url].join(','));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
  a.download = `spherex_spectrum_${S.ra.toFixed(4)}_${S.dec.toFixed(4)}.csv`; a.click();
}

// ---------------------------------------------------------------- Planet X: scan, injection
async function scanDistances() {
  const res = residuals();
  if (res.length < 6) return;
  $('scanBtn').disabled = true;
  const out = await C.scan(res, S.ra, S.dec, S.n, S.scale, refTime(), (k, total) => {
    $('pxinfo').textContent = `Scanning… ${k} / ${total} distances`;
    return new Promise((r) => setTimeout(r));
  });
  S.scan = out;
  const top = out.reduce((a, b) => (b.peak > a.peak ? b : a)), floor = C.median(out.map((o) => o.peak));
  setTrack(top.d, top.tilt);
  S.ap = [top.at % S.n, (top.at / S.n) | 0]; S.tracked = true;      // put the aperture on the detection: its spectrum follows the track
  $('scanBtn').disabled = false;
  rebuild();
  $('pxinfo').innerHTML += `<br>Scan: best distance <b>${top.d.toFixed(0)} AU</b> (tilt ${top.tilt}°) at <b>${top.peak.toFixed(1)} σ</b>; typical maximum of a wrong track is ${floor.toFixed(1)} σ.`;
  drawScan();
}
function drawScan() {
  const cv = $('scan'), dpr = devicePixelRatio, W = cv.width = cv.clientWidth * dpr, H = cv.height = 170 * dpr, g = cv.getContext('2d');
  if (!S.scan) return;
  const L = 40 * dpr, R = 10 * dpr, T = 10 * dpr, B = 32 * dpr, lo = 1.3, hi = 3.35;
  const ymax = Math.max(8, ...S.scan.map((o) => o.peak)) * 1.1;
  const X = (d) => L + (Math.log10(d) - lo) / (hi - lo) * (W - L - R), Y = (v) => H - B - v / ymax * (H - T - B);
  g.font = `${11.5 * dpr}px system-ui, sans-serif`; g.textBaseline = 'middle'; g.strokeStyle = '#33332f'; g.fillStyle = '#8f8e86'; g.lineWidth = dpr;
  g.textAlign = 'center';
  for (const d of [30, 100, 300, 1000]) { g.beginPath(); g.moveTo(X(d), T); g.lineTo(X(d), H - B); g.stroke(); g.fillText(String(d), X(d), H - B + 10 * dpr); }
  g.fillText('assumed distance (AU)', (L + W - R) / 2, H - 8 * dpr);
  g.textAlign = 'right';
  const step = niceStep(ymax / 4);
  for (let v = 0; v <= ymax; v += step) { g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(W - R, Y(v)); g.stroke(); g.fillText(String(v), L - 6 * dpr, Y(v)); }
  g.save(); g.translate(10 * dpr, (T + H - B) / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.fillText('peak (σ)', 0, 0); g.restore();
  g.strokeStyle = '#3987e5'; g.lineWidth = 2 * dpr; g.beginPath();
  S.scan.forEach((o, k) => (k ? g.lineTo(X(o.d), Y(o.peak)) : g.moveTo(X(o.d), Y(o.peak)))); g.stroke();
  g.strokeStyle = '#f0efec'; g.lineWidth = dpr; g.setLineDash([3 * dpr, 3 * dpr]); g.beginPath(); g.moveTo(X(S.dist), T); g.lineTo(X(S.dist), H - B); g.stroke(); g.setLineDash([]);
  cv._map = S.scan.map((o) => [X(o.d) / dpr, Y(o.peak) / dpr, o]);
}
function setTrack(d, tilt) {
  S.dist = d; S.tilt = tilt;
  $('dist').value = Math.log10(d); $('tilt').value = tilt; $('distv').textContent = d.toFixed(0); $('tiltv').textContent = tilt;
}
// Add (or remove) an artificial point source that moves like a body at the chosen distance.
function toggleInjection() {
  const sign = S.injected ? -1 : 1;
  const inj = S.injected || { flux: +$('injFlux').value, dist: +$('injDist').value, at: C.clearPixel(residuals(), S.n, [Math.round(S.n * 0.62), Math.round(S.n * 0.4)]), t: refTime() };
  C.inject(S.frames, S.n, S.scale, S.ra, S.dec, inj.at, inj.t, inj.dist, inj.flux, sign);
  S.injected = S.injected ? null : inj;
  $('inject').textContent = S.injected ? 'Remove test planet' : 'Inject test planet';
  S.resid = null; S.scan = null;
  if (S.injected) { setTrack(inj.dist, 0); S.ap = inj.at.slice(); }
  rebuild();
  if (S.injected) $('pxinfo').innerHTML += `<br>Test planet: ${inj.flux} µJy (AB ${(-2.5 * Math.log10(inj.flux * 1e-6 / 3631)).toFixed(1)}) at ${inj.dist} AU, placed at ${fmtSky(inj.at[0], inj.at[1])}.`;
}

// ---------------------------------------------------------------- controls
function stop() { clearInterval(S.timer); S.timer = null; $('play').textContent = 'Play'; }
function play() {
  if (S.timer) return stop();
  $('play').textContent = 'Pause';
  S.timer = setInterval(() => { if (S.seq.length > 1) { S.idx = (S.idx + 1) % S.seq.length; draw(); } }, +$('speed').value);
}
function step(d) { stop(); if (S.seq.length) { S.idx = (S.idx + d + S.seq.length) % S.seq.length; draw(); } }
function setView(v) {
  S.view = v; S.idx = 0;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  document.body.classList.toggle('px', v === 'px');
  $('diffrow').style.display = v === 'diff' ? 'flex' : 'none';
  $('groups').style.visibility = v === 'px' ? 'hidden' : 'visible';
  rebuild();
  if (v === 'px') drawScan();
}
function setGroup(d) {
  S.group = d;
  document.querySelectorAll('#groups button').forEach((b) => b.classList.toggle('on', +b.dataset.det === d));
  rebuild(true);
}
function fillEpochSelects() {
  const opts = S.epochs.map((e, k) => `<option value="${k}">${k + 1}: ${e.label}</option>`).join('');
  for (const id of ['diffA', 'diffB', 'refEpoch']) $(id).innerHTML = opts;
  $('diffA').value = S.epochs.length - 1; $('diffB').value = 0;
  S.refEpoch = Math.min(S.refEpoch, Math.max(0, S.epochs.length - 1)); $('refEpoch').value = S.refEpoch;
}
// A pack is a pre-downloaded copy of a preset's cutouts (made by tools/make_packs.mjs): the preset opens at once.
async function loadPack(p) {
  try {
    const [meta, bin] = await Promise.all([fetch(`packs/${p.pack}.json`).then((r) => r.json()), fetch(`packs/${p.pack}.bin`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))]);
    const n = meta.n, data = new Float32Array(bin);
    if (data.length !== meta.frames.length * n * n) return;
    S.abort?.abort();
    Object.assign(S, { ra: meta.ra, dec: meta.dec, n, scale: meta.scale, fov: meta.fov, ap: [(n - 1) / 2, (n - 1) / 2], stars: { gaia: [], wise: [] },
      resid: null, scan: null, injected: null, idx: 0, seq: [],
      frames: meta.frames.map((f, k) => ({ ...f, n, scale: meta.scale, epoch: 0, img: data.slice(k * n * n, (k + 1) * n * n) })) });
  } catch { /* no pack: the images are downloaded live */ }
}
async function applyPreset(p) {
  $('q').value = p.name; $('fov').value = p.fov;
  status(`${p.note}. Opening…`);
  if (p.pack) await loadPack(p);
  if (p.px) setTrack(...p.px);
  S.tracked = false;
  if (p.group !== undefined) setGroupSilently(p.group);
  if (p.view) setView(p.view);
  await load();
  status(`${p.name}: ${p.note}.<br>${$('status').innerHTML}`);
}
function setGroupSilently(d) { S.group = d; document.querySelectorAll('#groups button').forEach((b) => b.classList.toggle('on', +b.dataset.det === d)); }

function init() {
  $('presets').innerHTML = PRESETS.map((p, k) => `<button data-k="${k}" title="${p.note}">${p.name}</button>`).join('');
  $('presets').onclick = (e) => { if (e.target.dataset.k) applyPreset(PRESETS[+e.target.dataset.k]); };
  $('dets').innerHTML = [1, 2, 3, 4, 5, 6].map((d) => `<button class="on" data-det="${d}" title="${DET_RANGE[d]} µm">${d}: ${DET_RANGE[d]}</button>`).join('');
  $('dets').onclick = (e) => { if (e.target.dataset.det) e.target.classList.toggle('on'); };
  $('groups').innerHTML = `<span class="muted">Show</span><button class="on" data-det="0">all detectors</button>` + [1, 2, 3, 4, 5, 6].map((d) => `<button data-det="${d}" title="${DET_RANGE[d]} µm">${d}</button>`).join('');
  $('groups').onclick = (e) => { if (e.target.dataset.det !== undefined) setGroup(+e.target.dataset.det); };
  $('tabs').onclick = (e) => { if (e.target.dataset.view) setView(e.target.dataset.view); };
  $('go').onclick = load;
  $('q').onkeydown = (e) => { if (e.key === 'Enter') load(); };
  $('stop').onclick = () => { S.abort?.abort(); S.loading = false; $('go').disabled = false; $('stop').disabled = true; status('Stopped.'); rebuild(); };
  $('share').onclick = () => { navigator.clipboard?.writeText(location.href); $('share').textContent = 'Link copied'; setTimeout(() => ($('share').textContent = 'Copy link'), 1500); };
  $('play').onclick = play; $('prev').onclick = () => step(-1); $('next').onclick = () => step(1);
  $('pos').oninput = () => { stop(); S.idx = +$('pos').value; draw(); };
  $('speed').onchange = () => { if (S.timer) { stop(); play(); } };
  $('contrast').oninput = draw;
  $('invert').onclick = () => { S.invert = !S.invert; $('invert').classList.toggle('on', S.invert); draw(); };
  for (const id of ['gaia', 'wise', 'marker']) $(id).onclick = () => { $(id).classList.toggle('on'); draw(); };
  $('diffA').onchange = $('diffB').onchange = () => rebuild();
  $('refEpoch').onchange = () => { S.refEpoch = +$('refEpoch').value; S.scan = null; rebuild(); drawScan(); };
  $('dist').oninput = $('tilt').oninput = () => { setTrack(10 ** +$('dist').value, +$('tilt').value); rebuild(); drawScan(); };
  $('scanBtn').onclick = scanDistances;
  $('inject').onclick = () => { if (S.frames.length) toggleInjection(); };
  $('csv').onclick = downloadCsv;
  document.onkeydown = (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;
    if (e.key === ' ') { e.preventDefault(); play(); } else if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'ArrowRight') step(1);
  };
  const toPixel = (e) => { const r = over.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * S.n - 0.5, (e.clientY - r.top) / r.height * S.n - 0.5]; };
  over.onmousemove = (e) => {
    const item = S.seq[S.idx]; if (!item) return;
    const [i, j] = toPixel(e), k = Math.round(j) * S.n + Math.round(i), v = item.img[k];
    $('readout').textContent = `${fmtSky(i, j)} · ${v === v ? `${(v / item.sigma).toFixed(1)} σ` : 'no data'}`;
  };
  over.onclick = (e) => { S.ap = toPixel(e); S.tracked = S.view === 'px'; S.pmAp = false; spectrum(); draw(); };
  const tip = $('tip');
  const hoverChart = (cv, text, redraw) => {
    cv.onmousemove = (e) => {
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null, bd = 14;
      for (const [px, py, p] of cv._map || []) { const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = p; } }
      redraw?.(best);
      if (!best) { tip.style.display = 'none'; return; }
      tip.textContent = text(best); tip.style.display = 'block';
      tip.style.left = `${Math.min(e.clientX + 14, innerWidth - 240)}px`; tip.style.top = `${e.clientY + 14}px`;
    };
    cv.onmouseleave = () => { tip.style.display = 'none'; redraw?.(null); };
  };
  hoverChart($('spec'), (p) => `${p.wave.toFixed(3)} µm (detector ${p.f.det})\n${p.flux.toFixed(0)} ± ${p.err.toFixed(0)} µJy\n${p.f.date.slice(0, 10)}`, drawSpectrum);
  hoverChart($('scan'), (o) => `${o.d.toFixed(0)} AU, tilt ${o.tilt}°\npeak ${o.peak.toFixed(1)} σ`);
  $('spec').onclick = () => { const cv = $('spec'); /* jump the movie to the hovered exposure */
    const p = cv._hover; if (p && S.view === 'frames') { S.idx = S.seq.findIndex((s) => s.frame === p.f); draw(); } };
  addEventListener('resize', () => { draw(); drawSpectrum(); drawScan(); });
}

async function start() {
  init();
  try {
    [S.meta, S.wave] = await Promise.all([fetch('index/meta.json').then((r) => r.json()), fetch('wave.json').then((r) => r.json())]);
  } catch (e) { status('Cannot load the sky index (index/meta.json). Run tools/build_index.py first.'); return; }
  status(`Index ready: ${S.meta.n_images.toLocaleString('en')} SPHEREx images, ${C.mjdToDate(S.meta.mjd_min)} to ${C.mjdToDate(S.meta.mjd_max)} (releases ${S.meta.releases.join(', ').toUpperCase()}). Pick a target or type coordinates.`);
  const q = new URLSearchParams(location.search);
  if (q.has('fov')) $('fov').value = q.get('fov');
  if (q.has('depth')) $('depth').value = q.get('depth');
  if (q.has('det')) setGroupSilently(+q.get('det'));
  if (q.has('view')) setView(q.get('view'));
  if (q.has('dist')) setTrack(+q.get('dist'), +(q.get('tilt') || 0));
  const preset = PRESETS.find((p) => p.name === q.get('name'));
  if (preset && !q.has('view')) return applyPreset(preset);
  if (q.has('ra') && q.has('dec')) { $('q').value = preset ? preset.name : `${q.get('ra')} ${q.get('dec')}`; load(); }
}
start();
