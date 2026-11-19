// Assets tab: every server and cosmetic JSON asset (roles, model assets, items, interactions, effects, trigger
// volumes and the rest), shown as JSON whose names link to what they point at.

import { element } from './dom.js';
import { jsonBlock } from './links.js';

// Top-level fields worth a line above the JSON when present.
const SUMMARY_KEYS = ['Type', 'Parent', 'Reference', 'Appearance', 'Model', 'MaxHealth', 'StartState'];

// Groups by the first two folders under Server/; a trigger volume is "<instance> volumes" / volume name.
function describe(path) {
  const [file, volume] = path.split('#');
  const parts = file.replace(/^Server\//, '').replace(/\.json$/, '').split('/');
  const depth = Math.min(2, parts.length - 1);
  const group = parts.slice(0, depth).join('/');
  if (volume !== undefined) return { group: `${group} volumes`, id: volume };
  return { group, id: parts.slice(depth).join('/') };
}

export function createAssetsTab(data, details) {
  const items = data.assets.map((path) => ({ path, ...describe(path) }));
  const cache = new Map();
  let request = 0;

  function load(file) {
    if (!cache.has(file)) {
      const loading = fetch('data/json/' + file).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
      loading.catch(() => cache.delete(file));
      cache.set(file, loading);
    }
    return cache.get(file);
  }

  async function select(item) {
    const ticket = ++request;
    const [file, volume] = item.path.split('#');
    details.replaceChildren(element('h2', item.id), element('p', item.path, 'path'));
    let asset;
    try {
      asset = await load(file);
    } catch (error) {
      if (ticket === request) details.append(element('p', `Could not load ${file} (${error.message}). Re-run build_site.py.`, 'error'));
      return;
    }
    if (ticket !== request) return;
    if (volume !== undefined) asset = Object.values(asset.Volumes ?? {}).find((v) => v.Name === volume) ?? {};
    const facts = SUMMARY_KEYS.filter((key) => ['string', 'number'].includes(typeof asset[key])).map(
      (key) => `${key}: ${asset[key]}`,
    );
    if (facts.length) details.append(element('p', facts.join('  |  '), 'facts'));
    details.append(jsonBlock(asset));
  }

  return {
    name: 'assets',
    noun: 'assets',
    showsViewer: false,
    items,
    group: (item) => item.group,
    select,
    leave: () => request++,
  };
}
