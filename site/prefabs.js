// Prefabs tab: every prefab under Server/Prefabs, built from its blocks in the view. Cube blocks draw their
// face textures (faces against a solid neighbour are skipped), model blocks their .blockymodel; spawn
// markers are small grey cubes. Block rotations are not applied.

import { buildModel, FLOATS_PER_VERTEX } from './blockymodel.js';
import { chips, element } from './dom.js';
import { frameCamera } from './models.js';

const MODEL_UNITS = 32; // block models use 32 units per block
const MARKER_SIZE = 0.4;
const PALETTE_SHOWN = 30;

// Up, down, north (-z), south (+z), east (+x), west (-x): outward normal and the corners top-left,
// top-right, bottom-left, bottom-right of the unit block as seen from outside.
const FACES = [
  { normal: [0, 1, 0], corners: [[0, 1, 0], [1, 1, 0], [0, 1, 1], [1, 1, 1]] },
  { normal: [0, -1, 0], corners: [[0, 0, 1], [1, 0, 1], [0, 0, 0], [1, 0, 0]] },
  { normal: [0, 0, -1], corners: [[1, 1, 0], [0, 1, 0], [1, 0, 0], [0, 0, 0]] },
  { normal: [0, 0, 1], corners: [[0, 1, 1], [1, 1, 1], [0, 0, 1], [1, 0, 1]] },
  { normal: [1, 0, 0], corners: [[1, 1, 1], [1, 1, 0], [1, 0, 1], [1, 0, 0]] },
  { normal: [-1, 0, 0], corners: [[0, 1, 0], [0, 1, 1], [0, 0, 0], [0, 0, 1]] },
];
const UVS = [[0, 0], [1, 0], [0, 1], [1, 1]];
const TRIANGLES = [0, 2, 3, 0, 3, 1];

function pushFace(out, origin, face, size = 1) {
  for (const i of TRIANGLES) {
    out.push(...face.corners[i].map((c, axis) => origin[axis] + c * size), ...UVS[i], ...face.normal, 0);
  }
}

// One mesh holding a copy of `mesh` (model units) at each block position, in blocks.
function placeCopies(mesh, positions) {
  const vertices = new Float32Array(mesh.vertices.length * positions.length);
  positions.forEach(([x, y, z], copy) => {
    const base = copy * mesh.vertices.length;
    vertices.set(mesh.vertices, base);
    for (let v = base; v < base + mesh.vertices.length; v += FLOATS_PER_VERTEX) {
      vertices[v] = vertices[v] / MODEL_UNITS + x + 0.5;
      vertices[v + 1] = vertices[v + 1] / MODEL_UNITS + y;
      vertices[v + 2] = vertices[v + 2] / MODEL_UNITS + z + 0.5;
    }
  });
  return { vertices, count: vertices.length / FLOATS_PER_VERTEX };
}

const asMesh = (out) => ({ vertices: new Float32Array(out), count: out.length / FLOATS_PER_VERTEX });

/** `lookup` ({iconOf, assetPath}) links blocks and markers to their assets. */
export function createPrefabsTab(data, details, renderer, lookup) {
  const blockTypes = data.blocks ?? {};
  const items = (data.prefabs ?? []).map((entry) => {
    const parts = entry.path.split('/');
    const depth = Math.min(2, parts.length - 1);
    return { ...entry, group: parts.slice(0, depth).join('/'), id: parts.slice(depth).join('/') };
  });
  const modelCache = new Map();
  let request = 0;

  const loadJson = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  const loadModel = (path) => {
    if (!modelCache.has(path)) modelCache.set(path, loadJson('assets/' + path).then(buildModel).catch(() => null));
    return modelCache.get(path);
  };

  // The view's parts: cube faces grouped by texture, one merged mesh per block model, and the markers.
  async function buildParts(prefab) {
    const solid = new Set();
    const cubes = [];
    const models = new Map();
    const missing = new Map();
    for (let i = 0; i < prefab.blocks.length; i += 4) {
      const [x, y, z, index] = prefab.blocks.slice(i, i + 4);
      const name = prefab.palette[index];
      const type = blockTypes[name];
      if (!type) {
        missing.set(name, (missing.get(name) ?? 0) + 1);
        continue;
      }
      if (type.faces) {
        cubes.push([x, y, z, type]);
        if (type.opaque) solid.add(`${x},${y},${z}`);
      }
      if (type.model) {
        const key = `${type.model}\n${type.modelTexture ?? ''}`;
        if (!models.has(key)) models.set(key, { type, positions: [] });
        models.get(key).positions.push([x, y, z]);
      }
    }
    const byTexture = new Map();
    for (const [x, y, z, type] of cubes) {
      FACES.forEach((face, f) => {
        const texture = type.faces[f];
        if (!texture || solid.has(`${x + face.normal[0]},${y + face.normal[1]},${z + face.normal[2]}`)) return;
        if (!byTexture.has(texture)) byTexture.set(texture, []);
        pushFace(byTexture.get(texture), [x, y, z], face);
      });
    }
    const parts = [...byTexture].map(([texture, out]) => ({ mesh: asMesh(out), texture, scale: 1, normalizedUv: true }));
    for (const { type, positions } of models.values()) {
      const mesh = await loadModel(type.model);
      if (mesh?.count) parts.push({ mesh: placeCopies(mesh, positions), texture: type.modelTexture ?? null, scale: 1 });
    }
    if (prefab.markers.length) {
      const out = [];
      const offset = (1 - MARKER_SIZE) / 2;
      for (const marker of prefab.markers) for (const face of FACES) pushFace(out, [marker.x - 0.5 + offset, marker.y, marker.z - 0.5 + offset], face, MARKER_SIZE);
      parts.push({ mesh: asMesh(out), texture: null, scale: 1 });
    }
    return { parts, missing };
  }

  function bounds(prefab) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < prefab.blocks.length; i += 4) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], prefab.blocks[i + axis]);
        max[axis] = Math.max(max[axis], prefab.blocks[i + axis] + 1);
      }
    }
    return prefab.blocks.length ? { min, max } : { min: [0, 0, 0], max: [1, 1, 1] };
  }

  function paletteList(prefab, missing) {
    const counts = new Map();
    for (let i = 3; i < prefab.blocks.length; i += 4) counts.set(prefab.palette[prefab.blocks[i]], (counts.get(prefab.palette[prefab.blocks[i]]) ?? 0) + 1);
    const list = element('ul', undefined, 'drops palette');
    for (const [name, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, PALETTE_SHOWN)) {
      const row = element('li');
      row.append(element('span', `${count}×  `, 'chance'));
      const icon = lookup.iconOf(name);
      if (icon) {
        const image = element('img', undefined, 'icon');
        image.src = 'assets/' + icon;
        image.alt = '';
        row.append(image);
      }
      const path = lookup.assetPath(name, 'Server/Item/Items/');
      const link = element(path ? 'a' : 'span', name);
      if (path) link.href = `#assets:${encodeURIComponent(path)}`;
      row.append(link);
      if (missing.has(name)) row.append(element('small', 'not drawn'));
      list.append(row);
    }
    if (counts.size > PALETTE_SHOWN) list.append(element('li', `+${counts.size - PALETTE_SHOWN} more block types`, 'muted'));
    return list;
  }

  function markerList(prefab) {
    const counts = new Map();
    for (const marker of prefab.markers) counts.set(marker.name, (counts.get(marker.name) ?? 0) + 1);
    const list = element('ul', undefined, 'drops');
    for (const [name, count] of counts) {
      const row = element('li');
      row.append(element('span', `${count}×  `, 'chance'));
      const path = lookup.assetPath(name, 'Server/NPC/Spawn/');
      const link = element(path ? 'a' : 'span', name);
      if (path) link.href = `#assets:${encodeURIComponent(path)}`;
      row.append(link);
      list.append(row);
    }
    return list;
  }

  function leave() {
    request++;
    renderer.setModels([]);
  }

  async function select(item) {
    leave();
    const ticket = request;
    details.replaceChildren(element('h2', item.id), element('p', `Server/Prefabs/${item.path}.prefab.json`, 'path'));
    if (item.skipped) {
      details.append(element('p', 'Too big to view here (over 5 MB of blocks); build_site.py leaves it out.', 'notes'));
      return;
    }
    let prefab;
    try {
      prefab = await loadJson(`data/prefabs/${item.path}.json`);
    } catch (error) {
      if (ticket === request) details.append(element('p', `Could not load the prefab (${error.message}). Re-run build_site.py.`, 'error'));
      return;
    }
    if (ticket !== request) return;
    const { parts, missing } = await buildParts(prefab);
    if (ticket !== request) return;
    renderer.setModels(parts);
    const box = bounds(prefab);
    frameCamera(renderer.camera, box, 1);
    const size = box.max.map((max, i) => max - box.min[i]);
    details.append(
      chips([
        `${size.join(' × ')} blocks`,
        `${prefab.blocks.length / 4} blocks`,
        `${prefab.palette.length} block types`,
        prefab.markers.length && `${prefab.markers.length} spawn markers`,
        missing.size && `${[...missing.values()].reduce((a, b) => a + b, 0)} blocks not drawn`,
      ]),
    );
    if (prefab.markers.length) details.append(element('h3', 'Spawn markers'), markerList(prefab));
    details.append(element('h3', 'Blocks'), paletteList(prefab, missing));
  }

  return { name: 'prefabs', noun: 'prefabs', showsViewer: true, items, group: (item) => item.group, select, leave };
}
