'use strict';
// Saves and loads the processed dataset so it survives restarts (mount a Railway volume at DATA_DIR).

const fs = require('fs');
const path = require('path');

const COL_TYPES = {
  pg: Int32Array, adv: Int32Array, ch: Int32Array, theme: Int32Array, day: Int32Array, mon: Int32Array,
  dp: Uint8Array, dur: Uint8Array, bq: Uint8Array, cost: Float64Array, durRaw: Float32Array,
};
// Columns added later; older saved datasets load without them.
const OPTIONAL = new Set(['durRaw']);

function datasetDir(dataDir) { return path.join(dataDir, 'dataset'); }

function save(dataDir, ds) {
  const dir = datasetDir(dataDir);
  const tmp = dir + '.tmp';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'dataset.json'), JSON.stringify({ meta: ds.meta, dicts: ds.dicts }));
  for (const [name, arr] of Object.entries(ds.cols)) {
    fs.writeFileSync(path.join(tmp, name + '.bin'), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
}

function load(dataDir) {
  const dir = datasetDir(dataDir);
  const jsonFile = path.join(dir, 'dataset.json');
  if (!fs.existsSync(jsonFile)) return null;
  const { meta, dicts } = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  const cols = {};
  for (const [name, Type] of Object.entries(COL_TYPES)) {
    const file = path.join(dir, name + '.bin');
    if (OPTIONAL.has(name) && !fs.existsSync(file)) continue;
    const buf = fs.readFileSync(file);
    const copy = new Uint8Array(buf.byteLength);
    copy.set(buf);
    cols[name] = new Type(copy.buffer);
  }
  return { meta, dicts, cols };
}

function remove(dataDir) {
  fs.rmSync(datasetDir(dataDir), { recursive: true, force: true });
}

module.exports = { save, load, remove };
