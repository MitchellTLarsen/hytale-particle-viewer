// JSON shown with links: strings that name something the viewer can show open it.

import { element } from './dom.js';

let linkFor = () => null;

const ID_KEYS = new Set(['Parent', 'Reference', 'Appearance']);
// When several assets share a name, the field's name picks the folder: [key pattern, folder].
const PREFERRED_FOLDERS = [
  [/Npc|Role/, 'Server/NPC/Roles/'],
  [/Appearance|Model/, 'Server/Models/'],
  [/Interaction/, 'Server/Item/'],
  [/Effect/, 'Server/Entity/Effects/'],
  [/Item|Weapon|Drop/, 'Server/Item/Items/'],
  [/Group/, 'Server/NPC/Groups/'],
];

function pickAsset(hashes, key) {
  const folder = PREFERRED_FOLDERS.find(([pattern]) => pattern.test(key))?.[1];
  return (folder && hashes.find((hash) => hash.startsWith(`assets:${folder}`))) ?? hashes[0];
}

/**
 * Sets what strings link to. Each map goes from a string in the data to a "<tab>:<path>" hash, except
 * assets, which maps an asset name to every hash with that name. Viewer kinds only match under a key
 * that names them, as in build_site.py's reference index.
 */
export function configureLinks({ models, overlays, particles, sounds, screen, assets }) {
  linkFor = (value, key) => {
    if (models.has(value)) return models.get(value);
    if (overlays.has(value)) return overlays.get(value);
    if (/System|Particle/.test(key) && particles.has(value)) return particles.get(value);
    if (/Sound/.test(key) && sounds.has(value)) return sounds.get(value);
    if (/Camera|Shake|Bobbing/.test(key) && screen.has(value)) return screen.get(value);
    if (assets.has(value) && (value.includes('_') || key.endsWith('Id') || ID_KEYS.has(key))) {
      return pickAsset(assets.get(value), key);
    }
    return null;
  };
}

const hrefFor = (target) => '#' + target.replace(/:(.*)$/, (_, path) => ':' + encodeURIComponent(path));

/** A link when the string names something the viewer can show, else plain text. */
export function valueNode(value, key = '') {
  const target = linkFor(value, key);
  if (!target) return document.createTextNode(value);
  const link = element('a', value);
  link.href = hrefFor(target);
  return link;
}

/** A <pre> of pretty-printed JSON whose linkable strings are links. */
export function jsonBlock(data) {
  const pre = element('pre');
  let text = '';
  const write = (value, key, depth) => {
    const pad = '  '.repeat(depth);
    if (Array.isArray(value) || (value && typeof value === 'object')) {
      const array = Array.isArray(value);
      const entries = array ? value.map((v) => [key, v]) : Object.entries(value);
      if (entries.length === 0) {
        text += array ? '[]' : '{}';
        return;
      }
      text += array ? '[\n' : '{\n';
      entries.forEach(([childKey, child], index) => {
        text += pad + '  ' + (array ? '' : `${JSON.stringify(childKey)}: `);
        write(child, childKey, depth + 1);
        text += index < entries.length - 1 ? ',\n' : '\n';
      });
      text += pad + (array ? ']' : '}');
      return;
    }
    const target = typeof value === 'string' ? linkFor(value, key) : null;
    if (!target) {
      text += JSON.stringify(value);
      return;
    }
    const link = element('a', JSON.stringify(value));
    link.href = hrefFor(target);
    pre.append(text, link);
    text = '';
  };
  write(data, '', 0);
  pre.append(text);
  return pre;
}

/** A collapsed "Raw JSON" section; entries are [title, data] pairs. */
export function rawJson(entries) {
  const json = element('details');
  json.append(element('summary', 'Raw JSON'));
  for (const [title, data] of entries) json.append(element('h3', title), jsonBlock(data));
  return json;
}
