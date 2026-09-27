#!/bin/zsh
# Unattended island build: keep export_tiles.py running (it resumes from build/cache) and, every INTERVAL seconds,
# assemble the complete tiles locally and publish them to the Hugging Face dataset. Ends after the final publish.
#   nohup pipeline/island_loop.sh > build/island_loop.log 2>&1 &
# Stop: pkill -f island_loop.sh; pkill -f "export_tiles.py --name taiwan"
cd "${0:A:h}"
REPO=${REPO:-chenhunghan/tw-tree}
INTERVAL=${INTERVAL:-10800}
EXPORT=(uv run export_tiles.py --name taiwan --plan tiles_taiwan.json)

publish() {
  "${EXPORT[@]}" --assemble-only && uv run publish_hf.py "$REPO" taiwan
}
complete() {
  python3 -c "import json,sys; sys.exit(0 if json.load(open('../site/data/taiwan/index.json')).get('complete') else 1)" 2>/dev/null
}

while true; do
  if ! pgrep -f "export_tiles.py --name taiwan --plan tiles_taiwan.json --workers" > /dev/null; then
    publish
    if complete; then echo "$(date) island export complete and published"; break; fi
    echo "$(date) export not running: restarting"
    nohup "${EXPORT[@]}" --workers 5 >> ../build/taiwan_export.log 2>&1 &
  fi
  sleep "$INTERVAL"
  echo "$(date) periodic publish"
  publish
done
