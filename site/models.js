// Models tab: every .blockymodel in Common/, drawn with one of its textures. Its preview (the model in the
// view, with animation and texture pickers on top) is also used by the Assets tab.

import { frameAt, samplePose } from './blockyanim.js';
import { buildModel } from './blockymodel.js';
import { chips, element, formatNumber } from './dom.js';
import { rawJson } from './links.js';

const GENERIC_NAMES = new Set(['Model', 'Models']);

// Block models use 32 units per block; characters, NPCs and items use 64 (the player model is
// 118 units tall and its hitbox 1.85 blocks).
const unitsPerBlock = (path) => (path.startsWith('Blocks/') ? 32 : 64);

const fileName = (path) => path.split('/').pop();

// Groups by the first two folders; the label is the rest of the path without generic "Models/Model" names.
function describe(path) {
  const parts = path.split('/');
  const group = parts.slice(0, Math.min(2, parts.length - 1));
  const rest = parts.slice(group.length);
  while (rest.length > 1 && GENERIC_NAMES.has(rest[rest.length - 1])) rest.pop();
  return { group: group.join('/'), id: rest.join('/') };
}

async function loadJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function createModelsTab(data, details, renderer, controls) {
  const items = data.models.map((model) => ({ ...model, ...describe(model.path) }));
  const byPath = new Map(items.map((item) => [item.path, item]));
  const animationCache = new Map();
  let request = 0;
  let current = null; // {model, mesh} of the shown model, mesh in its rest pose
  let playing = null; // {animation, speed, seconds}
  let onTexture = null; // keeps a texture picture in the details in step with the picker
  let animate = false;
  let chosenAnimation = 'Idle';

  function clearPreview() {
    request++;
    renderer.model = null;
    current = null;
    playing = null;
    onTexture = null;
    controls.hidden = true;
    controls.replaceChildren();
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

  function loadAnimation(file) {
    if (!animationCache.has(file)) {
      const loading = loadJson('assets/' + file);
      loading.catch(() => animationCache.delete(file));
      animationCache.set(file, loading);
    }
    return animationCache.get(file);
  }

  /**
   * Shows the model at `path` (under Common/, without .blockymodel) in the view, `texture` first among its
   * textures. Resolves to {model, mesh, scale, textures}, to {error} when the model can't load, or to null
   * when another preview has started meanwhile.
   */
  async function preview(path, texture) {
    clearPreview();
    const ticket = request;
    const item = byPath.get(path);
    let model;
    try {
      model = await loadJson(`assets/${path}.blockymodel`);
    } catch (error) {
      return ticket === request ? { error } : null;
    }
    if (ticket !== request) return null;
    const mesh = buildModel(model);
    const scale = 1 / unitsPerBlock(path);
    const textures = [...new Set([texture, ...(item?.textures ?? [])].filter(Boolean))];
    current = { model, mesh };
    renderer.model = { mesh, texture: textures[0] ?? null, scale };
    frameCamera(renderer.camera, mesh, scale);
    fillControls(item?.animations ?? [], textures, ticket);
    return { model, mesh, scale, textures };
  }

  function fillControls(animations, textures, ticket) {
    const parts = [];
    if (animations.length) parts.push(...animationControls(animations, ticket));
    if (textures.length > 1) {
      const choice = element('select');
      choice.title = 'Texture';
      for (const texture of textures) choice.append(new Option(fileName(texture), texture));
      choice.addEventListener('change', () => {
        renderer.model.texture = choice.value;
        onTexture?.(choice.value);
      });
      parts.push(choice);
    } else if (textures.length === 0) {
      parts.push(element('span', 'No texture: drawn grey', 'muted'));
    }
    controls.replaceChildren(...parts);
    controls.hidden = parts.length === 0;
  }

  function animationControls(animations, ticket) {
    const toggle = element('input');
    toggle.type = 'checkbox';
    toggle.checked = animate;
    const toggleLabel = element('label');
    toggleLabel.append(toggle, 'Animate');
    const choice = element('select');
    choice.title = `Animation (${animations.length})`;
    for (const animation of animations) choice.append(new Option(animation.name, animation.name));
    const names = animations.map((animation) => animation.name);
    choice.value = names.includes(chosenAnimation) ? chosenAnimation : names.includes('Idle') ? 'Idle' : names[0];
    const status = element('span', '', 'error');

    const update = async () => {
      playing = null;
      status.textContent = '';
      if (renderer.model) renderer.model.mesh = current.mesh;
      if (!toggle.checked) return;
      const entry = animations.find((animation) => animation.name === choice.value);
      try {
        const animation = await loadAnimation(entry.file);
        if (ticket !== request || !toggle.checked || choice.value !== entry.name) return;
        playing = { animation, speed: entry.speed ?? 1, seconds: 0 };
      } catch (error) {
        status.textContent = `Could not load ${fileName(entry.file)}`;
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
    return [toggleLabel, choice, status];
  }

  /** A texture picture that follows the texture picker. */
  function texturePicture(textures) {
    if (textures.length === 0) return element('p', 'No texture found for this model; drawn grey.', 'notes');
    const picture = element('img', undefined, 'texture');
    picture.alt = '';
    onTexture = (texture) => {
      picture.src = 'assets/' + texture;
      picture.title = texture;
    };
    onTexture(textures[0]);
    return picture;
  }

  async function select(item) {
    const file = `${item.path}.blockymodel`;
    details.replaceChildren(element('h2', item.id), element('p', `Common/${file}`, 'path'));
    const shown = await preview(item.path);
    if (!shown) return;
    if (shown.error) {
      details.append(element('p', `Could not load the model (${shown.error.message}). Re-run build_site.py.`, 'error'));
      return;
    }
    const { model, mesh, scale, textures } = shown;
    const size = mesh.max.map((max, i) => formatNumber((max - mesh.min[i]) * scale));
    details.append(
      chips([
        `${size.join(' × ')} blocks`,
        `${mesh.nodes} nodes`,
        `${mesh.count / 3} triangles`,
        item.animations?.length && `${item.animations.length} animations`,
        textures.length > 1 && `${textures.length} textures`,
      ]),
      texturePicture(textures),
      rawJson([[file, model]]),
    );
  }

  return {
    name: 'models',
    noun: 'models',
    showsViewer: true,
    items,
    group: (item) => item.group,
    select,
    leave: clearPreview,
    step,
    restart,
    preview,
    clearPreview,
    texturePicture,
  };
}

// Points the orbit camera at the model's middle, far enough back to see all of it.
function frameCamera(camera, mesh, scale) {
  const center = mesh.min.map((min, i) => ((min + mesh.max[i]) / 2) * scale);
  const radius = Math.hypot(...mesh.max.map((max, i) => (max - mesh.min[i]) * scale)) / 2;
  camera.target = center;
  camera.distance = Math.min(80, Math.max(0.5, radius * 2.4));
}
