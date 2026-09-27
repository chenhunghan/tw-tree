# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""Where does the 2013-2021 rise happen? Per-pixel change (2019-21 mean minus 2013-15 mean) by baseline tree %,
elevation, and by change in clear-date count.  uv run pipeline/analysis/where_rise.py [cache_name]"""
import pathlib, sys
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2]
name = sys.argv[1] if len(sys.argv) > 1 else "pilot"
A, B = [2013, 2014, 2015], [2019, 2020, 2021]
tiles = sorted(p for p in (ROOT / "build" / "cache" / name).glob("*/*") if p.is_dir())
fa, fb, na, nb, z = [], [], [], [], []
for t in tiles:
    load = lambda ys, k: np.stack([np.load(t / f"{y}.npz")[k].ravel().astype(float) for y in ys])
    a, b = load(A, "f"), load(B, "f")
    a[a == 255] = np.nan; b[b == 255] = np.nan
    fa.append(np.nanmean(a, 0)); fb.append(np.nanmean(b, 0))
    na.append(load(A, "n").mean(0)); nb.append(load(B, "n").mean(0))
    z.append(np.load(t / "z.npz")["z"].ravel().astype(float))
fa, fb, na, nb, z = map(np.concatenate, (fa, fb, na, nb, z))
ok = np.isfinite(fa) & np.isfinite(fb) & (z > 0)
fa, fb, na, nb, z = fa[ok], fb[ok], na[ok], nb[ok], z[ok]
d = fb - fa
print(f"land pixels {ok.sum()}, mean change {d.mean():+.2f} points  ({fa.mean():.1f} -> {fb.mean():.1f})")
print("\nby baseline tree % (2013-15):")
for lo, hi in [(0, 10), (10, 30), (30, 50), (50, 70), (70, 90), (90, 101)]:
    m = (fa >= lo) & (fa < hi)
    print(f"  {lo:3d}-{hi:<3d}  share {100*m.mean():4.1f}%   change {d[m].mean():+6.2f}   contributes {d[m].sum()/len(d):+.2f}")
print("\nby elevation:")
for lo, hi in [(0, 20), (20, 100), (100, 300), (300, 600), (600, 2000)]:
    m = (z >= lo) & (z < hi)
    print(f"  {lo:4d}-{hi:<4d} m  share {100*m.mean():4.1f}%   base {fa[m].mean():5.1f}  change {d[m].mean():+6.2f}")
print("\nby change in clear dates (n 2019-21 minus 2013-15):")
dn = nb - na
for lo, hi in [(-99, 0), (0, 4), (4, 8), (8, 12), (12, 99)]:
    m = (dn >= lo) & (dn < hi)
    if m.any():
        print(f"  dn {lo:4d}..{hi:<3d} share {100*m.mean():4.1f}%   change {d[m].mean():+6.2f}")
