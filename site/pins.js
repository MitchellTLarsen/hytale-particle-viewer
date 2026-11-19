// Pins and notes, kept in this browser (localStorage) and keyed by "<tab>:<path>".

import { element } from './dom.js';

const PINS_KEY = 'pins';
const NOTES_KEY = 'notes';

function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function createPins() {
  let pins = read(PINS_KEY, []);
  const notes = read(NOTES_KEY, {});

  const toggle = (key) => {
    pins = pins.includes(key) ? pins.filter((pin) => pin !== key) : [...pins, key];
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  };

  return {
    /** Paths pinned in a tab, oldest first. */
    pinnedIn: (tab) => pins.filter((pin) => pin.startsWith(`${tab}:`)).map((pin) => pin.slice(tab.length + 1)),

    /** Adds a Pin button to the details title and a Notes box under the path; `onChange` runs after a (un)pin. */
    decorate(details, key, onChange) {
      const title = details.querySelector('h2');
      if (!title) return;
      const pin = element('button', undefined, 'pin');
      const label = () => {
        const pinned = pins.includes(key);
        pin.textContent = pinned ? '★ Pinned' : '☆ Pin';
        pin.classList.toggle('active', pinned);
      };
      pin.addEventListener('click', () => {
        toggle(key);
        label();
        onChange();
      });
      label();
      title.append(pin);

      const box = element('details', undefined, 'notes-box');
      box.open = Boolean(notes[key]);
      const summary = element('summary', notes[key] ? 'Notes •' : 'Notes');
      const text = element('textarea');
      text.placeholder = 'Your notes on this, kept in this browser';
      text.value = notes[key] ?? '';
      text.addEventListener('input', () => {
        if (text.value.trim()) notes[key] = text.value;
        else delete notes[key];
        localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
        summary.textContent = notes[key] ? 'Notes •' : 'Notes';
      });
      box.append(summary, text);
      (details.querySelector('.path') ?? title).after(box);
    },
  };
}
