// Page wiring: loads the data, switches tabs, lists items, shows particle details and runs the preview loop.

import { element, formatNumber } from './dom.js';
import { Renderer } from './render.js';
import { createScreenTab } from './screen.js';
import { SystemInstance } from './sim.js';
import { createSoundsTab } from './sounds.js';

const RESTART_PAUSE = 0.6; // seconds between the end of a one-shot effect and its replay
const HIDDEN_FOLDERS = new Set(['_Test', '_Example']);
const MAX_FRAME_SECONDS = 0.05;

// Spawner features present in the data that the preview does not reproduce.
const NOT_SIMULATED = [
  [(s) => s.UVMotion, 'UV flow-map distortion (UVMotion)'],
  [(s) => s.RenderMode === 'Distortion', 'Distortion render mode (drawn as a faint grey ghost)'],
  [(s) => s.ParticleCollision, 'block collision (ParticleCollision)'],
  [(s) => s.IntersectionHighlight, 'block intersection highlight'],
  [(s) => s.LightInfluence > 0, 'world lighting (LightInfluence)'],
  [(s) => s.VelocityStretchMultiplier, 'velocity stretch'],
  [(s) => s.Particle?.UseSpriteBlending, 'blending between sprite frames'],
];

const elements = {
  tabs: document.getElementById('tabs'),
  list: document.getElementById('list'),
  search: document.getElementById('search'),
  showHidden: document.getElementById('show-hidden'),
  count: document.getElementById('count'),
  viewer: document.getElementById('viewer'),
  canvas: document.getElementById('canvas'),
  overlay: document.getElementById('overlay'),
  details: document.getElementById('details'),
  restart: document.getElementById('restart'),
  pause: document.getElementById('pause'),
  speed: document.getElementById('speed'),
  grid: document.getElementById('grid'),
  background: document.getElementById('background'),
  stats: document.getElementById('stats'),
};

const state = {
  tabs: {},
  tab: null,
  selected: {},
  systems: [],
  spawnersById: new Map(),
  problems: [],
  current: null,
  instance: null,
  hiddenGroups: new Set(),
  paused: false,
  speed: 1,
  restartIn: null,
};

let renderer;

// ---------------------------------------------------------------- data

const topFolder = (path) => path.split('/')[0];
const isHiddenFolder = (path) => HIDDEN_FOLDERS.has(topFolder(path));

// Some spawner ids exist twice (usually a real one and a _Test copy); prefer the one in the
// system's own top folder, then any non-test one.
function resolveSpawner(id, systemPath) {
  const candidates = state.spawnersById.get(id) ?? [];
  if (candidates.length <= 1) return candidates[0];
  return (
    candidates.find((c) => topFolder(c.path) === topFolder(systemPath)) ??
    candidates.find((c) => !isHiddenFolder(c.path)) ??
    candidates[0]
  );
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

async function loadData() {
  const [data, sounds, screen] = await Promise.all(
    ['particles', 'sounds', 'screen'].map((name) => fetchJson(`data/${name}.json`)),
  );
  state.systems = data.systems;
  state.problems = data.problems ?? [];
  for (const spawner of data.spawners) {
    if (!state.spawnersById.has(spawner.id)) state.spawnersById.set(spawner.id, []);
    state.spawnersById.get(spawner.id).push(spawner);
  }
  const particles = {
    name: 'particles',
    noun: 'systems',
    showsViewer: true,
    items: state.systems,
    group: (system) => topFolder(system.path),
    select: selectSystem,
  };
  for (const tab of [
    particles,
    createSoundsTab(sounds, elements.details),
    createScreenTab(screen, elements.details, elements.overlay),
  ]) {
    state.tabs[tab.name] = tab;
  }
}

// ---------------------------------------------------------------- tabs and list

const itemHash = (tab, item) => `${tab.name}:${encodeURIComponent(item?.path ?? '')}`;

function visibleItems() {
  const query = elements.search.value.trim().toLowerCase();
  return state.tab.items.filter(
    (item) =>
      (elements.showHidden.checked || !isHiddenFolder(item.path)) && (!query || item.path.toLowerCase().includes(query)),
  );
}

function renderList() {
  const tab = state.tab;
  const items = visibleItems();
  const searching = elements.search.value.trim() !== '';
  const selected = state.selected[tab.name];
  const byGroup = new Map();
  for (const item of items) {
    const name = tab.group(item);
    if (!byGroup.has(name)) byGroup.set(name, []);
    byGroup.get(name).push(item);
  }
  const fragment = document.createDocumentFragment();
  for (const [name, groupItems] of byGroup) {
    const group = document.createElement('details');
    group.open = searching || (selected !== undefined && tab.group(selected) === name);
    const summary = document.createElement('summary');
    summary.textContent = `${name} (${groupItems.length})`;
    group.append(summary);
    for (const item of groupItems) {
      const button = document.createElement('button');
      button.textContent = item.id;
      button.title = item.path;
      button.dataset.path = item.path;
      button.classList.toggle('selected', item === selected);
      button.addEventListener('click', () => (location.hash = itemHash(tab, item)));
      group.append(button);
    }
    fragment.append(group);
  }
  elements.list.replaceChildren(fragment);
  elements.count.textContent = `${items.length} of ${tab.items.length} ${tab.noun}`;
}

function markSelected() {
  const path = state.selected[state.tab.name]?.path;
  for (const button of elements.list.querySelectorAll('button')) {
    const selected = button.dataset.path === path;
    button.classList.toggle('selected', selected);
    if (selected) {
      button.parentElement.open = true;
      button.scrollIntoView({ block: 'nearest' });
    }
  }
}

function moveSelection(step) {
  const items = visibleItems();
  if (items.length === 0) return;
  const index = items.indexOf(state.selected[state.tab.name]);
  location.hash = itemHash(state.tab, items[(index + step + items.length) % items.length]);
}

function showTab(tab) {
  state.tab?.leave?.();
  state.tab = tab;
  for (const button of elements.tabs.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.tab === tab.name);
  }
  elements.viewer.hidden = !tab.showsViewer;
  renderList();
}

// A hash is "<tab>:<path>"; a bare path is a particle system, as in links from before the tabs.
function selectFromHash() {
  const [, name, path] = decodeURIComponent(location.hash.slice(1)).match(/^(?:(\w+):)?(.*)$/s);
  const tab = state.tabs[name] ?? state.tabs.particles;
  const item =
    tab.items.find((i) => i.path === path) ?? state.selected[tab.name] ?? tab.items.find((i) => !isHiddenFolder(i.path));
  if (!item) return;
  if (tab !== state.tab) showTab(tab);
  state.selected[tab.name] = item;
  tab.select(item);
  markSelected();
}

// ---------------------------------------------------------------- particle details

function selectSystem(system) {
  state.current = system;
  state.hiddenGroups.clear();
  restart();
  renderDetails();
}

function restart() {
  const system = state.current;
  if (!system) return;
  state.instance = new SystemInstance(system.data, (id) => resolveSpawner(id, system.path)?.data);
  state.instance.groups.forEach((group, index) => (group.hidden = state.hiddenGroups.has(index)));
  state.restartIn = null;
}

function formatRange(range) {
  if (range === undefined || range === null) return '';
  if (typeof range === 'number') return formatNumber(range);
  const min = formatNumber(range.Min ?? 0);
  const max = formatNumber(range.Max ?? 0);
  return min === max ? min : `${min} to ${max}`;
}

function renderDetails() {
  const system = state.current;
  const data = system.data;
  const panel = elements.details;
  panel.replaceChildren();
  panel.append(element('h2', system.id), element('p', `Server/Particles/${system.path}.particlesystem`, 'path'));

  const lifeSpan = data.LifeSpan > 0 ? `${data.LifeSpan} s` : 'unlimited';
  const facts = [`System life: ${lifeSpan}`, `Spawners: ${(data.Spawners ?? []).length}`];
  if (data.IsImportant) facts.push('Important');
  panel.append(element('p', facts.join('  |  '), 'facts'));
  if (data.$Comment) panel.append(element('p', `Comment: ${data.$Comment}`, 'comment'));

  const groups = (data.Spawners ?? []).map((group) => ({ group, spawner: resolveSpawner(group.SpawnerId, system.path) }));
  const missing = new Set();
  for (const { spawner } of groups) {
    for (const [test, label] of NOT_SIMULATED) if (spawner && test(spawner.data)) missing.add(label);
  }
  const problems = state.problems.filter((problem) => problem.startsWith(system.path + ':'));
  if (missing.size || problems.length) {
    const notes = element('div', undefined, 'notes');
    if (missing.size) notes.append(element('p', `Not simulated here: ${[...missing].join(', ')}.`));
    for (const problem of problems) notes.append(element('p', `Data problem: ${problem}`));
    panel.append(notes);
  }

  panel.append(spawnerTable(groups));

  const json = element('details');
  json.append(element('summary', 'Raw JSON'));
  json.append(element('h3', `${system.id}.particlesystem`), element('pre', JSON.stringify(data, null, 2)));
  for (const spawner of new Set(groups.map((g) => g.spawner).filter(Boolean))) {
    json.append(element('h3', `${spawner.path}.particlespawner`), element('pre', JSON.stringify(spawner.data, null, 2)));
  }
  panel.append(json);
}

function spawnerTable(groups) {
  const table = element('table');
  const head = element('tr');
  for (const title of ['Show', 'Spawner', 'Texture', 'Render', 'Facing', 'Particle life (s)', 'Rate', 'Burst', 'Delay (s)']) {
    head.append(element('th', title));
  }
  table.append(head);
  groups.forEach(({ group, spawner }, index) => {
    const row = element('tr');
    const toggle = element('input');
    toggle.type = 'checkbox';
    toggle.checked = !state.hiddenGroups.has(index);
    toggle.addEventListener('change', () => {
      if (toggle.checked) state.hiddenGroups.delete(index);
      else state.hiddenGroups.add(index);
      if (state.instance) state.instance.groups[index].hidden = !toggle.checked;
    });
    const showCell = element('td');
    showCell.append(toggle);
    row.append(showCell);

    const nameCell = element('td', group.SpawnerId);
    nameCell.title = spawner ? spawner.path : 'Spawner not found';
    if (!spawner) nameCell.classList.add('missing');
    row.append(nameCell);

    const s = spawner?.data ?? {};
    const textureCell = element('td');
    if (s.Particle?.Texture) {
      const image = element('img', undefined, 'thumb');
      image.src = 'assets/' + s.Particle.Texture;
      image.title = s.Particle.Texture;
      image.alt = '';
      textureCell.append(image);
    }
    row.append(textureCell);
    row.append(
      element('td', s.RenderMode ?? 'BlendLinear'),
      element('td', s.ParticleRotationInfluence ?? 'None'),
      element('td', formatRange(s.ParticleLifeSpan)),
      element('td', formatRange(s.SpawnRate)),
      element('td', s.SpawnBurst ? `yes${s.WaveDelay ? `, every ${formatRange(s.WaveDelay)} s` : ''}` : 'no'),
      element('td', group.StartDelay ? String(group.StartDelay) : ''),
    );
    table.append(row);
  });
  return table;
}

// ---------------------------------------------------------------- controls and loop

function restartAll() {
  restart();
  state.tabs.screen.restart();
}

function wireControls() {
  for (const button of elements.tabs.querySelectorAll('button')) {
    const tab = state.tabs[button.dataset.tab];
    button.addEventListener('click', () => (location.hash = itemHash(tab, state.selected[tab.name])));
  }
  elements.search.addEventListener('input', renderList);
  elements.showHidden.addEventListener('change', renderList);
  elements.restart.addEventListener('click', restartAll);
  elements.pause.addEventListener('click', togglePause);
  elements.speed.addEventListener('change', () => (state.speed = parseFloat(elements.speed.value)));
  elements.grid.addEventListener('change', () => (renderer.showGrid = elements.grid.checked));
  elements.background.addEventListener('input', () => {
    const value = parseInt(elements.background.value.slice(1), 16);
    renderer.background = [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
  });
  window.addEventListener('hashchange', selectFromHash);
  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.key === ' ') togglePause();
    else if (event.key === 'r') restartAll();
    else if (event.key === 'ArrowDown') moveSelection(1);
    else if (event.key === 'ArrowUp') moveSelection(-1);
    else return;
    event.preventDefault();
  });
  wireCamera();
}

function togglePause() {
  state.paused = !state.paused;
  elements.pause.textContent = state.paused ? 'Play' : 'Pause';
}

// Drag to orbit, shift-drag or right-drag to pan, wheel to zoom, double-click to reset.
function wireCamera() {
  const canvas = elements.canvas;
  const camera = renderer.camera;
  const home = { ...camera, target: [...camera.target] };
  let drag = null;
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('pointerdown', (event) => {
    drag = { x: event.clientX, y: event.clientY, pan: event.shiftKey || event.button === 2 };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (drag.pan) {
      const step = camera.distance * 0.002;
      const yaw = (camera.yaw * Math.PI) / 180;
      camera.target[0] -= Math.cos(yaw) * dx * step;
      camera.target[2] += Math.sin(yaw) * dx * step;
      camera.target[1] += dy * step;
    } else {
      camera.yaw -= dx * 0.4;
      camera.pitch = Math.min(89, Math.max(-89, camera.pitch + dy * 0.4));
    }
  });
  canvas.addEventListener('pointerup', () => (drag = null));
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      camera.distance = Math.min(80, Math.max(0.5, camera.distance * Math.exp(event.deltaY * 0.001)));
    },
    { passive: false },
  );
  canvas.addEventListener('dblclick', () => Object.assign(camera, { ...home, target: [...home.target] }));
}

function startLoop() {
  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min((now - last) / 1000, MAX_FRAME_SECONDS) * state.speed;
    last = now;
    const instance = state.instance;
    if (instance && !state.paused) {
      instance.step(dt);
      if (instance.finished) {
        state.restartIn ??= RESTART_PAUSE;
        state.restartIn -= dt;
        if (state.restartIn <= 0) restart();
      }
    }
    if (!state.paused) state.tabs.screen.step(dt);
    renderer.shake = state.tabs.screen.cameraShake();
    renderer.draw(state.instance);
    elements.stats.textContent = state.instance
      ? `${state.instance.particleCount} particles, ${state.instance.age.toFixed(1)} s`
      : '';
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function showError(message) {
  elements.details.replaceChildren(element('p', message, 'error'));
}

async function main() {
  try {
    renderer = new Renderer(elements.canvas);
  } catch (error) {
    showError(`Could not start WebGL: ${error.message}`);
    return;
  }
  try {
    await loadData();
  } catch (error) {
    showError(
      `Could not load the data (${error.message}). Run "python3 build_site.py", then serve the ` +
        'site folder with "python3 -m http.server -d site 8000" and open http://localhost:8000.',
    );
    return;
  }
  wireControls();
  selectFromHash();
  startLoop();
}

main();
