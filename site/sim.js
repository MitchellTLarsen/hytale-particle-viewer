// Approximate simulation of Hytale particle systems from their asset JSON.
// Field meanings come from the documentation strings in the server's particle asset codecs
// (server/core/asset/type/particle/config/*.java). The client renderer is closed source, so
// units, blending and some timing rules are best guesses; see README "Approximations".

const DEG = Math.PI / 180;
const PARTICLE_CAP = 512; // "The client caps this value at 512" (MaxConcurrentParticles)
const SPAWNER_CAP = 10; // "The client caps this value at 10" (MaxConcurrent)
// Guess: DampingMultiplier is the share of velocity kept per this many seconds.
const DAMPING_SECONDS = 1;

// ---------------------------------------------------------------- ranges and random values

// A range is {Min, Max}; a missing side is 0, matching the server's Rangef defaults.
function lerpRange(range, u, fallback) {
  if (range === undefined || range === null) return fallback;
  if (typeof range === 'number') return range;
  const min = range.Min ?? 0;
  const max = range.Max ?? 0;
  return min + (max - min) * u;
}

function pick(range, fallback = 0) {
  return lerpRange(range, Math.random(), fallback);
}

function pickInt(range, u) {
  const min = Math.round(range.Min ?? 0);
  const max = Math.round(range.Max ?? 0);
  return Math.min(max, min + Math.floor(u * (max - min + 1)));
}

// Many assets write 0 for "use the default", so non-positive values fall back to the client cap.
function capped(value, cap) {
  return value > 0 ? Math.min(value, cap) : cap;
}

function pickTotal(range) {
  if (range === undefined) return Infinity;
  const total = pickInt(range, Math.random());
  return total < 0 ? Infinity : total;
}

// Stable per-particle random number for key `n`, so a keyframe range is sampled once per particle.
function hash01(seed, n) {
  let h = seed ^ Math.imul(n + 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function gaussian() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

function parseColor(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  const value = parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

// ---------------------------------------------------------------- vectors and rotations

function vec(v) {
  return v ? [v.X ?? 0, v.Y ?? 0, v.Z ?? 0] : [0, 0, 0];
}

function length(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

export function normalize(v) {
  const l = length(v);
  return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
}

export function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// 3x3 matrices are row-major arrays of 9 numbers.
export function mul3(a, b) {
  const out = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

export function apply3(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

function rotX(deg) {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

function rotY(deg) {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

function rotZ(deg) {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// Direction {Yaw, Pitch, Roll} in degrees. Pitch is negated so that +90 points up, matching
// the InitialVelocity docs ("Down < - 90 + > Up"); forward (yaw 0, pitch 0) is +Z.
function mat3FromDirection(direction) {
  if (!direction) return IDENTITY;
  return mul3(mul3(rotY(direction.Yaw ?? 0), rotX(-(direction.Pitch ?? 0))), rotZ(direction.Roll ?? 0));
}

export function mat3FromEuler(x, y, z) {
  return mul3(mul3(rotY(y), rotX(x)), rotZ(z));
}

function directionFromYawPitch(yaw, pitch) {
  const cp = Math.cos(pitch * DEG);
  return [Math.sin(yaw * DEG) * cp, Math.sin(pitch * DEG), Math.cos(yaw * DEG) * cp];
}

// EmitOffset: a region centred on the spawner. One axis gives a line, two a flat shape, three
// a solid shape; positive Min values hollow it out. Negative Min values are read as 0, since
// some assets write symmetric intervals like {Min: -0.2, Max: 0.2}.
function emitOffset(range, shape) {
  if (!range) return [0, 0, 0];
  const axes = [range.X, range.Y, range.Z];
  const defined = axes.map((a) => a !== undefined);
  const inner = axes.map((a) => (a ? Math.max(a.Min ?? 0, 0) : 0));
  const outer = axes.map((a, i) => (a ? Math.max(Math.abs(a.Max ?? 0), inner[i]) : 0));
  const count = defined.filter(Boolean).length;
  if (count === 0) return [0, 0, 0];

  if (shape === 'Cube') {
    for (let attempt = 0; attempt < 8; attempt++) {
      const p = outer.map((o, i) => (defined[i] ? (Math.random() * 2 - 1) * o : 0));
      const insideHole = p.every((v, i) => !defined[i] || Math.abs(v) < inner[i]);
      if (!insideHole) return p;
    }
    // Thin shell: put one axis on the outer band.
    const p = outer.map((o, i) => (defined[i] ? (Math.random() * 2 - 1) * o : 0));
    const axis = [0, 1, 2].filter((i) => defined[i])[Math.floor(Math.random() * count)];
    p[axis] = Math.sign(Math.random() - 0.5) * lerpRange({ Min: inner[axis], Max: outer[axis] }, Math.random());
    return p;
  }

  let direction;
  do {
    direction = defined.map((d) => (d ? gaussian() : 0));
  } while (length(direction) < 1e-6);
  direction = normalize(direction);
  const t = Math.pow(Math.random(), 1 / count);
  return direction.map((d, i) => d * (inner[i] + (outer[i] - inner[i]) * t));
}

// ---------------------------------------------------------------- animation

function withStart(track, initialValue) {
  if (initialValue === undefined || track.length === 0 || track[0].t === 0) return track;
  return [{ t: 0, v: initialValue }, ...track];
}

// Linear interpolation between the keyframes that define this property. `valueOf(v, u)`
// turns a keyframe value into a number, using `u` as that key's per-particle random number.
function evalTrack(track, t, seed, salt, valueOf) {
  if (track.length === 0) return undefined;
  const at = (i) => valueOf(track[i].v, hash01(seed, salt + i));
  if (t <= track[0].t) return at(0);
  for (let i = 1; i < track.length; i++) {
    if (t <= track[i].t) {
      const span = track[i].t - track[i - 1].t;
      const f = span > 0 ? (t - track[i - 1].t) / span : 1;
      const a = at(i - 1);
      return a + (at(i) - a) * f;
    }
  }
  return at(track.length - 1);
}

const rangeValue = (range, u) => lerpRange(range, u, 1);
const SALT = { scaleX: 100, scaleY: 200, opacity: 300, rotX: 400, rotY: 500, rotZ: 600, frame: 700 };

const compiledSpawners = new WeakMap();

// Pre-sorts the keyframes of a spawner definition into per-property tracks.
export function compileSpawner(def) {
  let compiled = compiledSpawners.get(def);
  if (compiled) return compiled;
  const particle = def.Particle ?? {};
  const init = particle.InitialAnimationFrame ?? {};
  const keys = Object.entries(particle.Animation ?? {})
    .map(([percent, frame]) => ({ t: parseFloat(percent) / 100, frame }))
    .filter((key) => Number.isFinite(key.t) && key.frame)
    .sort((a, b) => a.t - b.t);
  const track = (get) => keys.filter((k) => get(k.frame) !== undefined).map((k) => ({ t: k.t, v: get(k.frame) }));
  // Opacity -1 (the default) means "unset".
  const opacityOf = (frame) => (typeof frame.Opacity === 'number' && frame.Opacity >= 0 ? frame.Opacity : undefined);

  compiled = {
    def,
    texture: particle.Texture,
    frameSize: particle.FrameSize ? [particle.FrameSize.Width, particle.FrameSize.Height] : null,
    renderMode: def.RenderMode ?? 'BlendLinear',
    rotationInfluence: def.ParticleRotationInfluence ?? 'None',
    ratio: particle.ScaleRatioConstraint ?? 'OneToOne',
    uvOption: particle.UVOption ?? 'None',
    linearFiltering: def.LinearFiltering === true,
    init: {
      scaleX: init.Scale?.X,
      scaleY: init.Scale?.Y,
      opacity: opacityOf(init) ?? 1,
      color: parseColor(init.Color) ?? [1, 1, 1],
      rotation: init.Rotation,
      frame: init.FrameIndex,
    },
    tracks: {
      scaleX: track((f) => f.Scale?.X),
      scaleY: track((f) => f.Scale?.Y),
      opacity: track(opacityOf),
      rotX: track((f) => f.Rotation?.X),
      rotY: track((f) => f.Rotation?.Y),
      rotZ: track((f) => f.Rotation?.Z),
      color: withStart(track((f) => parseColor(f.Color)), parseColor(init.Color)),
      frame: withStart(track((f) => f.FrameIndex), init.FrameIndex),
    },
  };
  compiledSpawners.set(def, compiled);
  return compiled;
}

// Visual state of one particle at its current age: size, opacity, colour, rotation and frame.
// Animation Scale and Opacity multiply the initial frame, Rotation adds to it (codec docs).
export function particleLook(compiled, p) {
  const { tracks, init } = compiled;
  const t = p.age / p.life;
  const s = p.seed;
  const animX = evalTrack(tracks.scaleX, t, s, SALT.scaleX, rangeValue);
  const animY = evalTrack(tracks.scaleY, t, s, SALT.scaleY, rangeValue);
  let sizeX = p.scaleX * (animX ?? animY ?? 1);
  let sizeY = p.scaleY * (animY ?? animX ?? 1);
  if (compiled.ratio === 'OneToOne') sizeY = sizeX;
  const opacity = p.opacity * (evalTrack(tracks.opacity, t, s, SALT.opacity, (v) => v) ?? 1);
  const color = [0, 1, 2].map((c) => evalTrack(tracks.color, t, s, 0, (v) => v[c]) ?? init.color[c]);
  const rotation = [
    p.rotation[0] + (evalTrack(tracks.rotX, t, s, SALT.rotX, (v, u) => lerpRange(v, u, 0)) ?? 0),
    p.rotation[1] + (evalTrack(tracks.rotY, t, s, SALT.rotY, (v, u) => lerpRange(v, u, 0)) ?? 0),
    p.rotation[2] + (evalTrack(tracks.rotZ, t, s, SALT.rotZ, (v, u) => lerpRange(v, u, 0)) ?? 0),
  ];
  const frame = Math.floor(evalTrack(tracks.frame, t, s, SALT.frame, (v, u) => pickInt(v, u)) ?? 0);
  return { sizeX, sizeY, opacity, color, rotation, frame };
}

// ---------------------------------------------------------------- attractors

// Moves `body` ({position, velocity}) by the attractors placed around `center` with rotation `m`.
// Accelerations change velocity; impulses are constant speeds that do not accumulate.
// Returns the impulse velocity so the caller can include it in the body's motion.
function applyAttractors(attractors, body, center, m, dt) {
  const impulse = [0, 0, 0];
  if (!attractors) return impulse;
  for (const attractor of attractors) {
    if (attractor.DampingMultiplier) {
      const damping = vec(attractor.DampingMultiplier);
      for (let i = 0; i < 3; i++) body.velocity[i] *= Math.pow(Math.max(damping[i], 0), dt / DAMPING_SECONDS);
    }
    const origin = apply3(m, vec(attractor.Position));
    const offset = [0, 1, 2].map((i) => body.position[i] - center[i] - origin[i]);
    if (attractor.Radius !== undefined && length(offset) > attractor.Radius) continue;

    const axis = attractor.RadialAxis ? normalize(apply3(m, vec(attractor.RadialAxis))) : null;
    let radial = offset;
    if (axis && length(axis) > 0) {
      const along = dot(offset, axis);
      radial = [0, 1, 2].map((i) => offset[i] - axis[i] * along);
    }
    const radialDir = normalize(radial);
    const tangentDir = normalize(cross(axis && length(axis) > 0 ? axis : [0, 1, 0], radial));
    const linearAcceleration = apply3(m, vec(attractor.LinearAcceleration));
    const linearImpulse = apply3(m, vec(attractor.LinearImpulse));
    for (let i = 0; i < 3; i++) {
      body.velocity[i] +=
        (radialDir[i] * (attractor.RadialAcceleration ?? 0) +
          tangentDir[i] * (attractor.RadialTangentAcceleration ?? 0) +
          linearAcceleration[i]) *
        dt;
      impulse[i] +=
        radialDir[i] * (attractor.RadialImpulse ?? 0) +
        tangentDir[i] * (attractor.RadialTangentImpulse ?? 0) +
        linearImpulse[i];
    }
  }
  return impulse;
}

// ---------------------------------------------------------------- spawners and systems

// One live spawner: emits particles and moves them.
class SpawnerInstance {
  constructor(compiled, position, velocity, rotation, lifeSpan) {
    const def = compiled.def;
    this.compiled = compiled;
    this.position = position;
    this.velocity = velocity;
    this.rotation = rotation;
    this.lifeSpan = lifeSpan;
    this.age = 0;
    this.particles = [];
    this.emitting = true;
    this.cap = capped(def.MaxConcurrentParticles, PARTICLE_CAP);
    this.rate = pick(def.SpawnRate, 0);
    this.total = pickTotal(def.TotalParticles);
    this.emitted = 0;
    this.accumulator = 0;
    this.nextBurst = 0;
    this.resumeAt = null;
  }

  get done() {
    return !this.emitting && this.particles.length === 0;
  }

  step(dt, active) {
    this.age += dt;
    if (!active || (this.lifeSpan > 0 && this.age >= this.lifeSpan)) this.emitting = false;
    if (this.emitting) this.emit(dt);
    this.moveParticles(dt);
  }

  emit(dt) {
    const def = this.compiled.def;
    if (def.SpawnBurst) {
      // Burst: SpawnRate particles at once, repeated every WaveDelay (once if there is none).
      // Guess: with no SpawnRate, a burst releases its whole TotalParticles.
      if (this.age < this.nextBurst) return;
      const count = def.SpawnRate ? Math.round(pick(def.SpawnRate)) : this.total;
      for (let i = 0; i < count && this.emitted < this.total && this.particles.length < this.cap; i++) this.spawn();
      if (def.WaveDelay && this.emitted < this.total) this.nextBurst = this.age + Math.max(pick(def.WaveDelay), 0.05);
      else this.emitting = false;
      return;
    }
    if (this.emitted >= this.total) {
      // "Spawning pauses for this delay after all particles of a wave have expired."
      if (!def.WaveDelay) {
        this.emitting = false;
        return;
      }
      if (this.particles.length > 0) return;
      if (this.resumeAt === null) this.resumeAt = this.age + pick(def.WaveDelay);
      if (this.age < this.resumeAt) return;
      this.resumeAt = null;
      this.emitted = 0;
      this.total = pickTotal(def.TotalParticles);
    }
    this.accumulator += this.rate * dt;
    while (this.accumulator >= 1 && this.emitted < this.total) {
      this.accumulator -= 1;
      this.spawn();
    }
  }

  spawn() {
    if (this.particles.length >= this.cap) return;
    const compiled = this.compiled;
    const def = compiled.def;
    const init = compiled.init;
    const velocityDef = def.InitialVelocity;
    const offset = emitOffset(def.EmitOffset, def.Shape ?? 'Sphere');
    let direction;
    if (def.UseEmitDirection && length(offset) > 1e-6) direction = normalize(offset);
    else direction = directionFromYawPitch(pick(velocityDef?.Yaw, 0), pick(velocityDef?.Pitch, 0));
    const speed = pick(velocityDef?.Speed, 0);
    const worldOffset = apply3(this.rotation, offset);
    const worldDirection = apply3(this.rotation, direction);

    const scaleU = Math.random();
    let scaleX = lerpRange(init.scaleX, scaleU, undefined);
    let scaleY = lerpRange(init.scaleY, Math.random(), undefined);
    scaleX ??= scaleY ?? 1;
    scaleY ??= scaleX;
    const flip = compiled.uvOption;
    const coin = () => Math.random() < 0.5;
    this.particles.push({
      position: [0, 1, 2].map((i) => this.position[i] + worldOffset[i]),
      velocity: worldDirection.map((d) => d * speed),
      motion: worldDirection.map((d) => d * speed),
      age: 0,
      life: Math.max(pick(def.ParticleLifeSpan, 1), 0.01),
      seed: (Math.random() * 4294967296) >>> 0,
      scaleX,
      scaleY,
      opacity: init.opacity,
      rotation: [0, 1, 2].map((i) => lerpRange(init.rotation?.['XYZ'[i]], Math.random(), 0)),
      flipU: flip === 'FlipU' || flip === 'FlipUV' || ((flip === 'RandomFlipU' || flip === 'RandomFlipUV') && coin()),
      flipV: flip === 'FlipV' || flip === 'FlipUV' || ((flip === 'RandomFlipV' || flip === 'RandomFlipUV') && coin()),
    });
    this.emitted++;
  }

  moveParticles(dt) {
    const attractors = this.compiled.def.Attractors;
    const particles = this.particles;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) {
        particles[i] = particles[particles.length - 1];
        particles.pop();
        continue;
      }
      const impulse = applyAttractors(attractors, p, this.position, this.rotation, dt);
      for (let k = 0; k < 3; k++) {
        p.motion[k] = p.velocity[k] + impulse[k];
        p.position[k] += p.motion[k] * dt;
      }
    }
  }
}

// One entry of a system's Spawners list: creates spawner instances over time.
class SpawnerGroup {
  constructor(group, compiled) {
    this.group = group;
    this.compiled = compiled;
    this.hidden = false;
    this.rotation = mat3FromDirection(group.RotationOffset);
    this.origin = vec(group.PositionOffset);
    const total = group.TotalSpawners ?? 1;
    this.total = total < 0 ? Infinity : total;
    this.maxConcurrent = capped(group.MaxConcurrent, SPAWNER_CAP);
    this.rate = pick(group.SpawnRate, 0);
    this.accumulator = 0;
    this.nextCreate = 0;
    this.created = 0;
    this.instances = [];
    this.done = !compiled;
  }

  step(dt, systemAge, active) {
    if (!this.compiled) return;
    const sinceStart = systemAge - (this.group.StartDelay ?? 0);
    if (active && sinceStart >= 0 && this.created < this.total) {
      if (this.group.SpawnRate && this.total !== 1) {
        // SpawnRate spawners per second, at most MaxConcurrent alive ("ignored" when TotalSpawners is 1).
        this.accumulator += this.rate * dt;
        while (this.accumulator >= 1 && this.created < this.total && this.instances.length < this.maxConcurrent) {
          this.accumulator -= 1;
          this.create();
        }
      } else if (this.instances.length === 0 && sinceStart >= this.nextCreate) {
        // One at a time, WaveDelay apart; "a spawner only disappears when all its particles are
        // gone, so the interval may get stretched".
        this.create();
        this.nextCreate = sinceStart + pick(this.group.WaveDelay, 0);
      }
    }
    for (const instance of this.instances) {
      instance.step(dt, active);
      this.moveInstance(instance, dt);
    }
    this.instances = this.instances.filter((instance) => !instance.done);
    this.done = this.instances.length === 0 && (this.created >= this.total || !active);
  }

  create() {
    const group = this.group;
    const offset = apply3(this.rotation, emitOffset(group.EmitOffset, 'Sphere'));
    const direction = directionFromYawPitch(pick(group.InitialVelocity?.Yaw, 0), pick(group.InitialVelocity?.Pitch, 0));
    const speed = pick(group.InitialVelocity?.Speed, 0);
    const velocity = apply3(this.rotation, direction).map((d) => d * speed);
    const lifeSpans = [pick(group.LifeSpan, 0), this.compiled.def.LifeSpan ?? 0].filter((l) => l > 0);
    const lifeSpan = lifeSpans.length ? Math.min(...lifeSpans) : 0;
    const position = [0, 1, 2].map((i) => this.origin[i] + offset[i]);
    this.instances.push(new SpawnerInstance(this.compiled, position, velocity, this.rotation, lifeSpan));
    this.created++;
  }

  moveInstance(instance, dt) {
    if (!this.group.Attractors && length(instance.velocity) === 0) return;
    const impulse = applyAttractors(this.group.Attractors, instance, this.origin, this.rotation, dt);
    for (let k = 0; k < 3; k++) instance.position[k] += (instance.velocity[k] + impulse[k]) * dt;
  }
}

// A running particle system. `resolveSpawner(id)` returns a spawner definition or undefined.
export class SystemInstance {
  constructor(systemDef, resolveSpawner) {
    this.def = systemDef;
    this.age = 0;
    this.groups = (systemDef.Spawners ?? []).map((group) => {
      const def = resolveSpawner(group.SpawnerId);
      return new SpawnerGroup(group, def ? compileSpawner(def) : null);
    });
  }

  step(dt) {
    this.age += dt;
    const lifeSpan = this.def.LifeSpan ?? 0;
    const active = lifeSpan <= 0 || this.age < lifeSpan;
    for (const group of this.groups) group.step(dt, this.age, active);
  }

  get finished() {
    return this.groups.every((group) => group.done);
  }

  get particleCount() {
    let count = 0;
    for (const group of this.groups) for (const instance of group.instances) count += instance.particles.length;
    return count;
  }
}
