// Samples a .blockyanim at a frame. Times are frames at 60 per second; each node track holds deltas on top of
// the model's rest pose: position offset, orientation quaternion, shape stretch factors and shape visibility.
// Looping animations wrap: the curve runs from a track's last keyframe round to its first, because most
// looping tracks stop well before the animation's end. "smooth" keyframes are read as curves through their
// neighbours (Catmull-Rom with tangents scaled to the keyframe spacing) and "linear" ones as straight lines.

export const FRAMES_PER_SECOND = 60;

const components = (delta, keys) => keys.map((key) => delta[key] ?? (key === 'w' ? 1 : 0));

// Keeps a quaternion on the same side as its reference so the curve doesn't take the long way round.
function alignTo(q, reference) {
  return q.reduce((sum, v, i) => sum + v * reference[i], 0) < 0 ? q.map((v) => -v) : q;
}

function hermite(p1, p2, m1, m2, s) {
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p1 + (s3 - 2 * s2 + s) * m1 + (-2 * s3 + 3 * s2) * p2 + (s3 - s2) * m2;
}

// loopLength is the animation's duration for looping animations, else 0 (hold the first and last keyframes).
function sample(keyframes, frame, keys, loopLength) {
  const n = keyframes.length;
  const at = (i) => keyframes[((i % n) + n) % n];
  const time = (i) => at(i).time + Math.floor(i / n) * loopLength;
  const value = (i) => components(at(i).delta, keys);
  if (n === 1) return value(0);
  let index = -1;
  for (let i = 0; i < n && keyframes[i].time <= frame; i++) index = i;
  if (!loopLength && index < 0) return value(0);
  if (!loopLength && index === n - 1) return value(n - 1);

  const [t1, t2] = [time(index), time(index + 1)];
  const span = Math.max(t2 - t1, 1e-6);
  const s = Math.min(Math.max((frame - t1) / span, 0), 1);
  const quaternion = keys.length === 4;
  const p1 = value(index);
  const p2 = quaternion ? alignTo(value(index + 1), p1) : value(index + 1);
  if (at(index).interpolationType !== 'smooth') return p1.map((v, i) => v + (p2[i] - v) * s);

  const hasBefore = loopLength || index > 0;
  const hasAfter = loopLength || index + 2 < n;
  const t0 = hasBefore ? time(index - 1) : t1;
  const t3 = hasAfter ? time(index + 2) : t2;
  const p0 = hasBefore ? (quaternion ? alignTo(value(index - 1), p1) : value(index - 1)) : p1;
  const p3 = hasAfter ? (quaternion ? alignTo(value(index + 2), p2) : value(index + 2)) : p2;
  return p1.map((v, i) => {
    const m1 = ((p2[i] - p0[i]) / Math.max(t2 - t0, 1e-6)) * span;
    const m2 = ((p3[i] - v) / Math.max(t3 - t1, 1e-6)) * span;
    return hermite(v, p2[i], m1, m2, s);
  });
}

/** Returns a Map of node name to {position, orientation, stretch, visible}, each present only when animated. */
export function samplePose(animation, frame) {
  const loopLength = animation.holdLastKeyframe ? 0 : Math.max(animation.duration ?? 1, 1);
  const pose = new Map();
  for (const [node, tracks] of Object.entries(animation.nodeAnimations ?? {})) {
    const entry = {};
    if (tracks.position?.length) entry.position = sample(tracks.position, frame, ['x', 'y', 'z'], loopLength);
    if (tracks.orientation?.length) {
      const q = sample(tracks.orientation, frame, ['x', 'y', 'z', 'w'], loopLength);
      const length = Math.hypot(...q) || 1;
      entry.orientation = q.map((v) => v / length);
    }
    if (tracks.shapeStretch?.length) entry.stretch = sample(tracks.shapeStretch, frame, ['x', 'y', 'z'], loopLength);
    if (tracks.shapeVisible?.length) {
      const keys = tracks.shapeVisible;
      const before = keys.filter((keyframe) => keyframe.time <= frame).pop() ?? (loopLength ? keys.at(-1) : keys[0]);
      entry.visible = Boolean(before.delta);
    }
    pose.set(node, entry);
  }
  return pose;
}

/** The frame to show after `seconds` of playback at `speed`: looping, or held on the last frame. */
export function frameAt(animation, seconds, speed) {
  const frame = seconds * FRAMES_PER_SECOND * speed;
  const duration = Math.max(animation.duration ?? 1, 1);
  return animation.holdLastKeyframe ? Math.min(frame, duration) : frame % duration;
}
