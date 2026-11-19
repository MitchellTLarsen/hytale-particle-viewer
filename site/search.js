// Search everywhere: names in every tab, and text inside every server and cosmetic file (data/search.json,
// loaded the first time a search runs).

import { element } from './dom.js';

const MIN_LENGTH = 2;
const NAMES_PER_TAB = 6;
const MAX_MENTIONS = 40;
const DELAY = 150;
const TAB_LABELS = { particles: 'Particles', sounds: 'Sounds', screen: 'Screen', models: 'Models', assets: 'Assets', prefabs: 'Prefabs' };

const hashFor = (tab, path) => `#${tab}:${encodeURIComponent(path)}`;
const nameOf = (source) => {
  const [path, volume] = source.split('#');
  return volume ?? path.split('/').pop().replace(/\.json$/, '');
};

function result(href, title, detail, tab) {
  const link = element('a');
  link.href = href;
  link.dataset.tab = tab;
  link.append(element('strong', title), element('small', detail));
  return link;
}

/** Wires the search box: `tabs` are the viewer's tabs ({name, items}), searched by item id and path. */
export function createSearch(input, panel, tabs) {
  let index = null;
  let timer = null;

  const loadIndex = () =>
    (index ??= fetch('data/search.json')
      .then((response) => (response.ok ? response.json() : { entries: [] }))
      .then(({ entries }) => entries.map(([source, text]) => ({ source, text, lower: text.toLowerCase() }))));

  function close() {
    panel.hidden = true;
  }

  async function run() {
    const query = input.value.trim().toLowerCase();
    if (query.length < MIN_LENGTH) return close();
    const sections = [];
    for (const tab of tabs) {
      const matches = tab.items.filter((item) => item.path.toLowerCase().includes(query));
      if (matches.length === 0) continue;
      const list = matches.slice(0, NAMES_PER_TAB).map((item) => result(hashFor(tab.name, item.path), item.id.split('/').pop(), item.path, tab.name));
      sections.push([`${TAB_LABELS[tab.name] ?? tab.name} (${matches.length})`, list, tab.name]);
    }
    const entries = await loadIndex();
    if (input.value.trim().toLowerCase() !== query) return;
    const mentions = [];
    for (const entry of entries) {
      const at = entry.lower.indexOf(query);
      if (at < 0) continue;
      const start = entry.text.lastIndexOf('\n', at) + 1;
      const end = entry.text.indexOf('\n', at);
      const line = entry.text.slice(start, end < 0 ? undefined : end);
      mentions.push(result(hashFor('assets', entry.source), nameOf(entry.source), `“${line}”  ·  ${entry.source.replace(/^Server\//, '')}`, 'assets'));
      if (mentions.length === MAX_MENTIONS) break;
    }
    if (mentions.length) sections.push([`Mentioned in${mentions.length === MAX_MENTIONS ? ` (first ${MAX_MENTIONS})` : ` (${mentions.length})`}`, mentions, 'assets']);

    panel.replaceChildren();
    if (sections.length === 0) panel.append(element('p', 'Nothing found.', 'muted'));
    for (const [title, list, tab] of sections) {
      const heading = element('h3', title);
      heading.dataset.tab = tab;
      panel.append(heading, ...list);
    }
    panel.hidden = false;
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, DELAY);
  });
  input.addEventListener('focus', () => {
    loadIndex();
    if (input.value.trim().length >= MIN_LENGTH) run();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
      input.blur();
    } else if (event.key === 'Enter') {
      panel.querySelector('a')?.click();
    }
  });
  panel.addEventListener('click', (event) => {
    if (event.target.closest('a')) close();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!panel.contains(event.target) && event.target !== input) close();
  });
}
