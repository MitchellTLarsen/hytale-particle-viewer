// Models tab: every .blockymodel in Common/, drawn with one of its textures.

import { buildModel } from './blockymodel.js';
import { element, formatNumber, rawJson } from './dom.js';

const GENERIC_NAMES = new Set(['Model', 'Models']);

// Block models use 32 units per block; characters, NPCs and items use 64 (the player model is
// 118 units tall and its hitbox 1.85 blocks).
const unitsPerBlock = (path) => (path.startsWith('Blocks/') ? 32 : 64);

// Groups by the first two folders; the label is the rest of the path without generic "Models/Model" names.
function describe(path) {
  const parts = path.split('/');
  const group = parts.slice(0, Math.min(2, parts.length - 1));
  const rest = parts.slice(group.length);
  while (rest.length > 1 && GENERIC_NAMES.has(rest[rest.length - 1])) rest.pop();
  return { group: group.join('/'), id: rest.join('/') };
}

export function createModelsTab(data, details, renderer) {
  const items = data.models.map((model) => ({ ...model, ...describe(model.path) }));
  let request = 0;

  function leave() {
    request++;
    renderer.model = null;
  }

  async function select(item) {
    leave();
    const ticket = request;
    const file = `${item.path}.blockymodel`;
    details.replaceChildren(element('h2', item.id), element('p', `Common/${file}`, 'path'));
    const status = element('p', 'Loading...', 'facts');
    details.append(status);
    let model;
    try {
      const response = await fetch('assets/' + file);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      model = await response.json();
    } catch (error) {
      if (ticket !== request) return;
      status.className = 'error';
      status.textContent = `Could not load the model (${error.message}). Re-run build_site.py.`;
      return;
    }
    if (ticket !== request) return;

    const mesh = buildModel(model);
    const scale = 1 / unitsPerBlock(item.path);
    renderer.model = { mesh, texture: item.textures[0] ?? null, scale };
    frameCamera(renderer.camera, mesh, scale);

    const size = mesh.max.map((max, i) => formatNumber((max - mesh.min[i]) * scale));
    status.textContent = `Size: ${size.join(' x ')} blocks  |  Nodes: ${mesh.nodes}  |  Triangles: ${mesh.count / 3}`;
    details.append(textureChooser(item));
    details.append(rawJson([[file, model]]));
  }

  function textureChooser(item) {
    const container = element('div');
    if (item.textures.length === 0) {
      container.append(element('p', 'No texture found for this model; drawn grey.', 'notes'));
      return container;
    }
    const preview = element('img', undefined, 'texture');
    preview.alt = '';
    const show = (texture) => {
      renderer.model.texture = texture;
      preview.src = 'assets/' + texture;
      preview.title = texture;
    };
    const actions = element('div', undefined, 'actions');
    if (item.textures.length > 1) {
      const choice = element('select');
      for (const texture of item.textures) choice.append(new Option(texture, texture));
      choice.addEventListener('change', () => show(choice.value));
      const label = element('label', 'Texture ');
      label.append(choice);
      actions.append(label);
    } else {
      actions.append(element('span', `Texture: ${item.textures[0]}`));
    }
    show(item.textures[0]);
    container.append(actions, preview);
    return container;
  }

  return {
    name: 'models',
    noun: 'models',
    showsViewer: true,
    items,
    group: (item) => item.group,
    select,
    leave,
  };
}

// Points the orbit camera at the model's middle, far enough back to see all of it.
function frameCamera(camera, mesh, scale) {
  const center = mesh.min.map((min, i) => ((min + mesh.max[i]) / 2) * scale);
  const radius = Math.hypot(...mesh.max.map((max, i) => (max - mesh.min[i]) * scale)) / 2;
  camera.target = center;
  camera.distance = Math.min(80, Math.max(0.5, radius * 2.4));
}
