// Screen tab: camera shakes and view bobbing (applied to the preview camera) and screen overlays.

import { element, formatNumber, rawJson, table } from './dom.js';
import { Shake } from './shake.js';

const REPLAY_PAUSE = 0.6;
const KINDS = { CameraShake: 'Camera shakes', ViewBobbing: 'View bobbing', ScreenEffects: 'Screen overlays' };
const PERSPECTIVES = { FirstPerson: 'First person', ThirdPerson: 'Third person' };
const kindOf = (item) => item.path.split('/')[0];

export function createScreenTab(data, details, overlay) {
  const ofKind = (kind) => data.camera.filter((item) => kindOf(item) === kind);
  const effects = new Map(ofKind('CameraEffect').map((effect) => [effect.id, effect]));
  let current = null;
  let shake = null;
  let replayIn = null;
  let perspective = 'FirstPerson';
  let intensity = 1;

  function restart() {
    if (!current || kindOf(current) === 'ScreenEffects') return;
    shake = new Shake(current.data[perspective] ?? current.data.FirstPerson, intensity);
    replayIn = null;
  }

  function step(dt) {
    if (!shake) return;
    shake.step(dt);
    if (!shake.finished) return;
    replayIn ??= REPLAY_PAUSE;
    replayIn -= dt;
    if (replayIn <= 0) restart();
  }

  function leave() {
    shake = null;
    current = null;
    overlay.hidden = true;
  }

  function select(item) {
    leave();
    current = item;
    details.replaceChildren(element('h2', item.id));
    if (kindOf(item) === 'ScreenEffects') showOverlay(item);
    else showShake(item);
  }

  function showOverlay(item) {
    overlay.src = 'assets/' + item.texture;
    overlay.hidden = false;
    details.append(
      element('p', `Common/${item.texture}`, 'path'),
      element('p', 'Drawn over the preview, stretched to cover it.', 'facts'),
      element('h3', 'Used by'),
    );
    if (item.usedBy.length === 0) details.append(element('p', 'No server asset references this image.'));
    const list = element('ul');
    for (const path of item.usedBy) list.append(element('li', path));
    details.append(list);
  }

  function showShake(item) {
    const effect = effects.get(item.id);
    intensity = effect?.data.Intensity?.Value ?? 1;
    if (!item.data[perspective]) perspective = 'FirstPerson';
    restart();

    details.append(element('p', `Server/Camera/${item.path}.json`, 'path'));
    const facts = [];
    if (effect) facts.push(`Camera effect ${effect.id}: ${describeIntensity(effect.data.Intensity)}`);
    if (kindOf(item) === 'ViewBobbing') facts.push('Plays while the player moves this way');
    details.append(element('p', facts.join('  |  '), 'facts'));

    const actions = element('div', undefined, 'actions');
    const perspectives = Object.keys(PERSPECTIVES).filter((key) => item.data[key]);
    if (perspectives.length > 1) {
      const choice = element('select');
      for (const key of perspectives) choice.append(new Option(PERSPECTIVES[key], key, false, key === perspective));
      choice.addEventListener('change', () => {
        perspective = choice.value;
        renderProfile(item);
        restart();
      });
      actions.append(labelled('Camera ', choice));
    }
    const intensityInput = element('input');
    intensityInput.type = 'number';
    intensityInput.min = '0';
    intensityInput.step = '0.01';
    intensityInput.value = String(intensity);
    intensityInput.addEventListener('change', () => {
      intensity = Math.max(0, parseFloat(intensityInput.value) || 0);
      restart();
    });
    actions.append(labelled('Intensity ', intensityInput));
    details.append(actions, element('div', undefined, 'profile'));
    renderProfile(item);

    const json = [[`${item.path}.json`, item.data]];
    if (effect) json.push([`${effect.path}.json`, effect.data]);
    details.append(rawJson(json));
  }

  function renderProfile(item) {
    const profile = item.data[perspective] ?? item.data.FirstPerson;
    const timing = [];
    if (profile.EaseIn) timing.push(`Ease in: ${profile.EaseIn.Time} s ${profile.EaseIn.Type}`);
    if (profile.Duration !== undefined) timing.push(`Full strength: ${profile.Duration} s`);
    if (profile.EaseOut) timing.push(`Ease out: ${profile.EaseOut.Time} s ${profile.EaseOut.Type}`);
    if (profile.StartTime !== undefined) timing.push(`Start time: ${profile.StartTime}`);
    const rows = [];
    for (const [part, axes] of Object.entries({ Offset: profile.Offset, Rotation: profile.Rotation })) {
      for (const [axis, list] of Object.entries(axes ?? {})) {
        for (const config of list ?? []) {
          const clamp = config.Clamp ? `${config.Clamp.Min ?? -1} to ${config.Clamp.Max ?? 1}` : '';
          rows.push([`${part} ${axis}`, config.Type ?? '', formatNumber(config.Frequency ?? 0), formatNumber(config.Amplitude ?? 0), clamp]);
        }
      }
    }
    const container = details.querySelector('.profile');
    container.replaceChildren(element('p', timing.join('  |  '), 'facts'));
    container.append(rows.length ? table(['Motion', 'Noise', 'Frequency', 'Amplitude', 'Clamp'], rows) : element('p', 'No motion.'));
  }

  return {
    name: 'screen',
    noun: 'screen effects',
    showsViewer: true,
    items: [...ofKind('CameraShake'), ...ofKind('ViewBobbing'), ...data.overlays],
    group: (item) => KINDS[kindOf(item)],
    select,
    leave,
    step,
    restart,
    cameraShake: () => shake?.sample() ?? null,
  };
}

function labelled(text, control) {
  const label = element('label', text);
  label.append(control);
  return label;
}

function describeIntensity(intensity) {
  if (!intensity) return 'intensity from context';
  if (intensity.Value !== undefined) return `intensity ${intensity.Value}`;
  const { Input = [], Output = [] } = intensity.Modifier ?? {};
  return `intensity from context (such as damage), mapped ${Input.join(' to ')} -> ${Output.join(' to ')}`;
}
