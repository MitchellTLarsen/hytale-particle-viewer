// Instance map: an instance's trigger volumes (boxes, cylinders, spheres) and points, seen from the top
// (x across, z down) or the side (x across, y up). Drag to pan, scroll to zoom, click a volume to open it.

import { element } from './dom.js';

const SVG = 'http://www.w3.org/2000/svg';
const MARGIN = 0.06;
const POINT_SIZE = 1.2;

function svgElement(tag, attributes = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

const vector = (v) => [v?.X ?? 0, v?.Y ?? 0, v?.Z ?? 0];
const hexColor = (value) => (typeof value === 'number' ? `#${value.toString(16).padStart(6, '0')}` : null);

function hashColor(text) {
  let hash = 0;
  for (const character of String(text)) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360}, 60%, 62%)`;
}

// A volume's outline in world blocks: {kind: 'rect' | 'circle', ...} for the chosen view.
// Cylinders are read as centred on their Center vertically, which the data does not say.
function outline(volume, side) {
  const [px, py, pz] = vector(volume.Position);
  const shape = volume.Shape ?? {};
  const across = (v) => v[0];
  const deep = (v) => (side ? -v[1] : v[2]);
  if (shape.Type === 'Box') {
    const min = vector(shape.Min).map((v, i) => v + [px, py, pz][i]);
    const max = vector(shape.Max).map((v, i) => v + [px, py, pz][i]);
    const [x1, x2] = [across(min), across(max)].sort((a, b) => a - b);
    const [y1, y2] = [deep(min), deep(max)].sort((a, b) => a - b);
    return { kind: 'rect', x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }
  const center = vector(shape.Center).map((v, i) => v + [px, py, pz][i]);
  const radius = shape.Radius ?? 0.5;
  if (shape.Type === 'Cylinder' && side) {
    const height = shape.Height ?? 1;
    return { kind: 'rect', x: center[0] - radius, y: -center[1] - height / 2, width: radius * 2, height };
  }
  return { kind: 'circle', x: across(center), y: deep(center), radius };
}

const bounds = (o) =>
  o.kind === 'rect' ? [o.x, o.y, o.x + o.width, o.y + o.height] : [o.x - o.radius, o.y - o.radius, o.x + o.radius, o.y + o.radius];

/**
 * `instance` is a TriggerVolumeData file ({Volumes, Groups}), `points` a PointData file ({Points}) or null,
 * `focus` a volume name to highlight, `hrefFor(name)` the link of a volume.
 */
export function instanceMap({ instance, points, focus, hrefFor }) {
  const volumes = Object.values(instance?.Volumes ?? {});
  const groups = instance?.Groups ?? {};
  const pointList = Object.values(points?.Points ?? {});
  const colorOf = (volume) => hexColor(volume.Color) ?? hexColor(groups[volume.GroupId]?.Color) ?? hashColor(volume.GroupId ?? volume.Name);

  const wrapper = element('div', undefined, 'map');
  const toolbar = element('div', undefined, 'map-toolbar');
  const svg = svgElement('svg', { class: 'map-view' });
  const legend = element('div', undefined, 'map-legend');
  let side = false;
  let showPoints = true;
  let view = null;

  const toggle = (label, checked, onChange) => {
    const box = element('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.addEventListener('change', () => onChange(box.checked));
    const wrap = element('label');
    wrap.append(box, label);
    return wrap;
  };
  const viewButton = (label, value) => {
    const control = element('button', label);
    control.addEventListener('click', () => {
      side = value;
      draw(true);
    });
    return control;
  };
  const topButton = viewButton('Top', false);
  const sideButton = viewButton('Side', true);
  toolbar.append(topButton, sideButton, toggle('Points', true, (on) => ((showPoints = on), draw(false))), element('span', 'Drag to pan, scroll to zoom, click a volume to open it.', 'muted'));

  function draw(refit) {
    topButton.classList.toggle('active', !side);
    sideButton.classList.toggle('active', side);
    svg.replaceChildren();
    const shapes = volumes.map((volume) => ({ volume, outline: outline(volume, side) }));
    const marks = showPoints ? pointList.map((point) => ({ point, at: vector(point.Position) })) : [];
    if (refit || !view) {
      const boxes = [...shapes.map((s) => bounds(s.outline)), ...marks.map((m) => [m.at[0], side ? -m.at[1] : m.at[2], m.at[0], side ? -m.at[1] : m.at[2]])];
      const [x1, y1, x2, y2] = boxes.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])], [Infinity, Infinity, -Infinity, -Infinity]);
      const pad = Math.max(x2 - x1, y2 - y1, 10) * MARGIN;
      view = boxes.length ? { x: x1 - pad, y: y1 - pad, width: x2 - x1 + pad * 2, height: y2 - y1 + pad * 2 } : { x: -10, y: -10, width: 20, height: 20 };
    }
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
    const stroke = view.width / 600;
    for (const { volume, outline: o } of [...shapes].sort((a, b) => (a.volume.Name === focus) - (b.volume.Name === focus))) {
      const color = colorOf(volume);
      const focused = volume.Name === focus;
      const attributes = { fill: color, 'fill-opacity': focused ? 0.45 : 0.18, stroke: color, 'stroke-width': stroke * (focused ? 3 : 1), class: `map-volume${focused ? ' focus' : ''}` };
      const shape = o.kind === 'rect' ? svgElement('rect', { ...attributes, x: o.x, y: o.y, width: Math.max(o.width, stroke), height: Math.max(o.height, stroke) }) : svgElement('circle', { ...attributes, cx: o.x, cy: o.y, r: o.radius });
      const title = svgElement('title');
      title.textContent = `${volume.Name}  ·  ${groups[volume.GroupId]?.Name ?? 'no group'}  ·  y ${vector(volume.Position)[1]}`;
      shape.append(title);
      shape.addEventListener('click', () => (location.hash = hrefFor(volume.Name)));
      svg.append(shape);
    }
    for (const { point, at } of marks) {
      const size = POINT_SIZE * stroke * 4;
      const x = at[0];
      const y = side ? -at[1] : at[2];
      const mark = svgElement('rect', { x: x - size / 2, y: y - size / 2, width: size, height: size, transform: `rotate(45 ${x} ${y})`, class: 'map-point', 'stroke-width': stroke });
      const title = svgElement('title');
      title.textContent = `${point.Name ?? 'point'}  ·  ${Object.keys(point.Tags ?? {}).join(', ')}  ·  y ${at[1]}`;
      mark.append(title);
      svg.append(mark);
    }
    const focused = shapes.find((s) => s.volume.Name === focus);
    if (focused) {
      const [x1, y1, x2, y2] = bounds(focused.outline);
      // A ring makes even a tiny volume easy to find.
      const ring = Math.max((x2 - x1) / 2, (y2 - y1) / 2) + stroke * 14;
      svg.append(svgElement('circle', { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, r: ring, class: 'map-ring', 'stroke-width': stroke * 2 }));
      const label = svgElement('text', { x: x1, y: y1 - stroke * 6, class: 'map-label', 'font-size': stroke * 14 });
      label.textContent = focus;
      svg.append(label);
    }
  }

  // Scroll zooms around the pointer; dragging pans.
  svg.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = svg.getBoundingClientRect();
    const fx = (event.clientX - rect.left) / rect.width;
    const fy = (event.clientY - rect.top) / rect.height;
    const factor = Math.exp(event.deltaY * 0.0015);
    const width = view.width * factor;
    const height = view.height * factor;
    view = { x: view.x + (view.width - width) * fx, y: view.y + (view.height - height) * fy, width, height };
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
  }, { passive: false });
  let drag = null;
  let dragged = false;
  svg.addEventListener('pointerdown', (event) => {
    drag = { x: event.clientX, y: event.clientY, view: { ...view }, moved: false };
  });
  svg.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const rect = svg.getBoundingClientRect();
    const dx = ((event.clientX - drag.x) / rect.width) * drag.view.width;
    const dy = ((event.clientY - drag.y) / rect.height) * drag.view.height;
    if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 3) drag.moved = true;
    view = { ...drag.view, x: drag.view.x - dx, y: drag.view.y - dy };
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
  });
  svg.addEventListener('pointerup', () => {
    dragged = Boolean(drag?.moved);
    drag = null;
  });
  // A drag that ends over a volume should not open it (the click comes after pointerup).
  svg.addEventListener('click', (event) => {
    if (dragged) event.stopPropagation();
    dragged = false;
  }, true);

  const counts = new Map();
  for (const volume of volumes) {
    const name = groups[volume.GroupId]?.Name ?? 'no group';
    counts.set(name, { count: (counts.get(name)?.count ?? 0) + 1, color: colorOf(volume) });
  }
  for (const [name, { count, color }] of [...counts].sort((a, b) => b[1].count - a[1].count)) {
    const entry = element('span', `${name} (${count})`);
    entry.style.setProperty('--swatch', color);
    legend.append(entry);
  }
  if (pointList.length) legend.append(element('span', `points (${pointList.length})`, 'points'));

  wrapper.append(toolbar, svg, legend);
  requestAnimationFrame(() => draw(true));
  return wrapper;
}
