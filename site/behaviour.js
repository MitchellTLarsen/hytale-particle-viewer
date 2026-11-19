// Plain-English cards for NPC roles, interactions and trigger volumes, shown above their JSON in the Assets tab.
// Common sensor, action and effect types get a sentence; the rest show as their type and parameters.

import { button, chips, element } from './dom.js';
import { graphView, roleFlow, ruleSource, volumeFlow } from './flow.js';
import { valueNode } from './links.js';

const META_KEYS = new Set(['Type', '$Comment', '$TODO', 'Enabled']);
const FLOW_KEYS = new Set(['Sensor', 'Sensors', 'Actions', 'Action', 'Instructions', 'Filters', 'Next', 'Failed']);
const NOT_A_BRANCH = new Set(['Knockback', 'DamageCalculator', 'Tags', 'Effects', 'Selector']);

// Some test assets hold a single object where a list is expected.
const listOf = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const isScalar = (value) => ['string', 'number', 'boolean'].includes(typeof value);
const isEmpty = (value) =>
  value === null || value === '' || value === 0 || value === false || (typeof value === 'object' && Object.keys(value).length === 0);
const isInteraction = (value) => value && typeof value === 'object' && !Array.isArray(value) && typeof value.Type === 'string';

function phrase(...parts) {
  const span = element('span');
  for (const part of parts.flat(Infinity)) if (part !== undefined && part !== null && part !== '') span.append(part);
  return span;
}

const code = (text, kind) => element('code', String(text), kind);

function wrap(tag, ...parts) {
  const node = element(tag);
  node.append(phrase(...parts));
  return node;
}

// A value as text: {"Compute": X} is a template parameter, [a, b] number pairs are ranges, names may be links.
function show(value, key = '') {
  if (value && typeof value === 'object' && 'Compute' in value) return code(`‹${value.Compute}›`);
  if (Array.isArray(value)) {
    if (value.length === 2 && value.every((v) => typeof v === 'number')) {
      return value[0] === value[1] ? String(value[0]) : `${value[0]} to ${value[1]}`;
    }
    if (value.every(isScalar)) return phrase(value.map((v, i) => [i ? ', ' : '', show(v, key)]));
    return '…';
  }
  if (typeof value === 'string') return valueNode(value, key);
  if (isScalar(value)) return String(value);
  return '…';
}

// "(Key value, ...)" for the parameters worth showing; skips flow keys, nested objects and defaults.
function params(node, skip = new Set()) {
  const shown = Object.entries(node).filter(
    ([key, value]) =>
      !META_KEYS.has(key) && !FLOW_KEYS.has(key) && !skip.has(key) && !isEmpty(value) && (isScalar(value) || Array.isArray(value) || value?.Compute),
  );
  if (shown.length === 0) return '';
  return [' (', shown.map(([key, value], i) => [i ? ', ' : '', `${key} `, show(value, key)]), ')'];
}

const generic = (node, skip) => [code(node.Type ?? '?'), params(node, skip)];

// ---------------------------------------------------------------- Flow and List views

let preferredView = 'flow';

/** A Flow / List switch: the flow (from `buildFlow`, which may be async) is drawn the first time it shows. */
function views(buildFlow, listParts) {
  const box = element('div');
  const switcher = element('div', undefined, 'view-switch');
  const flowBox = element('div');
  const listBox = element('div');
  listBox.append(...listParts);
  const buttons = new Map();
  let drawn = false;
  const show = (view) => {
    preferredView = view;
    flowBox.hidden = view !== 'flow';
    listBox.hidden = view !== 'list';
    for (const [name, control] of buttons) control.classList.toggle('active', name === view);
    if (view !== 'flow' || drawn) return;
    drawn = true;
    flowBox.append(element('p', 'Drawing...', 'muted'));
    Promise.resolve()
      .then(buildFlow)
      .then((graph) => flowBox.replaceChildren(graph?.nodes.length ? graphView(graph) : element('p', 'Nothing to draw here.', 'muted')))
      .catch((error) => flowBox.replaceChildren(element('p', `Could not draw the flow (${error.message}).`, 'error')));
  };
  for (const [name, label] of [['flow', 'Flow'], ['list', 'List']]) {
    buttons.set(name, button(label, () => show(name)));
    switcher.append(buttons.get(name));
  }
  box.append(switcher, flowBox, listBox);
  show(preferredView);
  return box;
}

const text = (...parts) => phrase(...parts).textContent;

// ---------------------------------------------------------------- NPC roles

function sight(sensor) {
  const filters = (sensor.Filters ?? []).map((filter) => filter.Type);
  const rest = filters.filter((type) => type !== 'LineOfSight');
  return [filters.includes('LineOfSight') ? ' in line of sight' : '', rest.length ? ` (filters: ${rest.join(', ')})` : ''];
}

const within = (range) => (range === undefined ? '' : [' within ', show(range), ' blocks']);

const SENSORS = {
  State: (s) => ['state is ', code(s.State, 'state')],
  Player: (s) => ['a player is', within(s.Range), sight(s)],
  Target: (s) => ['a target is', within(s.Range), sight(s)],
  Mob: (s) => [s.GetPlayers && s.GetNPCs ? 'a player or NPC is' : s.GetPlayers ? 'a player is' : 'an NPC is', within(s.Range), sight(s)],
  Any: (s) => [s.Once ? 'once' : 'always'],
  Beacon: (s) => ['message ', code(s.Message, 'signal'), ' is heard', within(s.Range)],
  Timer: (s) => ['timer ', code(s.Name), ' is ', String(s.State ?? 'running').toLowerCase()],
  Flag: (s) => ['flag ', code(s.Name), s.Set === false ? ' is clear' : ' is set'],
  Damage: () => ['it takes damage'],
  Self: () => ['itself'],
  Not: (s) => ['not (', sensorText(s.Sensor), ')'],
  And: (s) => listOf(s.Sensors).map((sub, i) => [i ? ' and ' : '', sensorText(sub, true)]),
  Or: (s) => listOf(s.Sensors).map((sub, i) => [i ? ' or ' : '', sensorText(sub, true)]),
  AdjustPosition: (s) => [sensorText(s.Sensor), ' (position offset ', show(s.Offset), ')'],
  ChargeState: (s) => ['charge state is ', show(s.States)],
};

function sensorText(sensor, nested = false) {
  if (!sensor) return 'always';
  if (sensor.Reference) return ['component ', show(sensor.Reference, 'Reference'), params(sensor.Modify ?? {})];
  const describe = SENSORS[sensor.Type];
  if (!describe) return generic(sensor);
  const text = describe(sensor);
  return nested && (sensor.Type === 'And' || sensor.Type === 'Or') ? ['(', text, ')'] : text;
}

const ACTIONS = {
  State: (a) => ['go to state ', code(a.State, 'state')],
  Timeout: (a) => ['wait ', show(a.Delay), ' s', a.Action ? [', then ', actionText(a.Action)] : ''],
  PlayAnimation: (a) => (a.Animation ? ['play animation ', code(a.Animation), ` (${a.Slot ?? 'slot'})`] : [`stop the ${a.Slot ?? ''} animation`]),
  Beacon: (a) => ['send message ', code(a.Message, 'signal'), ' to ', show(a.TargetGroups, 'TargetGroups'), within(a.Range)],
  TimerStart: (a) => ['start timer ', code(a.Name), ' at ', show(a.StartValueRange), ' s', a.Repeating ? ', repeating' : ''],
  SpawnInteraction: (a) => ['run interaction ', show(a.Interaction, 'Interaction')],
  PlaySound: (a) => ['play sound ', show(a.SoundEventId, 'SoundEventId')],
  ApplyEntityEffect: (a) => ['apply effect ', show(a.EntityEffect, 'EntityEffect'), a.UseTarget ? ' to its target' : ' to itself'],
  SpawnParticles: (a) => ['spawn particles ', show(a.ParticleSystem, 'ParticleSystem')],
  Attack: (a) => ['attack with ', show(a.Attack, 'Attack')],
  SetFlag: (a) => [a.SetTo === false ? 'clear flag ' : 'set flag ', code(a.Name)],
  DisplayName: (a) => ['show name ', code(a.DisplayName)],
  Despawn: () => ['despawn'],
  Nothing: () => ['do nothing'],
};

function actionText(action) {
  if (!action) return '';
  if (action.Reference) return ['component ', show(action.Reference, 'Reference'), params(action.Modify ?? {})];
  return (ACTIONS[action.Type] ?? ((a) => generic(a)))(action);
}

// Random and Sequence hold more actions; they become sub-lists.
function actionItem(action) {
  const item = element('li');
  if (action.Type === 'Random' || action.Type === 'Sequence') {
    item.append(action.Type === 'Random' ? 'one at random of:' : 'in sequence:');
    const list = element('ul');
    for (const entry of listOf(action.Actions)) list.append(actionItem(entry.Action ?? entry));
    item.append(list);
  } else {
    item.append(phrase(actionText(action)));
  }
  return item;
}

function motionText(label, motion) {
  return phrase(`${label}: `, code(motion.Type ?? '?'), params(motion));
}

function ruleList(instructions) {
  const list = element('ol', undefined, 'rules');
  for (const rule of instructions) {
    const item = element('li');
    if (rule.$Comment) item.append(element('div', rule.$Comment, 'comment'));
    if (rule.Enabled === false) item.append(element('div', 'Disabled', 'muted'));
    if (rule.Reference) {
      item.append(phrase('Uses rules from ', show(rule.Reference, 'Reference'), params(rule.Modify ?? {})));
    } else {
      item.append(phrase(element('strong', 'When ', 'when'), sensorText(rule.Sensor)));
      const actions = element('ul');
      for (const action of listOf(rule.Actions)) actions.append(actionItem(action));
      for (const [label, key] of [['Head', 'HeadMotion'], ['Body', 'BodyMotion']]) {
        if (rule[key]) actions.append(wrap('li', motionText(label, rule[key])));
      }
      if (actions.childElementCount) item.append(actions);
    }
    if (listOf(rule.Instructions).length) item.append(ruleList(listOf(rule.Instructions)));
    if (rule.Continue) item.append(element('div', 'then keeps checking the next rules', 'muted'));
    list.append(item);
  }
  return list;
}

function statesOf(role) {
  const states = new Set(role.StartState ? [role.StartState] : []);
  JSON.stringify(role, (key, value) => {
    if (value && value.Type === 'State' && typeof value.State === 'string') states.add(value.State);
    return value;
  });
  return [...states];
}

// `context` ({load, assetPath}) lets a Variant's flow draw its template's rules.
function roleCard(role, context) {
  const card = element('section', undefined, 'card');
  card.append(element('h3', 'Behaviour'));
  if (role.Type === 'Variant') {
    card.append(wrap('p', 'Variant of ', show(role.Reference, 'Reference'), '. It sets:'));
    const changes = element('ul');
    for (const [key, value] of Object.entries(role.Modify ?? {})) {
      changes.append(wrap('li', `${key}: `, show(value, key)));
    }
    card.append(changes);
  }
  const states = statesOf(role);
  if (states.length) card.append(wrap('p', 'States: ', states.map((s, i) => [i ? ', ' : '', code(s, 'state')])));
  const describe = { sensor: (sensor) => text(sensorText(sensor)), action: (action) => text(actionText(action)) };
  const flow = async () => {
    const source = await ruleSource(role, context);
    return source && roleFlow(source, describe);
  };
  if (listOf(role.Instructions).length) {
    card.append(
      views(flow, [
        element('p', 'Rules run from the top. The first rule whose condition holds runs and stops the list, unless it keeps checking.', 'muted'),
        ruleList(listOf(role.Instructions)),
      ]),
    );
  } else if (role.Reference && context) {
    card.append(
      wrap('p', 'Its rules come from the template ', show(role.Reference, 'Reference'), '. The flow fills in the values this variant sets.'),
      views(flow, [wrap('p', 'Open the template ', show(role.Reference, 'Reference'), ' for its rules as a list.')]),
    );
  }
  return card;
}

// ---------------------------------------------------------------- interactions

function stepText(node) {
  if (node.Type === 'Simple' && node.RunTime !== undefined) return ['wait ', show(node.RunTime), ' s'];
  return generic(node);
}

const branchLabel = (key) => (key === 'Failed' ? 'If it fails:' : key === 'Interactions' ? 'Runs:' : `${key}:`);

function addSteps(node, list) {
  for (let step = node; isInteraction(step); step = Array.isArray(step.Next) ? null : step.Next) {
    const item = element('li');
    item.append(phrase(stepText(step)));
    for (const [key, value] of Object.entries(step)) {
      if (key === 'Next' && !Array.isArray(value)) continue;
      const branches = [value].flat().filter(isInteraction);
      if (NOT_A_BRANCH.has(key) || branches.length === 0) continue;
      const sub = element('ol');
      for (const branch of branches) addSteps(branch, sub);
      item.append(element('div', branchLabel(key), 'muted'), sub);
    }
    list.append(item);
  }
}

function interactionCard(asset) {
  const roots = isInteraction(asset) ? [asset] : listOf(asset.Interactions).filter(isInteraction);
  if (roots.length === 0) return null;
  const card = element('section', undefined, 'card');
  card.append(element('h3', 'Steps'));
  const list = element('ol', undefined, 'rules');
  for (const root of roots) addSteps(root, list);
  card.append(list);
  return card;
}

// ---------------------------------------------------------------- trigger volumes

const CONDITIONS = {
  TagCondition: (c) =>
    c.Source === 'Event'
      ? ['signal ', code(c.TagKey, 'signal'), ' arrives']
      : ['tag ', code(c.TagKey), ` ${String(c.Comparison ?? 'is').toLowerCase()} `, show(c.TagValue ?? '')],
  TimeOfDay: (c) => ['the time is between ', String(c.MinHour ?? 0), ':00 and ', String(c.MaxHour ?? 24), ':00'],
};

const tagged = (effect) => (effect.MatchKey ? [' tagged ', code(effect.MatchKey)] : '');

const EFFECTS = {
  SendSignal: (e) => ['send signal ', show(e.SignalKeys), ' to volumes', tagged(e), within(e.Radius)],
  EnableVolume: (e) => ['enable volumes', tagged(e), within(e.Radius)],
  DisableVolume: (e) => ['disable volumes', tagged(e), within(e.Radius)],
  SpawnNpc: (e) => ['spawn ', String(e.Count ?? 1), ' × NPC ', show(e.NpcType, 'NpcType')],
  ModifyTags: (e) => [`${String(e.Operation ?? 'set').toLowerCase()} tag `, code(e.TagKey), e.TagValue ? [' = ', show(e.TagValue)] : ''],
  PlayVfx: (e) => ['play particles ', show(e.ParticleSystem, 'ParticleSystem')],
  PlaySound: (e) => ['play sound ', show(e.SoundEvent, 'SoundEvent')],
  PlaceBlock: (e) => ['place block ', show(e.BlockType, 'BlockType'), e.BlockState ? [' (', e.BlockState, ')'] : ''],
};

const EFFECT_SKIP = new Set(['Event', 'Entry', 'Delay', 'Interval']);
const describeCondition = (condition) => (CONDITIONS[condition.Type] ?? ((c) => generic(c, EFFECT_SKIP)))(condition);
const describeEffect = (effect) => (EFFECTS[effect.Type] ?? ((e) => generic(e, EFFECT_SKIP)))(effect);

// `context` lets the flow look around the instance (see flow.js volumeFlow); without it there is no flow.
function volumeCard(volume, context) {
  const card = element('section', undefined, 'card');
  card.append(element('h3', 'Rules'));
  const facts = [`Shape: ${volume.Shape?.Type ?? '?'}`, `Affects: ${(volume.TargetTypes ?? []).join(', ') || 'nothing'}`];
  if (volume.Tags) facts.push(`Tags: ${Object.keys(volume.Tags).join(', ')}`);
  if (volume.Enabled === false) facts.push('Starts disabled');
  card.append(chips(facts));
  const rules = new Map();
  const ruleFor = (entry) => {
    const key = `${entry.Event}#${entry.Entry ?? 0}`;
    if (!rules.has(key)) rules.set(key, { event: entry.Event, entry: entry.Entry ?? 0, conditions: [], effects: [] });
    return rules.get(key);
  };
  for (const condition of volume.Conditions ?? []) ruleFor(condition).conditions.push(condition);
  for (const effect of volume.Effects ?? []) ruleFor(effect).effects.push(effect);
  const parts = [];
  for (const rule of rules.values()) {
    parts.push(element('h4', `On ${rule.event}${rule.entry ? `, rule ${rule.entry + 1}` : ''}`, `event event-${rule.event}`));
    if (rule.conditions.length) {
      parts.push(wrap('p', 'If ', rule.conditions.map((c, i) => [i ? ' and ' : '', describeCondition(c)])));
    }
    const list = element('ul');
    for (const effect of [...rule.effects].sort((a, b) => (a.Delay ?? 0) - (b.Delay ?? 0))) {
      const when = [effect.Delay ? `after ${effect.Delay} s: ` : '', effect.Interval ? `every ${effect.Interval} s: ` : ''];
      list.append(wrap('li', when, describeEffect(effect)));
    }
    parts.push(list);
  }
  const flowContext = context && {
    ...context,
    describeCondition: (condition) => text(describeCondition(condition)),
    describeEffect: (effect) => text(describeEffect(effect)),
  };
  card.append(views(() => flowContext && volumeFlow(volume, flowContext), parts));
  return card;
}

/**
 * The card for an asset in the Assets tab, or null when there is nothing more readable than its JSON.
 * `context` is what the flows need: {load, assetPath, refsFor}, plus {instancePath, volumes} for a trigger volume.
 */
export function behaviourCard(path, asset, context) {
  if (path.includes('#')) return volumeCard(asset, context);
  if (path.startsWith('Server/NPC/Roles/')) return roleCard(asset, context);
  if (path.startsWith('Server/Item/Interactions/') || path.startsWith('Server/Item/RootInteractions/')) return interactionCard(asset);
  return null;
}
