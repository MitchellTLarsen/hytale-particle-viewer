// World-building cards for the Assets tab: weather colours through the day.

import { chips, element } from './dom.js';

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
