// The Used by panel: which server and cosmetic assets use the selected item, from data/references.json.
// Each entry opens that asset in the Assets tab.

import { element } from './dom.js';

const CATEGORIES = [
  ['Server/NPC/Roles/', 'NPC roles'],
  ['Server/Models/', 'Model assets'],
  ['Server/Item/Items/', 'Items and blocks'],
  ['Server/Item/Interactions/', 'Interactions'],
  ['Server/Item/RootInteractions/', 'Interactions'],
  ['Server/Entity/Effects/', 'Entity effects'],
  ['Server/Instances/', 'Trigger volumes'],
  ['Server/Camera/', 'Camera'],
  ['Server/Projectiles/', 'Projectiles'],
  ['Server/ProjectileConfigs/', 'Projectiles'],
  ['Server/Weathers/', 'Weather'],
  ['Server/Environments/', 'Environments'],
  ['Server/Audio/', 'Audio'],
  ['Cosmetics/', 'Cosmetics'],
  ['Server/NPC/', 'NPC data'],
];
const OTHER = 'Other';
const OPEN_LIMIT = 12;

const categoryOf = (source) => CATEGORIES.find(([prefix]) => source.startsWith(prefix))?.[1] ?? OTHER;

// The heading already names the category, so the detail keeps only the folders below it, the key and the hop.
function describe({ source, field, via }) {
  const [path, volume] = source.split('#');
  const name = volume ?? path.split('/').pop().replace(/\.json$/, '');
  const prefix = CATEGORIES.find(([folder]) => path.startsWith(folder))?.[0] ?? '';
  const where = volume !== undefined ? `${path.split('/')[2]} instance` : path.slice(prefix.length).split('/').slice(0, -1).join('/');
  return { name, detail: [where, field, via && `via ${via}`].filter(Boolean).join('  ·  ') };
}

export function createRelatedPanel(index, panel) {
  const refsFor = (key, via) =>
    (index.refs[key] ?? []).map(([source, field]) => ({ source: index.sources[source], field, via }));

  // A model is used by model assets; NPC roles then use those assets by id as their Appearance.
  function modelRefs(item) {
    const refs = refsFor(`model:${item.path}.blockymodel`);
    const roles = refs
      .filter((ref) => ref.source.startsWith('Server/Models/'))
      .flatMap((ref) => {
        const asset = ref.source.split('/').pop().replace(/\.json$/, '');
        return refsFor(`modelAsset:${asset}`, asset);
      });
    return [...roles, ...refs];
  }

  function refsForItem(tab, item) {
    if (tab === 'particles') return refsFor(`particle:${item.id}`);
    if (tab === 'sounds') return refsFor(`sound:${item.id}`);
    if (tab === 'screen') return refsFor(item.texture ? `texture:${item.texture}` : `camera:${item.id}`);
    if (tab === 'models') return modelRefs(item);
    if (tab === 'assets') return assetRefs(item);
    return [];
  }

  // An asset is named by its file name; model assets, sound events and camera assets also have their own kinds.
  function assetRefs(item) {
    if (item.path.includes('#')) return [];
    const id = item.path.split('/').pop().replace(/\.json$/, '');
    const keys = [`asset:${id}`];
    if (item.path.startsWith('Server/Models/')) keys.push(`modelAsset:${id}`);
    if (item.path.startsWith('Server/Audio/SoundEvents/')) keys.push(`sound:${id}`);
    if (item.path.startsWith('Server/Camera/')) keys.push(`camera:${id}`);
    const bySource = new Map();
    for (const ref of keys.flatMap((key) => refsFor(key))) {
      if (ref.source !== item.path && !bySource.has(ref.source)) bySource.set(ref.source, ref);
    }
    return [...bySource.values()];
  }

  function show(tab, item) {
    const refs = refsForItem(tab, item);
    panel.hidden = refs.length === 0;
    if (refs.length === 0) return;
    const groups = new Map([...CATEGORIES.map(([, title]) => [title, []]), [OTHER, []]]);
    for (const ref of refs) groups.get(categoryOf(ref.source)).push(ref);
    panel.replaceChildren(element('h2', 'Used by'));
    for (const [title, group] of groups) {
      if (group.length === 0) continue;
      const section = element('details');
      section.open = group.length <= OPEN_LIMIT;
      section.append(element('summary', `${title} (${group.length})`));
      const list = element('ul');
      for (const ref of group) {
        const { name, detail } = describe(ref);
        const link = element('a');
        link.href = `#assets:${encodeURIComponent(ref.source)}`;
        link.title = ref.source;
        link.append(element('strong', name), element('small', detail));
        const entry = element('li');
        entry.append(link);
        list.append(entry);
      }
      section.append(list);
      panel.append(section);
    }
  }

  return { show };
}
