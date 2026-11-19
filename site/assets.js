// Assets tab: every server and cosmetic JSON asset (roles, model assets, items, interactions, effects, trigger
// volumes and the rest), shown as JSON whose names link to what they point at. Roles, model assets and items
// with a model also show that model in the view.

import { behaviourCard } from './behaviour.js';
import { chips, element } from './dom.js';
import { jsonBlock, valueNode } from './links.js';

// Top-level fields worth a chip above the JSON when present.
const SUMMARY_KEYS = ['Type', 'Parent', 'Reference', 'Appearance', 'Model', 'MaxHealth', 'StartState'];

const stem = (path) => path.split('/').pop().replace(/\.json$/, '');

function iconImage(icon) {
  const image = element('img', undefined, 'icon');
  image.src = 'assets/' + icon;
  image.alt = '';
  return image;
}

// Groups by the first two folders under Server/; a trigger volume is "<instance> volumes" / volume name.
function describe(path) {
  const [file, volume] = path.split('#');
  const parts = file.replace(/^Server\//, '').replace(/\.json$/, '').split('/');
  const depth = Math.min(2, parts.length - 1);
  const group = parts.slice(0, depth).join('/');
  if (volume !== undefined) return { group: `${group} volumes`, id: volume };
  return { group, id: parts.slice(depth).join('/') };
}

/**
 * `models` is the Models tab (for its preview); `setViewer(visible)` shows or hides the view; `references`
 * is data/references.json (for trigger volume flows).
 */
export function createAssetsTab(data, details, models, setViewer, references) {
  // Volumes come in file order; sorting puts them, like the files, in name order.
  const icons = data.icons ?? {};
  const items = data.assets
    .map((path) => ({ path, ...describe(path), icon: icons[path] }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const modelAssets = new Map(
    items.filter((item) => item.path.startsWith('Server/Models/')).map((item) => [stem(item.path), item.path]),
  );
  const pathsByName = new Map();
  for (const item of items) {
    if (item.path.includes('#')) continue;
    if (!pathsByName.has(stem(item.path))) pathsByName.set(stem(item.path), []);
    pathsByName.get(stem(item.path)).push(item.path);
  }
  const assetPath = (name, folder) => (pathsByName.get(name) ?? []).find((path) => path.startsWith(folder)) ?? null;
  const refsFor = (key) =>
    (references.refs[key] ?? []).map(([source, field]) => ({ source: references.sources[source], field }));
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

  // A model asset's Model, and the Texture set on it or on a child of the asset that sets the Model.
  async function modelAssetModel(asset) {
    let texture;
    for (let current = asset, depth = 0; current && depth < 10; depth++) {
      texture ??= typeof current.Texture === 'string' ? current.Texture : undefined;
      if (typeof current.Model === 'string') return { model: current.Model, texture };
      const parent = modelAssets.get(current.Parent);
      current = parent ? await load(parent) : null;
    }
    return null;
  }

  // The model an asset shows: a model asset's own, the model asset a role names as its Appearance, or an
  // item's Model and Texture (for blocks, CustomModel and CustomModelTexture).
  async function modelOf(path, asset) {
    if (path.startsWith('Server/Models/')) return modelAssetModel(asset);
    if (path.startsWith('Server/NPC/Roles/')) {
      const appearance = asset.Appearance ?? asset.Modify?.Appearance;
      const file = typeof appearance === 'string' ? modelAssets.get(appearance) : undefined;
      return file ? modelAssetModel(await load(file)) : null;
    }
    if (path.startsWith('Server/Item/Items/')) {
      const block = asset.BlockType ?? {};
      const model = asset.Model ?? block.CustomModel;
      const texture = asset.Texture ?? block.CustomModelTexture?.[0]?.Texture;
      return typeof model === 'string' ? { model, texture: typeof texture === 'string' ? texture : undefined } : null;
    }
    return null;
  }

  function leave() {
    request++;
    models.clearPreview();
  }

  async function select(item) {
    leave();
    setViewer(false);
    const ticket = request;
    const [file, volume] = item.path.split('#');
    const title = element('h2', item.id);
    if (item.icon) title.prepend(iconImage(item.icon));
    details.replaceChildren(title, element('p', item.path, 'path'));
    let asset;
    try {
      asset = await load(file);
    } catch (error) {
      if (ticket === request) details.append(element('p', `Could not load ${file} (${error.message}). Re-run build_site.py.`, 'error'));
      return;
    }
    if (ticket !== request) return;
    const context = { load, assetPath, refsFor };
    if (volume !== undefined) {
      context.instancePath = file;
      context.volumes = Object.values(asset.Volumes ?? {});
      asset = context.volumes.find((v) => v.Name === volume) ?? {};
    }

    const facts = SUMMARY_KEYS.filter((key) => ['string', 'number'].includes(typeof asset[key])).map(
      (key) => `${key}: ${asset[key]}`,
    );
    const shownModel = element('p', undefined, 'muted');
    const card = behaviourCard(item.path, asset, context);
    const json = element('details');
    json.open = !card;
    json.append(element('summary', 'JSON'), jsonBlock(asset));
    details.append(...[facts.length && chips(facts), shownModel, card, json].filter(Boolean));

    const found = await modelOf(item.path, asset).catch(() => null);
    if (ticket !== request || !found) return;
    setViewer(true);
    const shown = await models.preview(found.model.replace(/\.blockymodel$/, ''), found.texture);
    if (ticket !== request) return;
    if (!shown || shown.error) {
      setViewer(false);
      return;
    }
    shownModel.append('In the view: ', valueNode(found.model, 'Model'));
  }

  return {
    name: 'assets',
    noun: 'assets',
    showsViewer: false,
    items,
    group: (item) => item.group,
    select,
    leave,
  };
}
