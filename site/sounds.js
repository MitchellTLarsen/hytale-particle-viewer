// Sounds tab: lists Server/Audio/SoundEvents, plays them with <audio> elements and draws the played file's waveform.

import { button, chips, element, formatNumber, table } from './dom.js';
import { rawJson } from './links.js';

const VOLUME_KEY = 'soundVolume';
const decibelsToGain = (decibels) => Math.min(1, 10 ** (decibels / 20));
const randomBetween = (min = 0, max = 0) => min + Math.random() * (max - min);
const fileName = (file) => file.split('/').pop();

// One bar per pixel column from the lowest to the highest sample in it.
function paintWave(canvas, buffer) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const samples = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(samples.length / width));
  for (let x = 0; x < width; x++) {
    let low = 1;
    let high = -1;
    for (let i = x * step; i < Math.min((x + 1) * step, samples.length); i++) {
      low = Math.min(low, samples[i]);
      high = Math.max(high, samples[i]);
    }
    if (low > high) continue;
    const top = ((1 - high) / 2) * height;
    context.fillRect(x, top, 1, Math.max(1, ((1 - low) / 2) * height - top));
  }
}

export function createSoundsTab(data, details) {
  const byId = new Map(data.sounds.map((sound) => [sound.id, sound]));
  let playing = [];
  let autoPlay = true;
  let volume = parseFloat(localStorage.getItem(VOLUME_KEY) ?? '0.25');
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

  function playFile(file, { decibels = 0, pitch = 0, loop = false, delay = 0 } = {}) {
    const audio = new Audio('assets/' + file);
    const gain = decibelsToGain(decibels);
    audio.volume = gain * volume;
    audio.preservesPitch = false;
    audio.playbackRate = 2 ** (pitch / 12);
    audio.loop = loop;
    const timer = setTimeout(() => audio.play().catch(showError), delay * 1000);
    playing.push({ audio, timer, gain });
  }

  function volumeSlider() {
    const slider = element('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.01';
    slider.value = String(volume);
    slider.addEventListener('input', () => {
      volume = parseFloat(slider.value);
      localStorage.setItem(VOLUME_KEY, String(volume));
      for (const entry of playing) entry.audio.volume = entry.gain * volume;
    });
    const label = element('label', 'Volume ');
    label.append(slider);
    return label;
  }

  let audioContext = null;
  let wave = null; // {canvas, label} of the shown sound

  async function drawWave(file) {
    const target = wave;
    if (!target) return;
    target.label.textContent = `${fileName(file)}  ·  loading`;
    try {
      audioContext ??= new AudioContext();
      const response = await fetch('assets/' + file);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await audioContext.decodeAudioData(await response.arrayBuffer());
      if (wave !== target) return;
      paintWave(target.canvas, buffer);
      target.label.textContent = `${fileName(file)}  ·  ${buffer.duration.toFixed(2)} s`;
    } catch (error) {
      if (wave === target) target.label.textContent = `${fileName(file)}  ·  no waveform (${error.message})`;
    }
  }

  function waveStrip(event) {
    const canvas = element('canvas');
    const label = element('small');
    const strip = element('div', undefined, 'wave');
    strip.append(canvas, label);
    wave = { canvas, label };
    const first = (event.Layers ?? []).flatMap((layer) => layer.Files ?? [])[0];
    if (first) requestAnimationFrame(() => drawWave(first));
    else label.textContent = 'No sound files';
    return strip;
  }

  function play(event) {
    stop();
    if (status) status.textContent = '';
    let drawn = false;
    for (const layer of event.Layers ?? []) {
      const files = layer.Files ?? [];
      if (files.length === 0 || Math.random() * 100 >= (layer.Probability ?? 100)) continue;
      const random = layer.RandomSettings ?? {};
      const file = files[Math.floor(Math.random() * files.length)];
      if (!drawn) drawWave(file);
      drawn = true;
      playFile(file, {
        decibels: (event.Volume ?? 0) + (layer.Volume ?? 0) + randomBetween(random.MinVolume, random.MaxVolume),
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
    details.append(chips(facts));
    if (event.$Comment) details.append(element('p', `Comment: ${event.$Comment}`, 'comment'));

    const autoPlayToggle = element('input');
    autoPlayToggle.type = 'checkbox';
    autoPlayToggle.checked = autoPlay;
    autoPlayToggle.addEventListener('change', () => (autoPlay = autoPlayToggle.checked));
    const autoPlayLabel = element('label');
    autoPlayLabel.append(autoPlayToggle, ' Play on select');
    const actions = element('div', undefined, 'actions');
    actions.append(button('Play', () => play(event)), button('Stop', stop), volumeSlider(), autoPlayLabel);
    status = element('p', '', 'error');
    details.append(actions, status);

    const layers = event.Layers ?? [];
    if (layers.length === 0) details.append(element('p', 'This sound event has no layers.'));
    else details.append(waveStrip(event), layerTable(event, layers));

    details.append(rawJson(parents(sound).map((s) => [`${s.id}.json`, s.data])));
    if (autoPlay) play(event);
  }

  function layerTable(event, layers) {
    const range = (min = 0, max = 0) => (min === max ? formatNumber(min) : `${formatNumber(min)} to ${formatNumber(max)}`);
    const rows = layers.map((layer, index) => {
      const files = element('div');
      for (const file of layer.Files ?? []) {
        const decibels = (event.Volume ?? 0) + (layer.Volume ?? 0);
        const play = () => {
          stop();
          playFile(file, { decibels, pitch: event.Pitch ?? 0 });
          drawWave(file);
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
