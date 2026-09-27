// Loads the tile index, the coarse overview and Arrow tiles. Columns become typed arrays without copying.
import { tableFromIPC } from 'apache-arrow';

export const NODATA_F = 255, NODATA_S = 65535;

async function fetchArrow(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  let buf = new Uint8Array(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) {     // gzip; skip if the server already decoded it
    const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    buf = new Uint8Array(await new Response(ds).arrayBuffer());
  }
  return tableFromIPC(buf);
}

export class DataSet {
  constructor(base) {
    this.base = base.endsWith('/') ? base : base + '/';
    this.tiles = new Map();     // key "zone_i_j" -> loaded full-resolution tile
    this.prov = new Map();
    this.entries = new Map();   // key -> index entry (every tile in the dataset)
    this.overview = new Map();  // key -> coarse tile (480 m blocks), if the dataset has one
  }

  async init() {
    const r = await fetch(this.base + 'index.json');
    if (!r.ok) throw new Error(`index.json: ${r.status}`);
    this.index = await r.json();
    this.years = this.index.years;
    this.tileM = this.index.tile_m;
    this.tilePx = this.index.tile_px;
    this.res = this.index.res_m;
    this.edge = this.index.edge_m;
    for (const e of this.index.tiles) this.entries.set(this.key(e), e);
    return this.index;
  }

  key(t) { return `${t.zone}_${t.i}_${t.j}`; }

  // Overview: 256 rows per tile, in index order; each tile becomes a 16x16 "tile" with 480 m cells.
  async loadOverview() {
    const B = this.index.overview_block_px;
    if (!B) return false;
    const tbl = await fetchArrow(this.base + 'overview.arrow.gz');
    const P = this.tilePx / B, n = P * P;
    const col = (name) => tbl.getChild(name).toArray();
    const zone = col('zone'), I = col('i'), J = col('j'), z = col('z_m'), own = col('own');
    const land = tbl.getChild('land') ? col('land') : null;
    const f = Object.fromEntries(this.years.map(y => [y, col(`f${y}`)]));
    for (let s = 0; s < zone.length; s += n) {
      const t = { zone: zone[s], i: I[s], j: J[s], P, res: this.res * B, coarse: true };
      t.key = this.key(t);
      t.x0 = this.edge + t.i * this.tileM; t.y0 = this.edge + t.j * this.tileM;
      t.z = z.subarray(s, s + n); t.own = own.subarray(s, s + n); t.land = land ? land.subarray(s, s + n) : null;
      t.f = Object.fromEntries(this.years.map(y => [y, f[y].subarray(s, s + n)]));
      this.overview.set(t.key, t);
    }
    return true;
  }

  async loadTile(entry) {
    const k = this.key(entry);
    if (this.tiles.has(k)) return this.tiles.get(k);
    const tbl = await fetchArrow(this.base + entry.frac);
    const meta = JSON.parse(tbl.schema.metadata.get('tpetree'));
    const f = {};
    for (const y of this.years) f[y] = tbl.getChild(`f${y}`).toArray();
    const tile = {
      ...entry, key: k, meta, P: this.tilePx, res: this.res,
      x: tbl.getChild('x_utm').toArray(), y: tbl.getChild('y_utm').toArray(), z: tbl.getChild('z_m').toArray(), f,
      own: tbl.getChild('own')?.toArray() ?? null,        // null: every pixel is canonical (single-zone data)
      land: tbl.getChild('land')?.toArray() ?? null,      // null: no water mask (pilot data; water = DEM <= 0)
    };
    this.tiles.set(k, tile);
    return tile;
  }

  unloadTile(k) { this.tiles.delete(k); this.prov.delete(k); }

  async loadProv(tile) {
    if (this.prov.has(tile.key)) return this.prov.get(tile.key);
    const tbl = await fetchArrow(this.base + tile.prov);
    const meta = JSON.parse(tbl.schema.metadata.get('tpetree'));
    const p = { meta, s: {}, n: {} };
    for (const y of this.years) {
      p.s[y] = tbl.getChild(`s${y}`).toArray();
      p.n[y] = tbl.getChild(`n${y}`).toArray();
    }
    this.prov.set(tile.key, p);
    return p;
  }

  tileIndex(x, y) { return [Math.floor((x - this.edge) / this.tileM), Math.floor((y - this.edge) / this.tileM)]; }

  // Index entry containing a native UTM point (whether loaded or not), or undefined.
  entryAt(zone, x, y) { const [i, j] = this.tileIndex(x, y); return this.entries.get(`${zone}_${i}_${j}`); }

  // Native UTM (zone of the tile) -> loaded tile + pixel index, or null. Pixels another tile owns are skipped.
  locate(zone, x, y) {
    const [i, j] = this.tileIndex(x, y);
    const tile = this.tiles.get(`${zone}_${i}_${j}`);
    if (!tile) return null;
    const col = Math.floor((x - tile.x0) / this.res);
    const row = Math.floor((tile.y0 + this.tileM - y) / this.res);
    if (col < 0 || row < 0 || col >= this.tilePx || row >= this.tilePx) return null;
    const k = row * this.tilePx + col;
    if (tile.own && !tile.own[k]) return null;
    return { tile, k, col, row };
  }

  // Coarse cell for a native UTM point, or null.
  locateCoarse(zone, x, y) {
    const [i, j] = this.tileIndex(x, y);
    const t = this.overview.get(`${zone}_${i}_${j}`);
    if (!t) return null;
    const col = Math.floor((x - t.x0) / t.res), row = Math.floor((t.y0 + this.tileM - y) / t.res);
    if (col < 0 || row < 0 || col >= t.P || row >= t.P) return null;
    const k = row * t.P + col;
    return t.own[k] ? { tile: t, k } : null;
  }
}
