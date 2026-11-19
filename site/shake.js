// Camera shake and view bobbing simulation from one Server/Camera profile (FirstPerson or ThirdPerson).
// Units are guesses: Frequency in radians per second, offsets in blocks, rotations in radians.

const EASINGS = {
  Linear: (x) => x,
  QuadInOut: (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2),
};

const ease = (easing, x) => (EASINGS[easing?.Type] ?? EASINGS.Linear)(x);

function gradient(index, seed) {
  const h = Math.sin((index + seed * 57.13) * 12.9898) * 43758.5453;
  return (h - Math.floor(h)) * 2 - 1;
}

// 1D gradient noise in roughly -1 to 1.
function perlin(x, seed) {
  const index = Math.floor(x);
  const t = x - index;
  const a = gradient(index, seed) * t;
  const b = gradient(index + 1, seed) * (t - 1);
  return (a + (b - a) * t * t * (3 - 2 * t)) * 2;
}

function noise(config, time) {
  const x = (config.Frequency ?? 0) * time;
  let value;
  if (config.Type === 'Cos') value = Math.cos(x);
  else if (config.Type?.startsWith('Perlin')) value = perlin(x, config.Seed ?? 0);
  else value = Math.sin(x);
  const clamp = config.Clamp ?? {};
  value = Math.min(clamp.Max ?? 1, Math.max(clamp.Min ?? -1, value));
  return value * (config.Amplitude ?? 0);
}

export class Shake {
  constructor(profile, intensity) {
    this.profile = profile;
    this.intensity = intensity;
    this.age = 0;
  }

  // View bobbing has no Duration and runs for as long as the movement does.
  get endless() {
    return this.profile.Duration === undefined;
  }

  get finished() {
    const p = this.profile;
    return !this.endless && this.age >= (p.EaseIn?.Time ?? 0) + p.Duration + (p.EaseOut?.Time ?? 0);
  }

  step(dt) {
    this.age += dt;
  }

  envelope() {
    const p = this.profile;
    const easeIn = p.EaseIn?.Time ?? 0;
    if (this.age < easeIn) return ease(p.EaseIn, this.age / easeIn);
    if (this.endless) return 1;
    const out = this.age - easeIn - p.Duration;
    const easeOut = p.EaseOut?.Time ?? 0;
    if (out <= 0) return 1;
    return out >= easeOut ? 0 : 1 - ease(p.EaseOut, out / easeOut);
  }

  sample() {
    const scale = this.envelope() * this.intensity;
    const time = (this.profile.StartTime ?? 0) + this.age;
    const sum = (list) => (list ?? []).reduce((total, config) => total + noise(config, time), 0) * scale;
    const { Offset = {}, Rotation = {} } = this.profile;
    return {
      offset: [sum(Offset.X), sum(Offset.Y), sum(Offset.Z)],
      pitch: sum(Rotation.Pitch),
      yaw: sum(Rotation.Yaw),
      roll: sum(Rotation.Roll),
    };
  }
}
