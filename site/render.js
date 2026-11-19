// WebGL2 renderer: an orbit camera, a ground grid, camera-facing particle quads and one model.
// Quads are built on the CPU each frame, which keeps every ParticleRotationInfluence mode simple.

import { FLOATS_PER_VERTEX as MODEL_FLOATS_PER_VERTEX } from './blockymodel.js';
import { apply3, cross, mat3FromEuler, mul3, normalize, particleLook } from './sim.js';

const PARTICLE_VERTEX = `#version 300 es
in vec3 aPosition;
in vec2 aUv;
in vec4 aColor;
uniform mat4 uViewProjection;
out vec2 vUv;
out vec4 vColor;
void main() {
  vUv = aUv;
  vColor = aColor;
  gl_Position = uViewProjection * vec4(aPosition, 1.0);
}`;

// Output is premultiplied and blended with (ONE, ONE_MINUS_SRC_ALPHA); writing alpha 0 makes
// the same blend state additive, so all modes share one pipeline.
const PARTICLE_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 vUv;
in vec4 vColor;
uniform sampler2D uTexture;
uniform int uMode; // 0 BlendLinear, 1 BlendAdd, 2 Erosion, 3 Distortion
out vec4 outColor;
void main() {
  vec4 texel = texture(uTexture, vUv);
  vec3 rgb = texel.rgb * vColor.rgb;
  float alpha = texel.a * vColor.a;
  if (uMode == 2) {
    // Erosion "cuts off transparent parts instead" of fading: opacity is an alpha threshold.
    alpha = texel.a * clamp((texel.a - (1.0 - vColor.a)) / 0.2, 0.0, 1.0);
  } else if (uMode == 3) {
    // Distortion bends the scene behind it; shown as a faint grey ghost instead.
    rgb = vec3(0.8);
    alpha *= 0.25;
  }
  outColor = vec4(rgb * alpha, uMode == 1 ? 0.0 : alpha);
}`;

const LINE_VERTEX = `#version 300 es
in vec3 aPosition;
uniform mat4 uViewProjection;
void main() { gl_Position = uViewProjection * vec4(aPosition, 1.0); }`;

const LINE_FRAGMENT = `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }`;

// Models: positions in model units scaled to blocks, UVs in texture pixels, a fixed light from above.
const MODEL_VERTEX = `#version 300 es
in vec3 aPosition;
in vec2 aUv;
in vec3 aNormal;
in float aFullbright;
uniform mat4 uViewProjection;
uniform float uScale;
out vec2 vUv;
out float vLight;
void main() {
  vUv = aUv;
  float diffuse = max(dot(aNormal, normalize(vec3(0.4, 1.0, 0.6))), 0.0);
  vLight = mix(0.55 + 0.45 * diffuse, 1.0, aFullbright);
  gl_Position = uViewProjection * vec4(aPosition * uScale, 1.0);
}`;

const MODEL_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 vUv;
in float vLight;
uniform sampler2D uTexture;
uniform vec2 uTextureSize;
uniform bool uTextured;
out vec4 outColor;
void main() {
  vec4 texel = uTextured ? texture(uTexture, vUv / uTextureSize) : vec4(0.7, 0.7, 0.7, 1.0);
  if (texel.a < 0.5) discard;
  outColor = vec4(texel.rgb * vLight, 1.0);
}`;

const RENDER_MODES = { BlendLinear: 0, BlendAdd: 1, Erosion: 2, Distortion: 3 };
const MODEL_ATTRIBUTES = [['aPosition', 3, 0], ['aUv', 2, 12], ['aNormal', 3, 20], ['aFullbright', 1, 32]];
const FLOATS_PER_VERTEX = 9; // position 3, uv 2, colour 4
const VERTICES_PER_PARTICLE = 6;
const GRID_HALF_SIZE = 8;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.particleProgram = createProgram(gl, PARTICLE_VERTEX, PARTICLE_FRAGMENT);
    this.lineProgram = createProgram(gl, LINE_VERTEX, LINE_FRAGMENT);
    this.textures = new Map();
    this.samplers = { nearest: createSampler(gl, gl.NEAREST), linear: createSampler(gl, gl.LINEAR) };
    this.camera = { yaw: 35, pitch: 20, distance: 7, target: [0, 0.75, 0] };
    this.background = [0.106, 0.114, 0.133];
    this.showGrid = true;
    this.shake = null;
    this.vertexData = new Float32Array(FLOATS_PER_VERTEX * VERTICES_PER_PARTICLE * 1024);
    this.particleBuffer = gl.createBuffer();
    this.particleVao = this.createParticleVao();
    this.gridVertexCount = 0;
    this.gridVao = this.createGridVao();
    // Model parts to draw, set with setModels: [{mesh, texture, scale}], mesh as built by blockymodel.js. A part
    // whose mesh is replaced (animation) is uploaded again on the next draw.
    this.models = [];
    this.modelProgram = createProgram(gl, MODEL_VERTEX, MODEL_FRAGMENT);
    this.modelVao = this.createModelVao();
  }

  setModels(parts) {
    for (const part of this.models) if (part.buffer && !parts.includes(part)) this.gl.deleteBuffer(part.buffer);
    this.models = parts;
  }

  // Loads `assets/<path>` once; returns the entry, which has `ready` once the image arrives.
  texture(path) {
    let entry = this.textures.get(path);
    if (entry) return entry;
    entry = { ready: false, failed: false, width: 1, height: 1, handle: null };
    this.textures.set(path, entry);
    const image = new Image();
    image.onload = () => {
      const gl = this.gl;
      entry.handle = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, entry.handle);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      entry.width = image.naturalWidth;
      entry.height = image.naturalHeight;
      entry.ready = true;
    };
    image.onerror = () => {
      entry.failed = true;
      console.warn('Texture failed to load:', path);
    };
    image.src = 'assets/' + path;
    return entry;
  }

  /** Draws the grid, the model parts and `systems` (particle system instances). */
  draw(systems = []) {
    const gl = this.gl;
    this.resize();
    gl.clearColor(...this.background, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const { viewProjection, eye, right, up } = this.cameraMatrices();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (this.showGrid) this.drawGrid(viewProjection);
    for (const part of this.models) this.drawModel(part, viewProjection);
    if (systems.length === 0) return;

    gl.useProgram(this.particleProgram.program);
    gl.uniformMatrix4fv(this.particleProgram.uniforms.uViewProjection, false, viewProjection);
    gl.uniform1i(this.particleProgram.uniforms.uTexture, 0);
    gl.bindVertexArray(this.particleVao);
    for (const group of systems.flatMap((system) => system.groups)) {
      if (group.hidden || !group.compiled?.texture) continue;
      const texture = this.texture(group.compiled.texture);
      if (!texture.ready) continue;
      for (const instance of group.instances) {
        this.drawInstance(instance, texture, eye, right, up);
      }
    }
    gl.bindVertexArray(null);
  }

  drawInstance(instance, texture, eye, cameraRight, cameraUp) {
    const gl = this.gl;
    const compiled = instance.compiled;
    const particles = instance.particles;
    if (particles.length === 0) return;
    if (compiled.renderMode !== 'BlendAdd') {
      // Back to front, so alpha-blended particles overlap correctly.
      const distance = (p) => (p.position[0] - eye[0]) ** 2 + (p.position[1] - eye[1]) ** 2 + (p.position[2] - eye[2]) ** 2;
      particles.sort((a, b) => distance(b) - distance(a));
    }
    const needed = particles.length * VERTICES_PER_PARTICLE * FLOATS_PER_VERTEX;
    if (this.vertexData.length < needed) this.vertexData = new Float32Array(needed * 2);
    const data = this.vertexData;
    const frames = frameGrid(compiled.frameSize, texture);
    let offset = 0;
    for (const p of particles) {
      const look = particleLook(compiled, p);
      const [right, up] = quadAxes(compiled, instance, p, look, eye, cameraRight, cameraUp);
      const frame = Math.min(Math.max(look.frame, 0), frames.count - 1);
      let u0 = (frame % frames.columns) * frames.u;
      let v0 = Math.floor(frame / frames.columns) * frames.v;
      let u1 = u0 + frames.u;
      let v1 = v0 + frames.v;
      if (p.flipU) [u0, u1] = [u1, u0];
      if (p.flipV) [v0, v1] = [v1, v0];
      const halfX = look.sizeX / 2;
      const halfY = look.sizeY / 2;
      const corner = (sx, sy) => [0, 1, 2].map((i) => p.position[i] + right[i] * sx * halfX + up[i] * sy * halfY);
      const bottomLeft = corner(-1, -1);
      const bottomRight = corner(1, -1);
      const topRight = corner(1, 1);
      const topLeft = corner(-1, 1);
      const color = [look.color[0], look.color[1], look.color[2], Math.min(Math.max(look.opacity, 0), 1)];
      const vertex = (position, u, v) => {
        data.set(position, offset);
        data[offset + 3] = u;
        data[offset + 4] = v;
        data.set(color, offset + 5);
        offset += FLOATS_PER_VERTEX;
      };
      vertex(bottomLeft, u0, v1);
      vertex(bottomRight, u1, v1);
      vertex(topRight, u1, v0);
      vertex(bottomLeft, u0, v1);
      vertex(topRight, u1, v0);
      vertex(topLeft, u0, v0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, offset), gl.STREAM_DRAW);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture.handle);
    gl.bindSampler(0, compiled.linearFiltering ? this.samplers.linear : this.samplers.nearest);
    gl.uniform1i(this.particleProgram.uniforms.uMode, RENDER_MODES[compiled.renderMode] ?? 0);
    gl.drawArrays(gl.TRIANGLES, 0, offset / FLOATS_PER_VERTEX);
  }

  drawModel(part, viewProjection) {
    const gl = this.gl;
    const { mesh, texture, scale } = part;
    const image = texture ? this.texture(texture) : null;
    if (image && !image.ready && !image.failed) return;
    part.buffer ??= gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, part.buffer);
    if (part.uploaded !== mesh) {
      gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
      part.uploaded = mesh;
    }
    const uniforms = this.modelProgram.uniforms;
    gl.useProgram(this.modelProgram.program);
    gl.uniformMatrix4fv(uniforms.uViewProjection, false, viewProjection);
    gl.uniform1f(uniforms.uScale, scale);
    gl.uniform1i(uniforms.uTextured, image?.ready ? 1 : 0);
    if (image?.ready) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, image.handle);
      gl.bindSampler(0, this.samplers.nearest);
      gl.uniform1i(uniforms.uTexture, 0);
      gl.uniform2f(uniforms.uTextureSize, image.width, image.height);
    }
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(this.modelVao);
    this.pointModelAttributes();
    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
  }

  drawGrid(viewProjection) {
    const gl = this.gl;
    gl.useProgram(this.lineProgram.program);
    gl.uniformMatrix4fv(this.lineProgram.uniforms.uViewProjection, false, viewProjection);
    gl.uniform4f(this.lineProgram.uniforms.uColor, 0.12, 0.12, 0.12, 0.12);
    gl.bindVertexArray(this.gridVao);
    gl.drawArrays(gl.LINES, 0, this.gridVertexCount);
    gl.bindVertexArray(null);
  }

  cameraMatrices() {
    const { yaw, pitch, distance, target } = this.camera;
    const cp = Math.cos((pitch * Math.PI) / 180);
    const eye = [
      target[0] + distance * cp * Math.sin((yaw * Math.PI) / 180),
      target[1] + distance * Math.sin((pitch * Math.PI) / 180),
      target[2] + distance * cp * Math.cos((yaw * Math.PI) / 180),
    ];
    let view = lookAt(eye, target, [0, 1, 0]);
    if (this.shake) view = multiply4(shakeMatrix(this.shake), view);
    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    const projection = perspective(50, aspect, 0.05, 500);
    // Column-major view matrix: rows of its rotation part are the camera axes.
    const right = [view[0], view[4], view[8]];
    const up = [view[1], view[5], view[9]];
    return { viewProjection: multiply4(projection, view), eye, right, up };
  }

  resize() {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(this.canvas.clientWidth * ratio);
    const height = Math.round(this.canvas.clientHeight * ratio);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, width, height);
  }

  createParticleVao() {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
    const stride = FLOATS_PER_VERTEX * 4;
    const attributes = this.particleProgram.attributes;
    gl.enableVertexAttribArray(attributes.aPosition);
    gl.vertexAttribPointer(attributes.aPosition, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(attributes.aUv);
    gl.vertexAttribPointer(attributes.aUv, 2, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(attributes.aColor);
    gl.vertexAttribPointer(attributes.aColor, 4, gl.FLOAT, false, stride, 20);
    gl.bindVertexArray(null);
    return vao;
  }

  createModelVao() {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    for (const name of MODEL_ATTRIBUTES.map(([attribute]) => attribute)) gl.enableVertexAttribArray(this.modelProgram.attributes[name]);
    gl.bindVertexArray(null);
    return vao;
  }

  // Each part has its own buffer, so the attribute layout is pointed at the bound buffer before drawing.
  pointModelAttributes() {
    const gl = this.gl;
    const stride = MODEL_FLOATS_PER_VERTEX * 4;
    for (const [name, size, offset] of MODEL_ATTRIBUTES) {
      gl.vertexAttribPointer(this.modelProgram.attributes[name], size, gl.FLOAT, false, stride, offset);
    }
  }

  createGridVao() {
    const gl = this.gl;
    const lines = [];
    for (let i = -GRID_HALF_SIZE; i <= GRID_HALF_SIZE; i++) {
      lines.push(i, 0, -GRID_HALF_SIZE, i, 0, GRID_HALF_SIZE, -GRID_HALF_SIZE, 0, i, GRID_HALF_SIZE, 0, i);
    }
    this.gridVertexCount = lines.length / 3;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.lineProgram.attributes.aPosition);
    gl.vertexAttribPointer(this.lineProgram.attributes.aPosition, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }
}

// ---------------------------------------------------------------- quad orientation

function rotateInPlane(right, up, degrees) {
  if (!degrees) return [right, up];
  const c = Math.cos((degrees * Math.PI) / 180);
  const s = Math.sin((degrees * Math.PI) / 180);
  return [
    [0, 1, 2].map((i) => right[i] * c + up[i] * s),
    [0, 1, 2].map((i) => up[i] * c - right[i] * s),
  ];
}

// Right and up vectors of a particle's quad for its ParticleRotationInfluence.
function quadAxes(compiled, instance, p, look, eye, cameraRight, cameraUp) {
  const toCamera = normalize([0, 1, 2].map((i) => eye[i] - p.position[i]));
  const motion = normalize(p.motion);
  const moving = motion[0] !== 0 || motion[1] !== 0 || motion[2] !== 0;
  switch (compiled.rotationInfluence) {
    case 'Billboard':
      return rotateInPlane(cameraRight, cameraUp, look.rotation[2]);
    case 'BillboardY': {
      const up = [0, 1, 0];
      return rotateInPlane(normalize(cross(up, toCamera)), up, look.rotation[2]);
    }
    case 'BillboardVelocity': {
      if (!moving) return rotateInPlane(cameraRight, cameraUp, look.rotation[2]);
      // Long axis follows the motion as seen on screen.
      const along = motion[0] * toCamera[0] + motion[1] * toCamera[1] + motion[2] * toCamera[2];
      const up = normalize([0, 1, 2].map((i) => motion[i] - toCamera[i] * along));
      if (up[0] === 0 && up[1] === 0 && up[2] === 0) return [cameraRight, cameraUp];
      return [normalize(cross(up, toCamera)), up];
    }
    case 'Velocity': {
      if (!moving) return [cameraRight, cameraUp];
      const side = Math.abs(motion[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
      return [normalize(cross(motion, side)), motion];
    }
    default: {
      // None: fixed in the world, turned by the particle's Rotation (degrees).
      let m = mat3FromEuler(look.rotation[0], look.rotation[1], look.rotation[2]);
      if (compiled.def.ParticleRotateWithSpawner) m = mul3(instance.rotation, m);
      return [apply3(m, [1, 0, 0]), apply3(m, [0, 1, 0])];
    }
  }
}

// Sprite sheet layout: FrameSize cuts the texture into frames, numbered left to right, top to bottom.
function frameGrid(frameSize, texture) {
  if (!frameSize) return { columns: 1, count: 1, u: 1, v: 1 };
  const columns = Math.max(1, Math.floor(texture.width / frameSize[0]));
  const rows = Math.max(1, Math.floor(texture.height / frameSize[1]));
  return { columns, count: columns * rows, u: frameSize[0] / texture.width, v: frameSize[1] / texture.height };
}

// ---------------------------------------------------------------- WebGL helpers

function createProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexSource],
    [gl.FRAGMENT_SHADER, fragmentSource],
  ]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  const attributes = {};
  for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES); i++) {
    const name = gl.getActiveAttrib(program, i).name;
    attributes[name] = gl.getAttribLocation(program, name);
  }
  const uniforms = {};
  for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
    const name = gl.getActiveUniform(program, i).name;
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return { program, attributes, uniforms };
}

function createSampler(gl, filter) {
  const sampler = gl.createSampler();
  gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, filter);
  gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, filter);
  gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return sampler;
}

// 4x4 matrices are column-major Float32Arrays, as WebGL expects.
function perspective(fovDegrees, aspect, near, far) {
  const f = 1 / Math.tan((fovDegrees * Math.PI) / 360);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

function lookAt(eye, target, worldUp) {
  const z = normalize([0, 1, 2].map((i) => eye[i] - target[i]));
  const x = normalize(cross(worldUp, z));
  const y = cross(z, x);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// Axis 0, 1, 2 = x, y, z.
function rotation(axis, radians) {
  const out = identity();
  const [a, b] = [[1, 2], [2, 0], [0, 1]][axis];
  out[a * 5] = out[b * 5] = Math.cos(radians);
  out[a * 4 + b] = Math.sin(radians);
  out[b * 4 + a] = -Math.sin(radians);
  return out;
}

// The shake moves the camera in its own space, so the view matrix gets the inverse move first.
function shakeMatrix({ offset, pitch, yaw, roll }) {
  const move = identity();
  move.set([-offset[0], -offset[1], -offset[2]], 12);
  return [rotation(1, -yaw), rotation(0, -pitch), rotation(2, -roll)].reduce((m, r) => multiply4(r, m), move);
}

function multiply4(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}
