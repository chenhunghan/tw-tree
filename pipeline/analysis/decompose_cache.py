# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""Decompose yearly tree fraction by the sensor and month of the scene each medoid pixel came from.

  uv run pipeline/analysis/decompose_cache.py [cache_name] [first_year]

Reads build/cache/<name>/<zone>/<tile>/<year>.npz (f, s, pids) and prints, per year: mean tree %, the share of pixels
from each sensor, the mean tree % of pixels by sensor, the share from Jun-Sep, and the mean clear-date count.
"""
import pathlib, sys, collections
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2]
name = sys.argv[1] if len(sys.argv) > 1 else "pilot"
y0 = int(sys.argv[2]) if len(sys.argv) > 2 else 1999
tiles = sorted(p for p in (ROOT / "build" / "cache" / name).glob("*/*") if p.is_dir())
years = sorted({int(p.stem) for t in tiles for p in t.glob("[12]*.npz")})
SENS = ["LT04", "LT05", "LE07", "LC08", "LC09"]
print(f"{name}: {len(tiles)} tiles")
print("year  mean%  " + " ".join(f"{s:>11}" for s in SENS) + "   JJAS%  n_dates")
for yr in [y for y in years if y >= y0]:
    fs, sens, month, ns = [], [], [], []
    for t in tiles:
        d = np.load(t / f"{yr}.npz")
        f, s, pids = d["f"].ravel(), d["s"].ravel(), d["pids"]
        ok = (f != 255) & (s != 65535)
        if not len(pids):
            continue
        sen = np.array([p[:4] for p in pids])
        mon = np.array([int(p.split("_")[3][4:6]) for p in pids])
        fs.append(f[ok]); sens.append(sen[s[ok]]); month.append(mon[s[ok]]); ns.append(d["n"].ravel()[ok])
    f, sen, mon, n = map(np.concatenate, (fs, sens, month, ns))
    cells = []
    for s in SENS:
        m = sen == s
        cells.append(f"{100*m.mean():4.0f}%/{f[m].mean():4.1f}" if m.any() else " " * 11)
    jjas = np.isin(mon, [6, 7, 8, 9]).mean() * 100
    print(f"{yr}  {f.mean():5.1f}  " + " ".join(cells) + f"   {jjas:5.0f}  {n.mean():6.1f}")
print("cells: share of pixels from that sensor / their mean tree %")
