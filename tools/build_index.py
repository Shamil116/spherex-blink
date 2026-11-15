"""Build the static sky index of SPHEREx Level-2 images that the web tool uses instead of a search server.

Why: the browser cannot query the IRSA search services (no CORS, and they are often overloaded), but it can read
the public SPHEREx bucket on Amazon S3 directly. This script lists every Level-2 file in the bucket, reads the
pointing of each exposure from a 1 kB slice of one FITS header, and writes small JSON "shards" (one per sky cell)
into docs/index/. Re-run it when a new data release appears: finished planning periods are cached, so only new
ones are fetched ("easy to update with the latest data releases").

Usage:  python tools/build_index.py [--releases dr1 qr3] [--threads 96] [--only 2025W31_2A ...]

Data: NASA SPHEREx Level-2 spectral images, public bucket s3://nasa-irsa-spherex (NASA/IPAC IRSA).
This file was written with the help of an AI coding assistant (see README, "Use of AI").
"""
import argparse, csv, json, math, re, sys, time
import concurrent.futures as cf
from pathlib import Path

import numpy as np
import requests
from requests.adapters import HTTPAdapter

S3 = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cache" / "index"
OUT = ROOT / "docs" / "index"
KEY_RE = re.compile(r"^(\w+)/level2/(\d{4}W\d{2}_\d[A-Z])/([^/]+)/(\d)/level2_\2_(\d{4})_(\d)D\4_spx_\3\.fits$")
CARDS = ("CRVAL1", "CRVAL2", "PC1_1", "PC1_2", "PC2_1", "PC2_2", "MJD-AVG")
BAND_DEG = 3.0          # sky cells: declination bands of 3 deg, split in RA so cells are roughly square
HALF_DEG = 1.745        # half-width of one detector (2040 px x 6.15 arcsec)

session = requests.Session()


def get(url, **kw):
    for attempt in range(6):
        try:
            r = session.get(url, timeout=60, **kw)
            if r.status_code in (200, 206):
                return r
            if r.status_code == 404:
                return None
        except requests.RequestException:
            pass
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"giving up on {url}")


def list_prefix(prefix, delimiter=None):
    """All keys (or sub-prefixes when delimiter is set) under an S3 prefix."""
    out, token = [], None
    while True:
        params = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
        if delimiter:
            params["delimiter"] = delimiter
        if token:
            params["continuation-token"] = token
        text = get(S3, params=params).text
        out += re.findall(r"<Prefix>([^<]+)</Prefix></CommonPrefixes>" if delimiter else r"<Key>([^<]+)</Key>", text)
        m = re.search(r"<NextContinuationToken>([^<]+)<", text)
        if not m:
            return out
        token = m.group(1)


def read_cards(key, cards, fast_range):
    """Header values of one file. Tries a tiny byte range first (card offsets are stable within a processing
    version), then the whole header. Returns None if the file is unreadable."""
    for rng in (fast_range, "bytes=0-40319"):
        r = get(S3 + key, headers={"Range": rng})
        if r is None:
            return None
        text = r.content.decode("ascii", "replace")
        vals = []
        for card in cards:
            m = re.search(re.escape(f"{card:<8}=") + r"\s*([-+0-9.Ee]+)", text)
            if not m:
                break
            vals.append(float(m.group(1)))
        else:
            return vals
    return None


def read_pointing(key):
    """(pc11, pc12, pc21, pc22, crval1, crval2) from the IMAGE header."""
    return read_cards(key, ("PC1_1", "PC1_2", "PC2_1", "PC2_2", "CRVAL1", "CRVAL2"), "bytes=14320-15279")


def read_mjd(key):
    v = read_cards(key, ("MJD-AVG",), "bytes=20560-20639")
    return v[0] if v else None


def position_angle(pc12, pc22):
    """Position angle (deg, east of north) of the detector +y axis."""
    return math.degrees(math.atan2(pc12, pc22)) % 360.0


def crawl_period(rel, pp):
    """One planning period -> rows [rel, pp, ver, seq, sub, det, mask, ra, dec, pa, mjd] (all strings).
    One row per exposure (detector 1; `mask` says which of the 6 detector files exist), or one row per file
    when detector 1 is missing."""
    cache = CACHE / f"{rel}_{pp}.csv"
    if cache.exists() and cache.stat().st_size:
        with open(cache, newline="") as f:
            return list(csv.reader(f))
    groups = {}
    for key in list_prefix(f"{rel}/level2/{pp}/"):
        m = KEY_RE.match(key)
        if m:
            _, _, ver, det, seq, sub = m.groups()
            groups.setdefault((ver, seq, sub), {})[int(det)] = key
    order = sorted(groups, key=lambda g: (int(g[1]), int(g[2])))
    todo = []
    for g in order:
        dets = groups[g]
        todo += [(g, 1, dets[1])] if 1 in dets else [(g, d, k) for d, k in sorted(dets.items())]
    pointings = list(POOL.map(lambda t: read_pointing(t[2]), todo))
    # exposure times: read every 60th header and interpolate (exposures are taken in sequence); the web tool
    # reads the exact time from each image header when it loads the image
    idx = sorted(set(range(0, len(todo), 60)) | {len(todo) - 1})
    mjd_s = list(POOL.map(lambda i: read_mjd(todo[i][2]), idx))
    good = [(i, m) for i, m in zip(idx, mjd_s) if m]
    if len(good) < 2:
        raise RuntimeError("no exposure times readable")
    mjd = np.interp(range(len(todo)), [i for i, _ in good], [m for _, m in good])
    rows = []
    for k, ((g, det, _), p) in enumerate(zip(todo, pointings)):
        if p is None:
            continue
        ver, seq, sub = g
        mask = sum(1 << (d - 1) for d in groups[g]) if det == 1 else 1 << (det - 1)
        rows.append([rel, pp, ver, seq, sub, str(det), str(mask), f"{p[4]:.5f}", f"{p[5]:.5f}",
                     f"{position_angle(p[1], p[3]):.2f}", f"{mjd[k]:.4f}"])
    if len(rows) < 0.9 * len(todo):                              # do not cache a broken crawl
        raise RuntimeError(f"only {len(rows)} of {len(todo)} headers readable")
    CACHE.mkdir(parents=True, exist_ok=True)
    tmp = cache.with_suffix(".tmp")
    with open(tmp, "w", newline="") as f:
        csv.writer(f).writerows(rows)
    tmp.replace(cache)
    return rows


# ---------- focal-plane geometry: where detectors 2..6 point relative to detector 1 ----------
def unit(ra, dec):
    ra, dec = np.radians(ra), np.radians(dec)
    return np.array([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)])


def frame(ra, dec, pa):
    """Detector frame at a pointing: n (boresight), ex (+x on sky), ey (+y on sky) as unit vectors."""
    n = unit(ra, dec)
    east = np.array([-np.sin(np.radians(ra)), np.cos(np.radians(ra)), 0.0])
    north = np.cross(n, east)
    s, c = np.sin(np.radians(pa)), np.cos(np.radians(pa))
    ey = s * east + c * north
    ex = -c * east + s * north
    return n, ex, ey


def calibrate_geometry(rows, n_sample=40):
    """Median offset (deg, in detector-1 axes) and rotation of each detector, from exposures with all 6 files."""
    full = [r for r in rows if r[5] == "1" and r[6] == "63"]
    rng = np.random.default_rng(1)
    sample = [full[i] for i in rng.choice(len(full), min(n_sample, len(full)), replace=False)]
    jobs = [(r, d) for r in sample for d in range(2, 7)]

    def one(job):
        r, d = job
        rel, pp, ver, seq, sub = r[:5]
        return read_pointing(f"{rel}/level2/{pp}/{ver}/{d}/level2_{pp}_{seq}_{sub}D{d}_spx_{ver}.fits")

    res = list(POOL.map(one, jobs))
    acc = {d: [] for d in range(2, 7)}
    for (r, d), p in zip(jobs, res):
        if p is None:
            continue
        n, ex_, ey = frame(float(r[7]), float(r[8]), float(r[9]))
        v = unit(p[4], p[5])
        u_deg = math.degrees(math.atan2(v @ ex_, v @ n))
        v_deg = math.degrees(math.atan2(v @ ey, v @ n))
        carried = predict(float(r[7]), float(r[8]), float(r[9]), (u_deg, v_deg, 0.0))[2]
        dpa = (position_angle(p[1], p[3]) - carried + 180) % 360 - 180
        acc[d].append((u_deg, v_deg, dpa))
    geom = {"1": [0.0, 0.0, 0.0]}
    for d, a in acc.items():
        a = np.array(a)
        med, sc = np.median(a, 0), a.std(0)
        geom[str(d)] = [round(float(x), 4) for x in med]
        print(f"  detector {d}: offset x={med[0]:+.4f} y={med[1]:+.4f} deg, rot {med[2]:+.3f} deg "
              f"(scatter {sc[0]:.4f} {sc[1]:.4f} {sc[2]:.3f}, n={len(a)})")
    return geom


def predict(ra, dec, pa, off):
    """Pointing (ra, dec, pa) of another detector from detector 1's pointing and its focal-plane offset.
    The +y axis is carried to the new position (no "pa + constant": meridians converge towards the poles)."""
    n, ex, ey = frame(ra, dec, pa)
    v = n + math.tan(math.radians(off[0])) * ex + math.tan(math.radians(off[1])) * ey
    v /= np.linalg.norm(v)
    ra2, dec2 = math.degrees(math.atan2(v[1], v[0])) % 360.0, math.degrees(math.asin(v[2]))
    east = np.array([-math.sin(math.radians(ra2)), math.cos(math.radians(ra2)), 0.0])
    north = np.cross(v, east)
    y2 = ey - (ey @ v) * v
    return ra2, dec2, (math.degrees(math.atan2(y2 @ east, y2 @ north)) + off[2]) % 360.0


# ---------- sky cells (the same arithmetic is in docs/core.js) ----------
def n_bins(band):
    dec_c = -90 + BAND_DEG * (band + 0.5)
    return max(1, round(360 / BAND_DEG * math.cos(math.radians(dec_c))))


def cell(ra, dec):
    band = min(int((dec + 90) / BAND_DEG), int(180 / BAND_DEG) - 1)
    n = n_bins(band)
    return band, min(int(ra / (360.0 / n)), n - 1)


def main():
    releases = {}
    for rel in ARGS.releases:
        pps = [p.split("/")[2] for p in list_prefix(f"{rel}/level2/", delimiter="/")]
        releases[rel] = [p for p in pps if not ARGS.only or p in ARGS.only]
        print(f"{rel}: {len(releases[rel])} planning periods")
    # an exposure can be in more than one release: the first release named on the command line wins
    seen, todo = set(), []
    for rel, pps in releases.items():
        for pp in pps:
            if pp not in seen:
                seen.add(pp)
                todo.append((rel, pp))
    rows, t0, done = [], time.time(), 0

    def safe(job):
        try:
            return crawl_period(*job)
        except Exception as e:                                   # keep going: a rerun fills the gaps
            print(f"  {job} FAILED: {e}", flush=True)
            return []

    with cf.ThreadPoolExecutor(6) as outer:                      # 6 planning periods at a time
        for r in outer.map(safe, todo):
            rows += r
            done += 1
            print(f"[{done}/{len(todo)}] {len(rows)} exposure rows, {time.time() - t0:.0f} s", flush=True)
    if not rows:
        sys.exit("nothing crawled")

    print("focal-plane geometry:")
    geom = calibrate_geometry(rows)

    prefixes, shards = {}, {}
    mjds = []
    for rel, pp, ver, seq, sub, det, mask, ra, dec, pa, mjd in rows:
        ra, dec, pa, mjd, det, mask = float(ra), float(dec), float(pa), float(mjd), int(det), int(mask)
        pid = prefixes.setdefault((rel, pp, ver), len(prefixes))
        mjds.append(mjd)
        for d in range(1, 7):
            if not mask >> (d - 1) & 1:
                continue
            r_, d_, p_ = (ra, dec, pa) if d == det else predict(ra, dec, pa, geom[str(d)])
            s = shards.setdefault(cell(r_, d_), {k: [] for k in "pqsdrcat"})
            for k, v in zip("pqsdrcat", (pid, int(seq), int(sub), d, round(r_, 3), round(d_, 3), round(p_, 1), round(mjd, 4))):
                s[k].append(v)
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("c_*.json"):
        old.unlink()
    for (band, ib), s in shards.items():
        (OUT / f"c_{band}_{ib}.json").write_text(json.dumps(s, separators=(",", ":")))
    meta = {
        "s3": S3, "band_deg": BAND_DEG, "half_deg": HALF_DEG, "geometry": geom,
        "prefixes": [list(p) for p in prefixes],
        "releases": ARGS.releases, "n_images": sum(len(s["p"]) for s in shards.values()),
        "mjd_min": min(mjds), "mjd_max": max(mjds),
        "built_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "columns": {"p": "prefix index", "q": "exposure number", "s": "sub-exposure", "d": "detector",
                    "r": "RA of detector centre (deg)", "c": "Dec (deg)", "a": "position angle of +y (deg)", "t": "MJD"},
    }
    (OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    print(f"wrote {len(shards)} cells, {meta['n_images']} images, MJD {meta['mjd_min']:.1f}-{meta['mjd_max']:.1f} -> {OUT}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--releases", nargs="+", default=["dr1", "qr3"])
    ap.add_argument("--threads", type=int, default=96)
    ap.add_argument("--only", nargs="*", help="restrict to these planning periods (for a quick test)")
    ARGS = ap.parse_args()
    session.mount("https://", HTTPAdapter(pool_connections=4, pool_maxsize=ARGS.threads + 16))
    POOL = cf.ThreadPoolExecutor(ARGS.threads)
    main()
