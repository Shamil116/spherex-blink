"""Write docs/wave.json: the wavelength lookup table of each of the 6 SPHEREx detectors.

Every Level-2 file ends with a WCS-WAVE table (9x9 control points; central wavelength and bandwidth in microns
at each control point). The table is the same for every exposure of a detector, so the web tool ships one copy
per detector instead of downloading it with every image. Re-run if a new data release changes the calibration.

This file was written with the help of an AI coding assistant (see README, "Use of AI").
"""
import json
from pathlib import Path

import requests
from astropy.io import fits

S3 = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
KEY = "dr1/level2/2025W31_2A/l2b-v27-2026-225/{d}/level2_2025W31_2A_0328_1D{d}_spx_l2b-v27-2026-225.fits"
out = {}
for d in range(1, 7):
    tail = requests.get(S3 + KEY.format(d=d), headers={"Range": "bytes=-5760"}, timeout=60).content
    t = fits.BinTableHDU.fromstring(tail).data
    out[str(d)] = {"x": t["X"][0].tolist(), "y": t["Y"][0].tolist(),
                   "wave": [[round(float(v), 6) for v in row] for row in t["VALUES"][0][..., 0]],
                   "band": [[round(float(v), 6) for v in row] for row in t["VALUES"][0][..., 1]]}
    w = t["VALUES"][0][..., 0]
    print(f"detector {d}: {w.min():.3f}-{w.max():.3f} um")
Path(__file__).resolve().parent.parent.joinpath("docs", "wave.json").write_text(json.dumps(out, separators=(",", ":")))
