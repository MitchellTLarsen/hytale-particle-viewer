// Models tab: every .blockymodel in Common/, drawn with one of its textures.

import { frameAt, samplePose } from './blockyanim.js';
import { buildModel } from './blockymodel.js';
import { element, formatNumber } from './dom.js';
import { rawJson } from './links.js';

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
  const animationCache = new Map();
  let request = 0;
  let current = null; // {model, mesh} of the shown model, mesh in its rest pose
  let playing = null; // {animation, speed, seconds}
  let animate = false;
  let chosenAnimation = 'Idle';

  function leave() {
    request++;
    renderer.model = null;
    current = null;
    playing = null;
  }

  function step(dt) {
    if (!playing || !current || !renderer.model) return;
    playing.seconds += dt;
    const frame = frameAt(playing.animation, playing.seconds, playing.speed);
    renderer.model.mesh = buildModel(current.model, samplePose(playing.animation, frame));
  }

  function restart() {
    if (playing) playing.seconds = 0;
  }

  async function loadAnimation(file) {
    if (!animationCache.has(file)) {
      animationCache.set(
        file,
        fetch('assets/' + file).then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        }),
      );
    }
    return animationCache.get(file);
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
    current = { model, mesh };
    renderer.model = { mesh, texture: item.textures[0] ?? null, scale };
    frameCamera(renderer.camera, mesh, scale);

    const size = mesh.max.map((max, i) => formatNumber((max - mesh.min[i]) * scale));
    status.textContent = `Size: ${size.join(' x ')} blocks  |  Nodes: ${mesh.nodes}  |  Triangles: ${mesh.count / 3}`;
    if (item.animations?.length) details.append(animationChooser(item, ticket));
    details.append(textureChooser(item));
    details.append(rawJson([[file, model]]));
  }

  function animationChooser(item, ticket) {
    const toggle = element('input');
    toggle.type = 'checkbox';
    toggle.checked = animate;
    const toggleLabel = element('label');
    toggleLabel.append(toggle, ' Animate');
    const choice = element('select');
    for (const animation of item.animations) choice.append(new Option(animation.name, animation.name));
    const names = item.animations.map((animation) => animation.name);
    choice.value = names.includes(chosenAnimation) ? chosenAnimation : names.includes('Idle') ? 'Idle' : names[0];
    const status = element('span', '', 'error');

    const update = async () => {
      playing = null;
      status.textContent = '';
      if (renderer.model) renderer.model.mesh = current.mesh;
      if (!toggle.checked) return;
      const entry = item.animations.find((animation) => animation.name === choice.value);
      try {
        const animation = await loadAnimation(entry.file);
        if (ticket !== request || !toggle.checked || choice.value !== entry.name) return;
        playing = { animation, speed: entry.speed ?? 1, seconds: 0 };
      } catch (error) {
        status.textContent = `Could not load ${entry.file} (${error.message}).`;
      }
    };
    toggle.addEventListener('change', () => {
      animate = toggle.checked;
      update();
    });
    choice.addEventListener('change', () => {
      chosenAnimation = choice.value;
      update();
    });
    update();

    const actions = element('div', undefined, 'actions');
    const choiceLabel = element('label', `Animation (${names.length}) `);
    choiceLabel.append(choice);
    actions.append(toggleLabel, choiceLabel, status);
    return actions;
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
    step,
    restart,
  };
}

// Points the orbit camera at the model's middle, far enough back to see all of it.
function frameCamera(camera, mesh, scale) {
  const center = mesh.min.map((min, i) => ((min + mesh.max[i]) / 2) * scale);
  const radius = Math.hypot(...mesh.max.map((max, i) => (max - mesh.min[i]) * scale)) / 2;
  camera.target = center;
  camera.distance = Math.min(80, Math.max(0.5, radius * 2.4));
}
