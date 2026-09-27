# 臺灣樹冠時光機 · Taiwan tree-cover timeline

A 3D map of tree cover across Taiwan from 1984 to 2026. Each 30 m Landsat pixel's tree fraction is drawn as
procedural three.js trees on custom terrain. A timeline autoplays and can be scrubbed; search by coordinates,
device location or a Traditional Chinese address.

- **Site:** <https://chenhunghan.github.io/tw-tree/> (`site/`: plain HTML + ES modules, three.js from a CDN, no build step).
- **Data:** the Hugging Face dataset [chenhunghan/tw-tree](https://huggingface.co/datasets/chenhunghan/tw-tree)
  (CC BY 4.0). The browser reads the tiles from there; they are not stored in this repo.
- **Pipeline:** `pipeline/` (Python run with `uv run`; Google Earth Engine). Every stored value traces to one raw
  Landsat Collection 2 pixel: native UTM grid, medoid composite, per-pixel scene index.

Design decisions, data sources, method and known limitations are in [AGENTS.md](AGENTS.md).

## Run locally

```sh
cd site && python3 -m http.server
# open http://localhost:8000/            (data from Hugging Face)
# or   http://localhost:8000/?data=./data/<name>/   for locally exported tiles
```

## License

Code: [MIT](LICENSE). Data on Hugging Face: CC BY 4.0. `data/taipei_parks_halfyear_ods/`: Taipei City open-data
declaration (free reuse with attribution).

## Attribution

Landsat Collection 2 Level-2 courtesy of the U.S. Geological Survey · ESA WorldCover 2021 v200 (CC BY 4.0) ·
Copernicus DEM GLO-30 © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS
by the European Union and ESA · Address search: Nominatim / © OpenStreetMap contributors (ODbL) ·
`data/taipei_parks_halfyear_ods/`: 資料來源：臺北市政府工務局公園路燈工程管理處「臺北市行道樹及其他植栽」半年報
(Taipei City open-data declaration).
