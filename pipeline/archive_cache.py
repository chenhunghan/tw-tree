# /// script
# requires-python = ">=3.11"
# dependencies = ["huggingface_hub>=0.30"]
# ///
"""Archive build/cache/<name>/ (raw Earth Engine DN per tile-year + static layers) to the Hugging Face dataset, or restore it.

  uv run pipeline/archive_cache.py archive chenhunghan/tw-tree taiwan [--delete]
  uv run pipeline/archive_cache.py restore chenhunghan/tw-tree taiwan [--dest build/cache] [--only 51/part-000.tar,...]

archive: whole tiles are packed into ~500 MB tars (cache/<name>/<zone>/part-NNN.tar, members `<name>/<zone>/<i>_<j>/...`).
Each part is checked member by member against the source files, uploaded, then downloaded back and its SHA-256 compared.
With --delete the part's tile folders are removed only after both checks pass. Resumable: finished parts are recorded in
build/archive_<name>.json and cache/<name>/manifest.json lists every part, its tiles, file count, size and SHA-256.
restore: downloads each part, checks its SHA-256 against the manifest and extracts into build/cache/.
"""
import hashlib, http.client, json, pathlib, queue, shutil, sys, tarfile, threading, time, urllib.error, urllib.request
from huggingface_hub import HfApi
from huggingface_hub.errors import HfHubHTTPError

ROOT = pathlib.Path(__file__).resolve().parent.parent
PART_BYTES = 500 * 2**20
ATTEMPTS, BACKOFF, BACKOFF_MAX = 10, 10, 600  # seconds; ~1 h of retrying before giving up


def transient(e):
    """Network drops, timeouts, rate limits (429) and server errors (5xx) are retried; other HTTP errors are not."""
    code = getattr(getattr(e, "response", None), "status_code", None) or getattr(e, "code", None)
    if isinstance(e, (HfHubHTTPError, urllib.error.HTTPError)) and code is not None:
        return code in (408, 429) or code >= 500
    return isinstance(e, (OSError, http.client.HTTPException, TimeoutError))


def retry(what, fn):
    for attempt in range(1, ATTEMPTS + 1):
        try:
            return fn()
        except Exception as e:
            if attempt == ATTEMPTS or not transient(e):
                raise
            resp = getattr(e, "response", None)
            after = getattr(resp, "headers", {}).get("Retry-After") if resp is not None else None
            wait = min(BACKOFF_MAX, BACKOFF * 2 ** (attempt - 1))
            if after and str(after).isdigit():
                wait = max(wait, min(int(after), 3600))
            print(f"  {what}: {type(e).__name__}: {str(e)[:160]} — retry {attempt}/{ATTEMPTS - 1} in {wait}s", flush=True)
            time.sleep(wait)


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        while b := f.read(1 << 22):
            h.update(b)
    return h.hexdigest()


def sha256_url(url, save=None):
    """Stream url (optionally into save), hashing as it goes; a dropped connection resumes with a Range request."""
    h, n, total = hashlib.sha256(), 0, None
    out = open(save, "wb") if save else None

    def fetch():
        nonlocal n, total
        req = urllib.request.Request(url, headers={"Range": f"bytes={n}-"} if n else {})
        with urllib.request.urlopen(req, timeout=120) as r:
            if n and r.status != 206:
                raise urllib.error.HTTPError(url, 500, "server ignored Range", r.headers, None)
            if total is None:
                total = n + int(r.headers.get("Content-Length", -1))
            while b := r.read(1 << 20):
                h.update(b); n += len(b)
                if out:
                    out.write(b)
        if total is not None and total >= 0 and n < total:
            raise http.client.IncompleteRead(b"", total - n)

    try:
        retry(f"download {url.rsplit('/', 1)[-1]}", fetch)
    finally:
        if out:
            out.close()
    return h.hexdigest(), n


def plan_parts(cache, name):
    parts = []
    for zone in sorted(p.name for p in cache.iterdir() if p.is_dir()):
        cur, size, k = [], 0, 0
        for tile in sorted((cache / zone).iterdir()):
            files = sorted(f for f in tile.rglob("*") if f.is_file())
            cur.append(tile.name); size += sum(f.stat().st_size for f in files)
            if size >= PART_BYTES:
                parts.append({"zone": zone, "part": f"{zone}/part-{k:03d}.tar", "tiles": cur}); cur, size, k = [], 0, k + 1
        if cur:
            parts.append({"zone": zone, "part": f"{zone}/part-{k:03d}.tar", "tiles": cur})
    return parts


def archive(repo, name, delete, limit=None):
    cache = ROOT / "build" / "cache" / name
    state_path = ROOT / "build" / f"archive_{name}.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {"parts": {}}
    if "plan" not in state:
        state["plan"] = plan_parts(cache, name)
        state_path.write_text(json.dumps(state, indent=1))
    api, tmp = HfApi(), ROOT / "build" / "archive_tmp"
    tmp.mkdir(exist_ok=True)
    for extra in sorted(p for p in cache.iterdir() if p.is_file() and not p.name.startswith(".")):
        retry(f"upload {extra.name}", lambda: api.upload_file(
            repo_id=repo, repo_type="dataset", path_or_fileobj=extra,
            path_in_repo=f"cache/{name}/{extra.name}", commit_message=f"cache/{name}: {extra.name}"))
    def upload_manifest():  # lists verified parts only, so the remote never advertises an unchecked part
        with lock:
            parts = {p["part"]: state["parts"][p["part"]] for p in state["plan"] if p["part"] in state["parts"]}
        manifest = {"name": name, "complete": len(parts) == len(state["plan"]), "parts_planned": len(state["plan"]),
                    "format": "tar of build/cache/<name>/<zone>/<i>_<j>/ (static.npz + <year>.npz)",
                    "restore": f"uv run pipeline/archive_cache.py restore {repo} {name}", "parts": parts}
        mpath = tmp / "manifest.json"
        mpath.write_text(json.dumps(manifest, indent=1))
        retry("upload manifest", lambda: api.upload_file(
            repo_id=repo, repo_type="dataset", path_or_fileobj=mpath,
            path_in_repo=f"cache/{name}/manifest.json", commit_message=f"cache/{name}: manifest ({len(parts)} parts)"))

    lock, failed = threading.Lock(), threading.Event()
    pending = queue.Queue(maxsize=2)  # uploaded parts awaiting the download check (<= 3 tars on disk)

    def verifier():
        while (job := pending.get()) is not None:
            i, part, tar_path, digest, size, nfiles = job
            rel = part["part"]
            try:
                remote, rsize = sha256_url(f"https://huggingface.co/datasets/{repo}/resolve/main/cache/{name}/{rel}")
            except Exception as e:
                print(f"{rel}: download check failed: {e}", flush=True); failed.set(); continue
            if (remote, rsize) != (digest, size):
                print(f"{rel}: downloaded copy differs (sha256 {remote[:12]} vs {digest[:12]}, {rsize} vs {size} B)",
                      flush=True); failed.set(); continue
            with lock:
                state["parts"][rel] = {"tiles": part["tiles"], "files": nfiles, "bytes": size, "sha256": digest}
                state_path.write_text(json.dumps(state, indent=1))
            tar_path.unlink()
            try:
                upload_manifest()
            except Exception as e:  # the part is verified and recorded locally; the next manifest upload will list it
                print(f"  manifest upload failed ({e}); continuing", flush=True)
            if delete:
                for t in part["tiles"]:
                    shutil.rmtree(cache / part["zone"] / t)
            print(f"[{i + 1}/{len(state['plan'])}] {rel}: {len(part['tiles'])} tiles, {nfiles} files, "
                  f"{size / 2**20:.0f} MB, verified{' + deleted' if delete else ''}", flush=True)

    worker = threading.Thread(target=verifier)
    worker.start()
    try:
        started = 0
        for i, part in enumerate(state["plan"]):
            rel = part["part"]
            if failed.is_set():
                break
            if rel in state["parts"]:
                if delete:  # verified on an earlier run without --delete
                    for t in part["tiles"]:
                        shutil.rmtree(cache / part["zone"] / t, ignore_errors=True)
                continue
            if limit is not None and started >= limit:
                print(f"stopping after --limit {limit} new parts", flush=True); break
            started += 1
            tar_path = tmp / rel.replace("/", "_")
            files = [f for t in part["tiles"] for f in sorted((cache / part["zone"] / t).rglob("*")) if f.is_file()]
            with tarfile.open(tar_path, "w", format=tarfile.PAX_FORMAT) as tf:
                for f in files:
                    tf.add(f, arcname=f"{name}/{f.relative_to(cache)}", recursive=False)
            # member by member: the tar holds exactly the source files, byte for byte
            want = {f"{name}/{f.relative_to(cache)}": sha256_file(f) for f in files}
            got = {}
            with tarfile.open(tar_path) as tf:
                for m in tf:
                    got[m.name] = hashlib.sha256(tf.extractfile(m).read()).hexdigest()
            if got != want:
                print(f"{rel}: tar contents differ from source", flush=True); failed.set(); break
            digest, size = sha256_file(tar_path), tar_path.stat().st_size
            retry(f"upload {rel}", lambda: api.upload_file(
                repo_id=repo, repo_type="dataset", path_or_fileobj=tar_path,
                path_in_repo=f"cache/{name}/{rel}", commit_message=f"cache/{name}/{rel}"))
            print(f"  uploaded {rel} ({size / 2**20:.0f} MB), checking by download", flush=True)
            pending.put((i, part, tar_path, digest, size, len(files)))
    finally:
        pending.put(None)
        worker.join()
    if failed.is_set():
        sys.exit("stopped: a part failed its check (its tiles were not deleted); rerun to retry")
    if len(state["parts"]) < len(state["plan"]):
        print(f"{len(state['parts'])}/{len(state['plan'])} parts verified; rerun to continue"); return
    if delete:
        for extra in sorted(p for p in cache.iterdir() if p.is_file() and not p.name.startswith(".")):
            extra.unlink()
        if not any(cache.rglob("*")):
            shutil.rmtree(cache)
    upload_manifest()
    print(f"done: {len(state['parts'])} parts, {sum(p['files'] for p in state['parts'].values())} files, "
          f"{sum(p['bytes'] for p in state['parts'].values()) / 2**30:.1f} GiB")


def restore(repo, name, dest=None, only=None):
    dest = pathlib.Path(dest) if dest else ROOT / "build" / "cache"
    base = f"https://huggingface.co/datasets/{repo}/resolve/main/cache/{name}/"
    (dest / name).mkdir(parents=True, exist_ok=True)
    tmp = dest / f".{name}_part.tar"
    manifest = json.loads(retry("manifest", lambda: urllib.request.urlopen(base + "manifest.json", timeout=120).read()))
    for extra in ("scene_counts.json", "failures_pass1.json"):
        sha256_url(base + extra, dest / name / extra)
    if not manifest.get("complete"):
        print(f"note: manifest lists {len(manifest['parts'])}/{manifest.get('parts_planned')} parts (archive incomplete)")
    for i, (rel, meta) in enumerate(manifest["parts"].items()):
        if only and rel not in only:
            continue
        if sha256_url(base + rel, tmp)[0] != meta["sha256"]:
            sys.exit(f"{rel}: sha256 mismatch")
        with tarfile.open(tmp) as tf:
            tf.extractall(dest, filter="data")
        tmp.unlink()
        print(f"[{i + 1}/{len(manifest['parts'])}] {rel}: {meta['files']} files", flush=True)


if __name__ == "__main__":
    cmd, repo, name = sys.argv[1:4]
    opt = lambda k: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else None
    if cmd == "archive":
        archive(repo, name, "--delete" in sys.argv, int(opt("--limit")) if opt("--limit") else None)
    else:
        restore(repo, name, opt("--dest"), opt("--only") and opt("--only").split(","))
