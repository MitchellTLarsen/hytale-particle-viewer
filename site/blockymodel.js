// Turns a .blockymodel node tree into triangles. Positions are in model units, UVs in texture pixels.
// The layout rules (node transforms, face sizes, mirror and angle) follow how the Hytale Blockbench
// plugin reads the format; the server's BlockyModelBoundsParser agrees on the transforms.

export const FLOATS_PER_VERTEX = 9; // position 3, uv 2, normal 3, fullbright 1

// Corners of the unit box for each face, top-left, top-right, bottom-left, bottom-right as seen from outside.
const FACES = {
  front: [[-1, 1, 1], [1, 1, 1], [-1, -1, 1], [1, -1, 1]],
  back: [[1, 1, -1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1]],
  right: [[1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1]],
  left: [[-1, 1, -1], [-1, 1, 1], [-1, -1, -1], [-1, -1, 1]],
  top: [[-1, 1, -1], [1, 1, -1], [-1, 1, 1], [1, 1, 1]],
  bottom: [[-1, -1, 1], [1, -1, 1], [-1, -1, -1], [1, -1, -1]],
};
// A quad is one face of a flat box, drawn with the "front" layout.
const QUAD_FACES = { '+X': 'right', '-X': 'left', '+Y': 'top', '-Y': 'bottom', '+Z': 'front', '-Z': 'back' };

const vector = (v, fallback = 0) => [v?.x ?? fallback, v?.y ?? fallback, v?.z ?? fallback];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function normalize(v) {
  const length = Math.hypot(...v) || 1;
  return v.map((c) => c / length);
}

function multiplyQuaternions([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function rotate([qx, qy, qz, qw], v) {
  const t = cross([qx, qy, qz], v).map((c) => c * 2);
  return add(add(v, t.map((c) => c * qw)), cross([qx, qy, qz], t));
}

// The shape's size along x, y, z; a quad has no depth along its normal.
function shapeSize(shape) {
  const [x, y, z] = vector(shape.settings?.size);
  if (shape.type !== 'quad') return [x, y, z];
  const axis = (shape.settings?.normal ?? '+Z')[1];
  return axis === 'X' ? [0, y, x] : axis === 'Y' ? [x, 0, y] : [x, y, 0];
}

function faceSize(face, [x, y, z]) {
  if (face === 'left' || face === 'right') return [z, y];
  if (face === 'top' || face === 'bottom') return [x, z];
  return [x, y];
}

// Texture pixel UVs for the face's top-left, top-right, bottom-left and bottom-right corners.
function faceUvs({ offset, mirror = {}, angle = 0 }, width, height) {
  const ox = offset?.x ?? 0;
  const oy = offset?.y ?? 0;
  const turned = angle === 90 || angle === 270;
  const w = turned ? height : width;
  const h = turned ? width : height;
  const mx = (turned ? mirror.y : mirror.x) ? -1 : 1;
  const my = (turned ? mirror.x : mirror.y) ? -1 : 1;
  const rects = {
    0: [ox, oy, ox + w * mx, oy + h * my],
    90: [ox, oy + h * my, ox - w * mx, oy],
    180: [ox - w * mx, oy - h * my, ox, oy],
    270: [ox + w * mx, oy, ox, oy - h * my],
  };
  const [u1, v1, u2, v2] = rects[angle] ?? rects[0];
  let uvs = [[u1, v1], [u2, v1], [u1, v2], [u2, v2]];
  for (let turn = 0; turn < angle; turn += 90) uvs = [uvs[2], uvs[0], uvs[3], uvs[1]];
  return uvs;
}

function addTriangle(out, corners, uvs, indices, fullbright) {
  const [a, b, c] = indices.map((i) => corners[i]);
  const normal = normalize(cross(subtract(b, a), subtract(c, a)));
  for (const i of indices) out.push(...corners[i], ...uvs[i], ...normal, fullbright);
}

function addShape(out, shape, center, rotation, bounds, stretchFactors = [1, 1, 1]) {
  const size = shapeSize(shape);
  const stretch = vector(shape.stretch, 1).map((s, i) => s * stretchFactors[i]);
  const half = size.map((s, i) => (s * stretch[i]) / 2);
  // A negative stretch mirrors the shape, which turns its triangles inside out.
  const mirrored = stretch[0] * stretch[1] * stretch[2] < 0;
  const fullbright = shape.shadingMode === 'fullbright' ? 1 : 0;
  const layouts = shape.textureLayout ?? {};
  const faces =
    shape.type === 'quad' ? [[QUAD_FACES[shape.settings?.normal ?? '+Z'], layouts.front]] : Object.entries(layouts);
  for (const [face, layout] of faces) {
    if (!layout || !FACES[face]) continue;
    const corners = FACES[face].map((corner) => add(center, rotate(rotation, corner.map((c, i) => c * half[i]))));
    for (const corner of corners) {
      for (let i = 0; i < 3; i++) {
        bounds.min[i] = Math.min(bounds.min[i], corner[i]);
        bounds.max[i] = Math.max(bounds.max[i], corner[i]);
      }
    }
    const uvs = faceUvs(layout, ...faceSize(face, size));
    const outward = mirrored ? [[0, 3, 2], [0, 1, 3]] : [[0, 2, 3], [0, 3, 1]];
    for (const indices of outward) addTriangle(out, corners, uvs, indices, fullbright);
    if (shape.doubleSided) {
      for (const indices of outward) addTriangle(out, corners, uvs, [...indices].reverse(), fullbright);
    }
  }
}

/**
 * Returns {vertices, count, nodes, min, max, bones}; min and max bound the drawn shapes in model units, and
 * bones maps each node name to its world {center, rotation}. `pose` maps node names to animation deltas
 * (see blockyanim.js samplePose); without it the model is in its rest pose.
 *
 * With `attachTo` (another model's bones) the model is an attachment: a root node named like a bone takes
 * that bone's place and turn, ignoring its own position, orientation and offset, as the Hytale Blockbench
 * plugin attaches pieces. Other roots stay where they are.
 */
export function buildModel(model, pose, attachTo) {
  const out = [];
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const bones = new Map();
  let nodes = 0;
  const visit = (node, parentCenter, parentRotation, bone) => {
    nodes++;
    const shape = node.shape ?? {};
    const animated = pose?.get(node.name) ?? {};
    let rotation;
    let center;
    let shapeCenter;
    if (bone) {
      rotation = bone.rotation;
      center = bone.center;
      shapeCenter = add(center, rotate(rotation, vector(shape.offset)));
    } else {
      const o = node.orientation ?? {};
      let local = normalize([o.x ?? 0, o.y ?? 0, o.z ?? 0, o.w ?? 1]);
      if (animated.orientation) local = multiplyQuaternions(local, animated.orientation);
      rotation = multiplyQuaternions(parentRotation, local);
      const position = add(vector(node.position), animated.position ?? [0, 0, 0]);
      const pivot = add(parentCenter, rotate(parentRotation, position));
      center = add(pivot, rotate(rotation, vector(shape.offset)));
      shapeCenter = center;
    }
    if (!bones.has(node.name)) bones.set(node.name, { center, rotation });
    if ((shape.type === 'box' || shape.type === 'quad') && (animated.visible ?? shape.visible !== false)) {
      addShape(out, shape, shapeCenter, rotation, bounds, animated.stretch);
    }
    for (const child of node.children ?? []) visit(child, center, rotation);
  };
  for (const node of model.nodes ?? []) visit(node, [0, 0, 0], [0, 0, 0, 1], attachTo?.get(node.name));
  if (out.length === 0) bounds.min = bounds.max = [0, 0, 0];
  return { vertices: new Float32Array(out), count: out.length / FLOATS_PER_VERTEX, nodes, ...bounds, bones };
}
