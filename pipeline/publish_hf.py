# /// script
# requires-python = ">=3.11"
# dependencies = ["huggingface_hub>=0.30"]
# ///
"""Upload site/data/<name>/ to a Hugging Face dataset repo.

  uv run publish_hf.py <user>/taiwan-tree-cover pilot

Auth: `hf auth login` locally (fine-grained token scoped to that dataset, write access), or HF_TOKEN in CI.
The browser then reads https://huggingface.co/datasets/<repo>/resolve/main/<name>/index.json anonymously;
open the site with ?data=<that folder URL>.
"""
import pathlib, sys
from huggingface_hub import HfApi

ROOT = pathlib.Path(__file__).resolve().parent.parent
repo, name = sys.argv[1], sys.argv[2]
folder = ROOT / "site" / "data" / name
if not (folder / "index.json").exists():
    sys.exit(f"missing {folder}/index.json — run export_tiles.py first")

api = HfApi()
api.create_repo(repo, repo_type="dataset", exist_ok=True)
api.upload_file(repo_id=repo, repo_type="dataset", path_or_fileobj=ROOT / "pipeline" / "hf_README.md",
                path_in_repo="README.md", commit_message="Update dataset card")
api.upload_folder(repo_id=repo, repo_type="dataset", folder_path=folder, path_in_repo=name,
                  commit_message=f"Update {name} tiles")
print(f"done: https://huggingface.co/datasets/{repo}/resolve/main/{name}/index.json")
