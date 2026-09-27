# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""Forest pixels only (elevation > 300 m, 2013-15 mean tree % >= 60): per year mean tree %, sun-season mix of the
chosen observations, and the mean tree % by month of the chosen observation (all years pooled)."""
import pathlib, sys
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2]
name = sys.argv[1] if len(sys.argv) > 1 else "pilot"
years = list(range(int(sys.argv[2]) if len(sys.argv) > 2 else 2013, 2027))
tiles = sorted(p for p in (ROOT / "build" / "cache" / name).glob("*/*") if p.is_dir())
masks = {}
for t in tiles:
    z = np.load(t / "z.npz")["z"].ravel()
    base = np.stack([np.load(t / f"{y}.npz")["f"].ravel().astype(float) for y in (2013, 2014, 2015)])
    base[base == 255] = np.nan
    masks[t] = (z > 300) & (np.nanmean(base, 0) >= 60)
bymonth = {m: [] for m in range(1, 13)}
print("year  forest mean%  winter(NDJF)%  summer(MJJA)%")
for yr in years:
    fs, ms = [], []
    for t in tiles:
        p = t / f"{yr}.npz"
        if not p.exists():
            continue
        d = np.load(p); f, s, pids = d["f"].ravel(), d["s"].ravel(), d["pids"]
        ok = masks[t] & (f != 255) & (s != 65535)
        mon = np.array([int(q.split("_")[3][4:6]) for q in pids])
        fs.append(f[ok].astype(float)); ms.append(mon[s[ok]])
    if not fs:
        continue
    f, m = np.concatenate(fs), np.concatenate(ms)
    for k in range(1, 13):
        if (m == k).any():
            bymonth[k].append(f[m == k])
    print(f"{yr}  {f.mean():11.1f}  {100*np.isin(m, [11, 12, 1, 2]).mean():12.0f}  {100*np.isin(m, [5, 6, 7, 8]).mean():12.0f}")
print("\nmonth of chosen obs: mean forest tree % (pooled)")
print("  " + "  ".join(f"{k:>2}:{np.concatenate(v).mean():4.1f}" for k, v in bymonth.items() if v))
