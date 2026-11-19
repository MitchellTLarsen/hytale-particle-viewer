// World-building cards for the Assets tab: weather through the day, drop lists, spawn rules, and where items
// drop and NPCs spawn.

import { chips, element } from './dom.js';
import { fillParameters } from './flow.js';

const HOURS = 24;

// "#rgb", "#rrggbb", "#rrggbbaa" or "rgba(#rrggbb, a)" as [r, g, b, a] with a from 0 to 1.
function parseColor(text) {
  const match = /^rgba?\(\s*(#[0-9a-f]+)\s*,\s*([\d.]+)\s*\)$/i.exec(text.trim());
  const hex = (match ? match[1] : text.trim()).replace('#', '');
  const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
  const channels = [0, 2, 4, 6].map((i) => parseInt(full.slice(i, i + 2), 16));
  const alpha = match ? parseFloat(match[2]) : full.length >= 8 ? channels[3] / 255 : 1;
  return [channels[0] || 0, channels[1] || 0, channels[2] || 0, alpha];
}

const css = ([r, g, b, a]) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a.toFixed(3)})`;
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const hourLabel = (hour) => `${String(Math.floor(hour)).padStart(2, '0')}:00`;

// "SkyTopColors" → "Sky top".
function humanize(key) {
  const words = key.replace(/Colors?$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').split(' ');
  return words.map((word, i) => (i ? word.toLowerCase() : word)).join(' ');
}

const isColorCurve = (value) => Array.isArray(value) && value.length > 0 && value.every((k) => typeof k?.Hour === 'number' && typeof k.Color === 'string');
const isValueCurve = (value) => Array.isArray(value) && value.length > 0 && value.every((k) => typeof k?.Hour === 'number' && typeof k.Value === 'number');

// A 24-hour gradient; colours blend between keyframes and wrap round midnight.
function strip(label, keyframes) {
  const keys = [...keyframes].sort((a, b) => a.Hour - b.Hour).map((k) => ({ hour: k.Hour, color: parseColor(k.Color) }));
  const first = keys[0];
  const last = keys.at(-1);
  const span = first.hour + HOURS - last.hour;
  const midnight = span > 0 ? mix(last.color, first.color, (HOURS - last.hour) / span) : first.color;
  const stops = [[0, midnight], ...keys.map((k) => [k.hour, k.color]), [HOURS, midnight]];
  const bar = element('div', undefined, 'strip-bar');
  bar.style.setProperty('--gradient', `linear-gradient(to right, ${stops.map(([hour, color]) => `${css(color)} ${(hour / HOURS) * 100}%`).join(', ')})`);
  bar.title = keys.map((k) => `${hourLabel(k.hour)}  ${css(k.color)}`).join('\n');
  const row = element('div', undefined, 'strip');
  row.append(element('span', label, 'strip-label'), bar);
  return row;
}

function hourAxis() {
  const axis = element('div', undefined, 'strip');
  const ticks = element('div', undefined, 'strip-axis');
  for (const hour of [0, 6, 12, 18, 24]) ticks.append(element('span', hourLabel(hour)));
  axis.append(element('span', '', 'strip-label'), ticks);
  return axis;
}

// Only the hours where the value changes; "0.7 all day" when it never does.
function describeCurve(keyframes) {
  const sorted = [...keyframes].sort((a, b) => a.Hour - b.Hour);
  const changes = sorted.filter((k, i) => i === 0 || k.Value !== sorted[i - 1].Value);
  if (changes.length === 1) return `${changes[0].Value} all day`;
  return changes.map((k) => `${hourLabel(k.Hour)} ${k.Value}`).join(' · ');
}

/** A weather's colours as 24-hour strips, and its number curves where they change. */
export function weatherCard(weather) {
  const strips = [];
  for (const [key, value] of Object.entries(weather)) if (isColorCurve(value)) strips.push(strip(humanize(key), value));
  (Array.isArray(weather.Clouds) ? weather.Clouds : []).forEach((cloud, index) => {
    if (isColorCurve(cloud?.Colors)) strips.push(strip(`Clouds ${index + 1}`, cloud.Colors));
  });
  const curves = Object.entries(weather)
    .filter(([, value]) => isValueCurve(value))
    .map(([key, value]) => `${humanize(key)}: ${describeCurve(value)}`);
  if (strips.length === 0 && curves.length === 0) return null;
  const card = element('section', undefined, 'card');
  card.append(element('h3', 'Through the day'));
  if (strips.length) card.append(...strips, hourAxis());
  if (curves.length) card.append(chips(curves));
  return card;
}

// ---------------------------------------------------------------- loot and spawns

const percent = (value) => `${Math.round(value * 1000) / 10}%`;

function itemEntry(name, context, quantity) {
  const entry = element('span', undefined, 'item');
  const icon = context.iconOf?.(name);
  if (icon) {
    const image = element('img', undefined, 'icon');
    image.src = 'assets/' + icon;
    image.alt = '';
    entry.append(image);
  }
  entry.append(context.link(name, 'ItemId'));
  if (quantity) entry.append(element('small', quantity));
  return entry;
}

function quantityOf(item) {
  const min = item.QuantityMin ?? 1;
  const max = item.QuantityMax ?? min;
  return min === max ? `×${min}` : `×${min}–${max}`;
}

/**
 * One container as a list item. In a Multiple each child drops when its Weight beats a roll out of 100
 * (so Weight is a percent chance, 100 by default); a Choice picks one child by Weight against the total,
 * RollsMin to RollsMax times (server ItemDropContainer classes).
 */
function dropItem(container, context, chance) {
  const item = element('li');
  const prefix = chance ? element('span', `${chance}  `, 'chance') : '';
  const children = Array.isArray(container.Containers) ? container.Containers : [];
  if (container.Type === 'Single' && container.Item) {
    item.append(prefix, itemEntry(container.Item.ItemId, context, quantityOf(container.Item)));
  } else if (container.Type === 'Empty') {
    item.append(prefix, element('span', 'nothing', 'muted'));
  } else if (container.Type === 'Droplist') {
    item.append(prefix, 'drop list ', context.link(container.DroplistId, 'DroplistId'));
  } else if (container.Type === 'Multiple' || container.Type === 'Choice') {
    const choice = container.Type === 'Choice';
    const rolls = choice && (container.RollsMin ?? 1) !== (container.RollsMax ?? 1) ? ` (${container.RollsMin}–${container.RollsMax} rolls)` : choice && container.RollsMin > 1 ? ` (${container.RollsMin} rolls)` : '';
    item.append(prefix, element('strong', choice ? `one of${rolls}:` : 'each of:'));
    const total = children.reduce((sum, child) => sum + (child.Weight ?? 100), 0) || 1;
    const list = element('ul', undefined, 'drops');
    for (const child of children) {
      const weight = child.Weight ?? 100;
      list.append(dropItem(child, context, choice ? percent(weight / total) : weight >= 100 ? '' : `${Math.min(weight, 100)}%`));
    }
    item.append(list);
  } else {
    item.append(prefix, element('code', container.Type ?? '?'));
  }
  return item;
}

function dropTree(drop, context) {
  const list = element('ul', undefined, 'drops');
  if (drop?.Container) list.append(dropItem(drop.Container, context, ''));
  return list;
}

const SPAWN_SKIP = new Set(['NPCs', 'Environments', '$Comment', 'Model']);

function spawnFacts(spawn) {
  const facts = [];
  if (Array.isArray(spawn.DayTimeRange)) facts.push(`Time: ${spawn.DayTimeRange.map(hourLabel).join('–')}`);
  if (Array.isArray(spawn.LightRanges?.Light)) facts.push(`Light: ${spawn.LightRanges.Light.join('–')}`);
  for (const [key, value] of Object.entries(spawn)) {
    if (SPAWN_SKIP.has(key) || key === 'DayTimeRange' || key === 'LightRanges') continue;
    if (['string', 'number', 'boolean'].includes(typeof value)) facts.push(`${humanize(key)}: ${value}`);
    else if (Array.isArray(value) && value.every((v) => ['string', 'number'].includes(typeof v))) facts.push(`${humanize(key)}: ${value.join('–')}`);
  }
  return facts;
}

function spawnCard(spawn, context) {
  const card = element('section', undefined, 'card');
  card.append(element('h3', 'Spawns'));
  if (spawn.$Comment) card.append(element('p', spawn.$Comment, 'comment'));
  const environments = Array.isArray(spawn.Environments) ? spawn.Environments : [];
  if (environments.length) {
    const line = element('p');
    line.append('In ', ...environments.flatMap((name, i) => [i ? ', ' : '', context.link(name, 'EnvironmentId')]));
    card.append(line);
  }
  card.append(chips(spawnFacts(spawn)));
  const npcs = Array.isArray(spawn.NPCs) ? spawn.NPCs : [];
  const total = npcs.reduce((sum, npc) => sum + (npc.Weight ?? 1), 0) || 1;
  const list = element('ul', undefined, 'drops');
  for (const npc of npcs) {
    const row = element('li');
    row.append(element('span', `${percent((npc.Weight ?? 1) / total)}  `, 'chance'), context.link(npc.Id, 'NpcType'));
    list.append(row);
  }
  card.append(list);
  return card;
}

function sectionCard(title, rows) {
  const card = element('section', undefined, 'card');
  card.append(element('h3', title));
  const list = element('ul', undefined, 'drops');
  for (const row of rows) list.append(row);
  card.append(list);
  return card;
}

// Drop lists that name the item, and the NPC roles that use those drop lists.
async function droppedBy(name, context) {
  const rows = [];
  for (const { source } of context.refsFor(`asset:${name}`)) {
    if (!source.startsWith('Server/Drops/')) continue;
    const list = source.split('/').pop().replace(/\.json$/, '');
    const roles = context.refsFor(`asset:${list}`).filter((ref) => ref.source.startsWith('Server/NPC/Roles/'));
    const row = element('li');
    row.append(context.link(list, 'DropList'));
    if (roles.length) {
      row.append(element('span', '  dropped by  ', 'muted'));
      roles.forEach((ref, i) => row.append(i ? ', ' : '', context.link(ref.source.split('/').pop().replace(/\.json$/, ''), 'NpcType')));
    }
    rows.push(row);
  }
  return rows.length ? sectionCard('Dropped by', rows) : null;
}

// The spawn rules that name a role, each with where and when.
async function spawnsOf(name, context) {
  const rows = [];
  for (const { source } of context.refsFor(`asset:${name}`)) {
    if (!source.startsWith('Server/NPC/Spawn/')) continue;
    const spawn = await context.load(source).catch(() => null);
    const row = element('li');
    row.append(context.link(source.split('/').pop().replace(/\.json$/, ''), 'SpawnId'));
    const environments = Array.isArray(spawn?.Environments) ? spawn.Environments : [];
    if (environments.length) row.append(element('span', `  in ${environments.join(', ')}`, 'muted'));
    const facts = spawn ? spawnFacts(spawn).filter((fact) => /^(Time|Light)/.test(fact)) : [];
    if (facts.length) row.append(element('small', `  ${facts.join(', ')}`));
    rows.push(row);
  }
  return rows.length ? sectionCard('Where it spawns', rows) : null;
}

/**
 * Extra cards for the Assets tab: drop lists, spawn rules, where items drop, and where NPCs spawn and what
 * they drop. `context`: {load, refsFor, assetPath, iconOf, link}.
 */
export async function worldCards(path, asset, context) {
  const name = path.split('/').pop().replace(/\.json$/, '');
  if (path.startsWith('Server/Drops/')) return [sectionCard('Drops', [...dropTree(asset, context).children])];
  if (path.startsWith('Server/NPC/Spawn/')) return [spawnCard(asset, context)];
  if (path.startsWith('Server/Item/Items/')) return [await droppedBy(name, context)].filter(Boolean);
  if (path.startsWith('Server/NPC/Roles/')) {
    const cards = [await spawnsOf(name, context)];
    const filled = fillParameters(asset, {});
    const dropList = filled.DropList ?? filled.Modify?.DropList;
    const dropPath = typeof dropList === 'string' ? context.assetPath(dropList, 'Server/Drops/') : null;
    const drop = dropPath ? await context.load(dropPath).catch(() => null) : null;
    if (drop) cards.push(sectionCard(`Drops (${dropList})`, [...dropTree(drop, context).children]));
    return cards.filter(Boolean);
  }
  return [];
}
