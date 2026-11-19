// Sounds tab: lists Server/Audio/SoundEvents and plays them with <audio> elements.

import { button, element, formatNumber, rawJson, table } from './dom.js';

const decibelsToGain = (decibels) => Math.min(1, 10 ** (decibels / 20));
const randomBetween = (min = 0, max = 0) => min + Math.random() * (max - min);
const fileName = (file) => file.split('/').pop();

export function createSoundsTab(data, details) {
  const byId = new Map(data.sounds.map((sound) => [sound.id, sound]));
  let playing = [];
  let autoPlay = true;
  let status = null;

  // Parent fields are inherited unless the child sets them, as in the server's codec.
  function parents(sound) {
    const chain = [sound];
    for (let parent = byId.get(sound.data.Parent); parent && !chain.includes(parent); parent = byId.get(parent.data.Parent)) {
      chain.push(parent);
    }
    return chain;
  }

  const resolve = (sound) => Object.assign({}, ...parents(sound).reverse().map((s) => s.data));

  function stop() {
    for (const { audio, timer } of playing) {
      clearTimeout(timer);
      audio.pause();
    }
    playing = [];
  }

  // AbortError only means stop() cut the sound short.
  function showError(error) {
    if (!status || error.name === 'AbortError') return;
    status.textContent =
      error.name === 'NotAllowedError'
        ? 'The browser blocked autoplay. Press Play.'
        : error.name === 'NotSupportedError'
          ? 'This browser cannot play Ogg Vorbis files (or the file is missing). Try Chrome or Firefox.'
          : `Could not play the sound: ${error.message}`;
  }

  function playFile(file, { volume = 0, pitch = 0, loop = false, delay = 0 } = {}) {
    const audio = new Audio('assets/' + file);
    audio.volume = decibelsToGain(volume);
    audio.preservesPitch = false;
    audio.playbackRate = 2 ** (pitch / 12);
    audio.loop = loop;
    const timer = setTimeout(() => audio.play().catch(showError), delay * 1000);
    playing.push({ audio, timer });
  }

  function play(event) {
    stop();
    if (status) status.textContent = '';
    for (const layer of event.Layers ?? []) {
      const files = layer.Files ?? [];
      if (files.length === 0 || Math.random() * 100 >= (layer.Probability ?? 100)) continue;
      const random = layer.RandomSettings ?? {};
      playFile(files[Math.floor(Math.random() * files.length)], {
        volume: (event.Volume ?? 0) + (layer.Volume ?? 0) + randomBetween(random.MinVolume, random.MaxVolume),
        pitch: (event.Pitch ?? 0) + randomBetween(random.MinPitch, random.MaxPitch),
        loop: Boolean(layer.Looping),
        delay: layer.StartDelay ?? 0,
      });
    }
  }

  function select(sound) {
    stop();
    const event = resolve(sound);
    details.replaceChildren(element('h2', sound.id), element('p', `Server/Audio/SoundEvents/${sound.path}.json`, 'path'));

    const facts = [];
    if (event.AudioCategory) facts.push(`Category: ${event.AudioCategory}`);
    facts.push(`Volume: ${formatNumber(event.Volume ?? 0)} dB`);
    if (event.Pitch) facts.push(`Pitch: ${formatNumber(event.Pitch)} semitones`);
    if (event.MaxDistance) facts.push(`Heard to ${event.MaxDistance} blocks (fades from ${event.StartAttenuationDistance ?? 0})`);
    if (event.MaxInstance) facts.push(`Max instances: ${event.MaxInstance}`);
    if (sound.data.Parent) facts.push(`Parent: ${sound.data.Parent}`);
    details.append(element('p', facts.join('  |  '), 'facts'));
    if (event.$Comment) details.append(element('p', `Comment: ${event.$Comment}`, 'comment'));

    const autoPlayToggle = element('input');
    autoPlayToggle.type = 'checkbox';
    autoPlayToggle.checked = autoPlay;
    autoPlayToggle.addEventListener('change', () => (autoPlay = autoPlayToggle.checked));
    const autoPlayLabel = element('label');
    autoPlayLabel.append(autoPlayToggle, ' Play on select');
    const actions = element('div', undefined, 'actions');
    actions.append(button('Play', () => play(event)), button('Stop', stop), autoPlayLabel);
    status = element('p', '', 'error');
    details.append(actions, status);

    const layers = event.Layers ?? [];
    if (layers.length === 0) details.append(element('p', 'This sound event has no layers.'));
    else details.append(layerTable(event, layers));

    details.append(rawJson(parents(sound).map((s) => [`${s.id}.json`, s.data])));
    if (autoPlay) play(event);
  }

  function layerTable(event, layers) {
    const range = (min = 0, max = 0) => (min === max ? formatNumber(min) : `${formatNumber(min)} to ${formatNumber(max)}`);
    const rows = layers.map((layer, index) => {
      const files = element('div');
      for (const file of layer.Files ?? []) {
        const volume = (event.Volume ?? 0) + (layer.Volume ?? 0);
        const play = () => {
          stop();
          playFile(file, { volume, pitch: event.Pitch ?? 0 });
        };
        const node = button(fileName(file), play, 'file');
        node.title = file;
        files.append(node);
      }
      const random = layer.RandomSettings ?? {};
      return [
        String(index + 1),
        files,
        formatNumber(layer.Volume ?? 0),
        range(random.MinVolume, random.MaxVolume),
        range(random.MinPitch, random.MaxPitch),
        layer.StartDelay ? String(layer.StartDelay) : '',
        `${layer.Probability ?? 100}%`,
        layer.Looping ? 'yes' : '',
      ];
    });
    const headers = ['Layer', 'Files (one picked at random)', 'Volume (dB)', 'Random volume (dB)', 'Random pitch (st)', 'Delay (s)', 'Chance', 'Loops'];
    return table(headers, rows);
  }

  return {
    name: 'sounds',
    noun: 'sound events',
    showsViewer: false,
    items: data.sounds,
    group: (sound) => {
      const folders = sound.path.split('/').slice(0, -1);
      return folders.length ? folders.slice(0, 2).join('/') : 'Templates';
    },
    select,
    leave: stop,
  };
}
