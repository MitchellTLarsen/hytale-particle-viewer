// Samples a .blockyanim at a frame. Times are frames at 60 per second; each node track holds deltas on top of
// the model's rest pose: position offset, orientation quaternion, shape stretch factors and shape visibility.
// "smooth" keyframes are read as Catmull-Rom curves and "linear" as straight lines, as the Hytale Blockbench
// plugin reads them.

export const FRAMES_PER_SECOND = 60;

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3);
}

const components = (delta, keys) => keys.map((key) => delta[key] ?? (key === 'w' ? 1 : 0));

function sample(keyframes, frame, keys) {
  let index = -1;
  for (let i = 0; i < keyframes.length && keyframes[i].time <= frame; i++) index = i;
  if (index < 0) return components(keyframes[0].delta, keys);
  if (index === keyframes.length - 1) return components(keyframes[index].delta, keys);
  const [a, b] = [keyframes[index], keyframes[index + 1]];
  const t = (frame - a.time) / Math.max(b.time - a.time, 1e-6);
  const p1 = components(a.delta, keys);
  const p2 = components(b.delta, keys);
  if (a.interpolationType !== 'smooth') return p1.map((v, i) => v + (p2[i] - v) * t);
  const p0 = components((keyframes[index - 1] ?? a).delta, keys);
  const p3 = components((keyframes[index + 2] ?? b).delta, keys);
  return p1.map((v, i) => catmullRom(p0[i], v, p2[i], p3[i], t));
}

// Keeps quaternion neighbours on the same side so curves don't take the long way round.
function alignQuaternions(keyframes) {
  let previous = null;
  return keyframes.map((keyframe) => {
    let q = components(keyframe.delta, ['x', 'y', 'z', 'w']);
    if (previous && q.reduce((sum, v, i) => sum + v * previous[i], 0) < 0) q = q.map((v) => -v);
    previous = q;
    return { ...keyframe, delta: { x: q[0], y: q[1], z: q[2], w: q[3] } };
  });
}

/** Returns a Map of node name to {position, orientation, stretch, visible}, each present only when animated. */
export function samplePose(animation, frame) {
  const pose = new Map();
  for (const [node, tracks] of Object.entries(animation.nodeAnimations ?? {})) {
    const entry = {};
    if (tracks.position?.length) entry.position = sample(tracks.position, frame, ['x', 'y', 'z']);
    if (tracks.orientation?.length) {
      tracks.alignedOrientation ??= alignQuaternions(tracks.orientation);
      const q = sample(tracks.alignedOrientation, frame, ['x', 'y', 'z', 'w']);
      const length = Math.hypot(...q) || 1;
      entry.orientation = q.map((v) => v / length);
    }
    if (tracks.shapeStretch?.length) entry.stretch = sample(tracks.shapeStretch, frame, ['x', 'y', 'z']);
    if (tracks.shapeVisible?.length) {
      const before = tracks.shapeVisible.filter((keyframe) => keyframe.time <= frame).pop() ?? tracks.shapeVisible[0];
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
