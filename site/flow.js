// Node views: an NPC role's states as a state diagram, and a trigger volume's rules with what signals them
// and what they signal, spawn, enable or disable. Nodes are HTML boxes laid out in columns; edges are SVG
// curves under them.

import { element } from './dom.js';

function button(text, onClick, title) {
  const control = element('button', text);
  control.title = title;
  control.addEventListener('click', onClick);
  return control;
}

const NODE_WIDTH = 230;
const COLUMN_GAP = 100;
const ARC_ROOM = 70; // space above the nodes for edges that skip a column
const SHORT_LABEL = 28; // longer labels become a numbered badge with the text listed under the view
const ROW_GAP = 26;
const PADDING = 24;
const MAX_LINES = 5;
const MAX_TARGETS = 8;
const ANY_STATE = 'any state';
const SVG = 'http://www.w3.org/2000/svg';

const listOf = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const assetHref = (path) => `#assets:${encodeURIComponent(path)}`;
const stem = (path) => path.split('#')[0].split('/').pop().replace(/\.json$/, '');

/** Collects nodes and edges; a node or edge added twice is kept once. */
function graphBuilder() {
  const nodes = new Map();
  const edges = new Map();
  return {
    node(id, fields) {
      if (!nodes.has(id)) nodes.set(id, { id, lines: [], ...fields });
      else if (fields.accent) nodes.get(id).accent = fields.accent;
      return id;
    },
    edge(from, to, label = '') {
      const key = `${from}\n${to}`;
      const edge = edges.get(key) ?? { from, to, labels: [] };
      if (label && !edge.labels.includes(label)) edge.labels.push(label);
      edges.set(key, edge);
    },
    has: (id) => nodes.has(id),
    result: () => ({ nodes: [...nodes.values()], edges: [...edges.values()] }),
  };
}

// ---------------------------------------------------------------- layout and drawing

// Columns by longest path, after dropping the edges that close a cycle (found by depth-first search).
function ranks(nodes, edges, start) {
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    outgoing.get(edge.from).push(edge);
    if (edge.from !== edge.to) incoming.set(edge.to, incoming.get(edge.to) + 1);
  }
  const state = new Map();
  const order = [];
  const backwards = new Set();
  const visit = (id) => {
    state.set(id, 'open');
    for (const edge of outgoing.get(id)) {
      if (state.get(edge.to) === 'open') backwards.add(edge);
      else if (!state.has(edge.to)) visit(edge.to);
    }
    state.set(id, 'done');
    order.push(id);
  };
  const roots = nodes.filter((node) => node.id === start || incoming.get(node.id) === 0).map((node) => node.id);
  for (const id of [...roots, ...nodes.map((node) => node.id)]) if (!state.has(id)) visit(id);
  order.reverse();
  const rank = new Map(nodes.map((node) => [node.id, 0]));
  for (const id of order) {
    for (const edge of outgoing.get(id)) {
      if (!backwards.has(edge) && edge.from !== edge.to) rank.set(edge.to, Math.max(rank.get(edge.to), rank.get(id) + 1));
    }
  }
  return { rank, order };
}

function nodeBox(node) {
  const box = element('div', undefined, ['node', node.kind && `kind-${node.kind}`, node.accent].filter(Boolean).join(' '));
  if (node.kicker) box.append(element('div', node.kicker, 'kicker'));
  const title = node.href ? element('a', node.title) : element('strong', node.title);
  if (node.href) title.href = node.href;
  title.className = 'title';
  box.append(title);
  if (node.lines.length) {
    const list = element('ul');
    for (const line of node.lines.slice(0, MAX_LINES)) list.append(element('li', line));
    if (node.lines.length > MAX_LINES) list.append(element('li', `+${node.lines.length - MAX_LINES} more`, 'muted'));
    box.append(list);
  }
  box.style.width = `${NODE_WIDTH}px`;
  return box;
}

function svgElement(tag, attributes) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

const ZOOMS = [0.4, 0.5, 0.65, 0.8, 1, 1.25];
const SMALLEST_START_ZOOM = 0.65; // below this the text is too small to read without zooming in
const EDGE_KINDS = ['state', 'signal', 'spawn', 'run', 'enable', 'disable'];
let graphCount = 0;

// An edge's colour comes from what its label says it does.
function edgeKind(labels) {
  const first = labels[0] ?? '';
  if (first.startsWith('signal ')) return 'signal';
  return { spawns: 'spawn', runs: 'run', enables: 'enable', disables: 'disable' }[first] ?? 'state';
}

/**
 * A scrollable node view with zoom buttons and the list of its long edge labels; it lays itself out once it
 * is on the page. A view wider than its box starts zoomed out to fit, but no smaller than 65%.
 */
export function graphView({ nodes, edges, start }) {
  const wrapper = element('div');
  const legend = element('ol', undefined, 'graph-legend');
  const zoomBar = element('div', undefined, 'graph-zoom');
  const zoomLabel = element('span', '100%', 'muted');
  const view = element('div', undefined, 'graph');
  const sizer = element('div', undefined, 'graph-sizer');
  const canvas = element('div', undefined, 'graph-canvas');
  const svg = svgElement('svg', { class: 'graph-edges' });
  const markerId = (kind) => `arrow-${graphCount}-${kind}`;
  graphCount++;
  const defs = svgElement('defs', {});
  for (const kind of EDGE_KINDS) {
    const marker = svgElement('marker', { id: markerId(kind), viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    marker.append(svgElement('path', { d: 'M0,0 L10,5 L0,10 z', class: `edge-${kind}` }));
    defs.append(marker);
  }
  svg.append(defs);
  canvas.append(svg);
  sizer.append(canvas);
  view.append(sizer);
  let zoom = 1;
  const applyZoom = (value) => {
    zoom = value;
    canvas.style.transform = `scale(${zoom})`;
    sizer.style.width = `${canvas.offsetWidth * zoom}px`;
    sizer.style.height = `${canvas.offsetHeight * zoom}px`;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  };
  const stepZoom = (direction) => {
    const index = ZOOMS.findIndex((value) => value >= zoom - 1e-6);
    applyZoom(ZOOMS[Math.min(Math.max(index + direction, 0), ZOOMS.length - 1)]);
  };
  zoomBar.append(button('−', () => stepZoom(-1), 'Zoom out'), zoomLabel, button('+', () => stepZoom(1), 'Zoom in'), button('100%', () => applyZoom(1), 'Actual size'));
  const boxes = new Map(nodes.map((node) => [node.id, nodeBox(node)]));
  for (const box of boxes.values()) canvas.append(box);
  wrapper.append(zoomBar, view, legend);
  const titleOf = new Map(nodes.map((node) => [node.id, node.title]));

  requestAnimationFrame(() => {
    const { rank, order } = ranks(nodes, edges, start);
    const columns = [];
    for (const id of order) (columns[rank.get(id)] ??= []).push(id);
    const heights = columns.map((column) => column.reduce((sum, id) => sum + boxes.get(id).offsetHeight + ROW_GAP, -ROW_GAP));
    const tallest = Math.max(...heights, 0);
    const skips = edges.some((edge) => rank.get(edge.to) > rank.get(edge.from) + 1);
    const top = PADDING + (skips ? ARC_ROOM : 0);
    const place = new Map();
    columns.forEach((column, index) => {
      let y = top;
      for (const id of column) {
        const box = boxes.get(id);
        const x = PADDING + index * (NODE_WIDTH + COLUMN_GAP);
        box.style.left = `${x}px`;
        box.style.top = `${y}px`;
        place.set(id, { x, y, width: NODE_WIDTH, height: box.offsetHeight });
        y += box.offsetHeight + ROW_GAP;
      }
    });
    const width = PADDING * 2 + columns.length * NODE_WIDTH + (columns.length - 1) * COLUMN_GAP;
    const loopsBack = edges.some((edge) => edge.from !== edge.to && rank.get(edge.to) <= rank.get(edge.from));
    const height = top + PADDING + tallest + (loopsBack ? 80 : 0);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);

    for (const edge of edges) {
      const a = place.get(edge.from);
      const b = place.get(edge.to);
      let points;
      if (edge.from === edge.to) {
        points = [[a.x + a.width - 30, a.y], [a.x + a.width - 10, a.y - 40], [a.x + 10, a.y - 40], [a.x + 30, a.y]];
      } else if (rank.get(edge.to) === rank.get(edge.from) + 1) {
        const [x1, y1, x2, y2] = [a.x + a.width, a.y + a.height / 2, b.x, b.y + b.height / 2];
        const bend = (x2 - x1) / 2;
        points = [[x1, y1], [x1 + bend, y1], [x2 - bend, y2], [x2, y2]];
      } else if (rank.get(edge.to) > rank.get(edge.from)) {
        const [x1, y1, x2, y2] = [a.x + a.width / 2, a.y, b.x + b.width / 2, b.y];
        const peak = PADDING + 10;
        points = [[x1, y1], [x1, peak], [x2, peak], [x2, y2]];
      } else {
        const [x1, y1, x2, y2] = [a.x + a.width / 2, a.y + a.height, b.x + b.width / 2, b.y + b.height];
        const dip = Math.max(y1, y2) + 50;
        points = [[x1, y1], [x1, dip], [x2, dip], [x2, y2]];
      }
      const d = `M${points[0]} C${points[1]} ${points[2]} ${points[3]}`;
      const kind = edgeKind(edge.labels);
      svg.append(svgElement('path', { d, class: `edge edge-${kind}`, 'marker-end': `url(#${markerId(kind)})` }));
      if (edge.labels.length) {
        const joined = edge.labels.join('  /  ');
        const long = joined.length > SHORT_LABEL;
        const label = element('div', long ? String(legend.childElementCount + 1) : joined, `edge-label edge-${kind}${long ? ' badge-number' : ''}`);
        if (long) {
          const entry = element('li');
          entry.append(element('strong', `${titleOf.get(edge.from)} → ${titleOf.get(edge.to)}`));
          for (const text of edge.labels) entry.append(element('div', text));
          legend.append(entry);
          label.title = edge.labels.join('\nor: ');
        }
        const mid = [0, 1].map((axis) => (points[0][axis] + 3 * points[1][axis] + 3 * points[2][axis] + points[3][axis]) / 8);
        label.style.left = `${mid[0]}px`;
        label.style.top = `${mid[1]}px`;
        canvas.append(label);
      }
    }
    legend.hidden = legend.childElementCount === 0;
    const fit = view.clientWidth / width;
    applyZoom(fit < 1 ? Math.max(ZOOMS.filter((value) => value <= fit).pop() ?? ZOOMS[0], SMALLEST_START_ZOOM) : 1);
    zoomBar.hidden = width <= view.clientWidth;
  });
  return wrapper;
}

// ---------------------------------------------------------------- NPC role state diagram

const isPlain = (value) =>
  ['string', 'number', 'boolean'].includes(typeof value) || (Array.isArray(value) && value.every((v) => typeof v === 'number'));

/**
 * The role with each {"Compute": "Name"} that names a parameter replaced by its plain value: `overrides` (a
 * variant's Modify) first, else the role's own Parameters default. Anything else stays as it is.
 */
export function fillParameters(role, overrides = {}) {
  const values = {};
  for (const [name, parameter] of Object.entries(role.Parameters ?? {})) if (isPlain(parameter?.Value)) values[name] = parameter.Value;
  for (const [name, value] of Object.entries(overrides)) if (isPlain(value)) values[name] = value;
  return JSON.parse(JSON.stringify(role), (key, value) =>
    value && typeof value === 'object' && typeof value.Compute === 'string' && value.Compute in values ? values[value.Compute] : value,
  );
}

/**
 * The role whose rules a role runs: itself when it has rules, else the template it references (following
 * Variant chains), with the variants' Modify values filled in. Resolves to null when there are none.
 */
export async function ruleSource(role, context) {
  const modifies = [];
  let current = role;
  for (let depth = 0; current && !listOf(current.Instructions).length && depth < 6; depth++) {
    if (current.Modify) modifies.push(current.Modify);
    const path = typeof current.Reference === 'string' ? context?.assetPath(current.Reference, 'Server/NPC/Roles/') : null;
    current = path ? await context.load(path).catch(() => null) : null;
  }
  if (!current || !listOf(current.Instructions).length) return null;
  return fillParameters(current, Object.assign({}, ...modifies.reverse()));
}

function flattenActions(actions) {
  return listOf(actions).flatMap((action) => {
    const inner = action?.Action ?? action;
    if (inner?.Type === 'Random' || inner?.Type === 'Sequence') return flattenActions(inner.Actions);
    if (inner?.Type === 'Timeout' && inner.Action) return [inner, ...flattenActions([inner.Action])];
    return inner ? [inner] : [];
  });
}

// The states a sensor requires, and what else it asks for.
function splitStates(sensor) {
  if (!sensor) return { states: [], rest: null };
  if (sensor.Type === 'State' && typeof sensor.State === 'string') return { states: [sensor.State], rest: null };
  const children = listOf(sensor.Sensors);
  if (sensor.Type === 'Or' && children.length && children.every((child) => child.Type === 'State')) {
    return { states: children.map((child) => child.State), rest: null };
  }
  if (sensor.Type === 'And') {
    const states = children.filter((child) => child.Type === 'State').map((child) => child.State);
    const others = children.filter((child) => child.Type !== 'State');
    if (states.length) return { states, rest: others.length > 1 ? { ...sensor, Sensors: others } : (others[0] ?? null) };
  }
  return { states: [], rest: sensor };
}

const QUIET_ACTIONS = new Set(['State', 'PlayAnimation', 'Nothing', 'DisplayName']);

// A state written ".Sub" is read as a sub-state of the main state it is used in ("Combat" + ".Sub").
const resolveState = (name, within) =>
  name.startsWith('.') && within.length ? within.map((state) => state.split('.')[0] + name) : [name];

/**
 * States as nodes; each rule that sets a state is an edge from the states it runs in. Actions of rules that
 * keep the state are listed in the state's box. `describe` turns sensors, actions and motions into text.
 */
export function roleFlow(role, describe) {
  const graph = graphBuilder();
  const notes = new Map();
  const stateNode = (name) =>
    graph.node(name, {
      title: name,
      kind: 'state',
      kicker: name === role.StartState ? 'start state' : name === ANY_STATE ? 'rules for every state' : 'state',
      accent: name === role.StartState ? 'start' : undefined,
    });
  if (role.StartState) stateNode(role.StartState);

  const visit = (rules, gates) => {
    for (const rule of listOf(rules)) {
      if (!rule || rule.Reference || rule.Enabled === false) continue;
      const { states, rest } = splitStates(rule.Sensor);
      const active = states.length ? [...new Set(states.flatMap((state) => resolveState(state, gates)))] : gates;
      const actions = flattenActions(rule.Actions);
      const targets = [
        ...new Set(
          actions.filter((action) => action.Type === 'State' && typeof action.State === 'string').flatMap((a) => resolveState(a.State, active)),
        ),
      ];
      const doing = actions.filter((action) => !QUIET_ACTIONS.has(action.Type)).map(describe.action);
      if (rule.BodyMotion?.Type && rule.BodyMotion.Type !== 'Nothing') doing.push(`body: ${rule.BodyMotion.Type}`);
      const condition = rest ? describe.sensor(rest) : '';
      const from = active.length ? active : [ANY_STATE];
      for (const target of targets) {
        stateNode(target);
        for (const state of from) graph.edge(stateNode(state), target, [condition, ...doing.slice(0, 2)].filter(Boolean).join(' → '));
      }
      if (targets.length === 0 && doing.length) {
        for (const state of from) {
          stateNode(state);
          const list = notes.get(state) ?? [];
          for (const line of doing) if (!list.includes(line)) list.push(line);
          notes.set(state, list);
        }
      }
      if (rule.Instructions) visit(rule.Instructions, active);
    }
  };
  visit(role.Instructions, []);
  const { nodes, edges } = graph.result();
  for (const node of nodes) node.lines = notes.get(node.id) ?? [];
  return nodes.length > 1 || edges.length ? { nodes, edges, start: role.StartState } : null;
}

// ---------------------------------------------------------------- trigger volume flow

function rulesOf(volume) {
  const rules = new Map();
  const ruleFor = (entry) => {
    const key = `${entry.Event}#${entry.Entry ?? 0}`;
    if (!rules.has(key)) rules.set(key, { key, event: entry.Event, entry: entry.Entry ?? 0, conditions: [], effects: [] });
    return rules.get(key);
  };
  for (const condition of listOf(volume.Conditions)) ruleFor(condition).conditions.push(condition);
  for (const effect of listOf(volume.Effects)) ruleFor(effect).effects.push(effect);
  return [...rules.values()];
}

const signalsHeard = (rule) =>
  rule.event === 'SIGNAL_RECEIVED'
    ? rule.conditions.filter((c) => c.Type === 'TagCondition' && c.Source === 'Event' && c.TagKey).map((c) => c.TagKey)
    : [];

const hasTag = (volume, tag) => !tag || Boolean(volume.Tags && tag in volume.Tags);

// Every SignalNearbyVolumes key in an interaction, however deep.
function signalsSent(interaction) {
  const keys = [];
  JSON.stringify(interaction, (key, value) => {
    if (value?.Type === 'SignalNearbyVolumes') keys.push(...listOf(value.SignalKeys));
    return value;
  });
  return keys;
}

// Interaction names a role runs (SpawnInteraction and other "...Interaction" keys, and attacks).
function interactionsRun(role) {
  const names = new Set();
  JSON.stringify(role, (key, value) => {
    if (typeof value === 'string' && (/Interaction$/.test(key) || key === 'Attack')) names.add(value);
    return value;
  });
  return [...names];
}

/**
 * The picked volume's rules, plus one hop around them: volumes and interactions that signal them, volumes they
 * signal, enable or disable, and NPCs they spawn, followed to the interactions those NPCs run when such an
 * interaction signals volumes in this instance. Signals are matched by name and tag; distances are ignored.
 *
 * `context`: {instancePath, volumes, load(path), assetPath(name, folder), refsFor(key), describeCondition,
 * describeEffect}.
 */
export async function volumeFlow(volume, context) {
  const { instancePath, volumes } = context;
  const graph = graphBuilder();
  const ruleId = (owner, rule) => `volume:${owner.Name}#${rule.key}`;

  const addRule = (owner, rule, accent) =>
    graph.node(ruleId(owner, rule), {
      kicker: `volume · on ${rule.event}${rule.entry ? `, rule ${rule.entry + 1}` : ''}`,
      kind: 'volume',
      title: owner.Name,
      href: assetHref(`${instancePath}#${owner.Name}`),
      accent,
      lines: [
        ...rule.conditions.map((condition) => `if ${context.describeCondition(condition)}`),
        ...[...rule.effects]
          .sort((a, b) => (a.Delay ?? 0) - (b.Delay ?? 0))
          .map((effect) => `${effect.Delay ? `after ${effect.Delay} s: ` : ''}${context.describeEffect(effect)}`),
      ],
    });

  const addAsset = (path, kicker) =>
    graph.node(`asset:${path}`, { kicker, kind: kicker === 'NPC role' ? 'role' : 'interaction', title: stem(path), href: assetHref(path) });

  // Draws at most MAX_TARGETS edges to `targets` and a "+N more" box for the rest.
  const fanOut = (from, targets, label, connect) => {
    targets.slice(0, MAX_TARGETS).forEach(connect);
    if (targets.length > MAX_TARGETS) {
      const more = graph.node(`more:${from}:${label}`, { title: `+${targets.length - MAX_TARGETS} more`, kicker: 'not shown', kind: 'more' });
      graph.edge(from, more, label);
    }
  };

  const receivers = (key, tag) =>
    volumes.flatMap((owner) => (hasTag(owner, tag) ? rulesOf(owner).filter((rule) => signalsHeard(rule).includes(key)).map((rule) => [owner, rule]) : []));

  const loadSafely = (path) => context.load(path).catch(() => null);

  // An NPC role, and the interactions it runs that signal volumes here, with their receivers.
  const followRole = async (path) => {
    const roleId = addAsset(path, 'NPC role');
    const role = await loadSafely(path);
    for (const name of role ? interactionsRun(role) : []) {
      const interactionPath = context.assetPath(name, 'Server/Item/');
      const interaction = interactionPath && (await loadSafely(interactionPath));
      const keys = interaction ? signalsSent(interaction) : [];
      if (keys.length === 0) continue;
      const interactionId = addAsset(interactionPath, 'interaction');
      graph.edge(roleId, interactionId, 'runs');
      for (const key of keys) {
        fanOut(interactionId, receivers(key), `signal ${key}`, ([owner, rule]) => graph.edge(interactionId, addRule(owner, rule), `signal ${key}`));
      }
    }
    return roleId;
  };

  const focus = rulesOf(volume);
  for (const rule of focus) addRule(volume, rule, 'focus');

  for (const rule of focus) {
    const from = ruleId(volume, rule);
    for (const effect of rule.effects) {
      if (effect.Type === 'SendSignal') {
        for (const key of listOf(effect.SignalKeys)) {
          fanOut(from, receivers(key, effect.MatchKey), `signal ${key}`, ([owner, target]) => graph.edge(from, addRule(owner, target), `signal ${key}`));
        }
      } else if ((effect.Type === 'EnableVolume' || effect.Type === 'DisableVolume') && effect.MatchKey) {
        const verb = effect.Type === 'EnableVolume' ? 'enables' : 'disables';
        const targets = volumes.filter((owner) => hasTag(owner, effect.MatchKey) && rulesOf(owner).length);
        fanOut(from, targets, verb, (owner) => graph.edge(from, addRule(owner, rulesOf(owner)[0]), verb));
      } else if (effect.Type === 'SpawnNpc' && typeof effect.NpcType === 'string') {
        const path = context.assetPath(effect.NpcType, 'Server/NPC/Roles/');
        if (path) graph.edge(from, await followRole(path), 'spawns');
      }
    }
  }

  for (const rule of focus) {
    const to = ruleId(volume, rule);
    for (const key of signalsHeard(rule)) {
      for (const owner of volumes) {
        for (const sender of rulesOf(owner)) {
          const sends = sender.effects.some(
            (effect) => effect.Type === 'SendSignal' && listOf(effect.SignalKeys).includes(key) && hasTag(volume, effect.MatchKey),
          );
          if (sends) graph.edge(addRule(owner, sender), to, `signal ${key}`);
        }
      }
      for (const { source } of context.refsFor(`signal:${key}`)) {
        if (source.includes('#') || !source.startsWith('Server/Item/')) continue;
        const interactionId = addAsset(source, 'interaction');
        graph.edge(interactionId, to, `signal ${key}`);
        for (const ref of context.refsFor(`asset:${stem(source)}`)) {
          if (!ref.source.startsWith('Server/NPC/Roles/')) continue;
          const roleId = addAsset(ref.source, 'NPC role');
          graph.edge(roleId, interactionId, 'runs');
          for (const owner of volumes) {
            for (const spawner of rulesOf(owner)) {
              if (spawner.effects.some((effect) => effect.Type === 'SpawnNpc' && effect.NpcType === stem(ref.source))) {
                graph.edge(addRule(owner, spawner), roleId, 'spawns');
              }
            }
          }
        }
      }
    }
  }
  return graph.result();
}
