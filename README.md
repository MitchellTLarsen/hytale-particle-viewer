# Hytale effects viewer (proof of concept)

A static web page that browses Hytale's effects and models from `Assets.zip`, in four tabs:

- **Particles:** every particle system, with an approximate live preview in WebGL2.
- **Sounds:** every sound event, playable in the browser.
- **Screen:** camera shakes and view bobbing (applied to the preview camera) and the
  full-screen overlay images (fire, poison, spyglass and so on).
- **Models:** every `.blockymodel` (NPCs, characters, items, blocks, cosmetics) with its texture.

No dependencies beyond Python 3 and a browser.

## Use

```bash
python3 build_site.py                    # reads Assets.zip, writes site/data and site/assets
python3 -m http.server -d site 8000      # browsers refuse to fetch JSON from file:// pages
open http://localhost:8000
```

`build_site.py --assets <path>` points at a different `Assets.zip`; the default is the launcher
install at `~/Library/Application Support/Hytale/install/release/package/game/latest/Assets.zip`.
`--no-sounds` skips copying the sound files (about 210 MB); the Sounds tab still lists the
events but cannot play them. Re-run it after a game update.

The generated `site/data/` and `site/assets/` contain Hypixel's assets. They are git-ignored;
keep them on your machine and check Hytale's terms before publishing them anywhere.

## How it works

- `build_site.py` copies the effect and model assets into four JSON files and copies the
  textures, sound files and models they reference from `Common/`:
  - `particles.json`: `Server/Particles/**/*.particlesystem` and `*.particlespawner`.
  - `sounds.json`: `Server/Audio/SoundEvents/**/*.json`.
  - `screen.json`: `Server/Camera/**/*.json` (camera shakes, camera effects, view bobbing) and
    the `Common/ScreenEffects/*.png` overlays with the server assets that reference them.
  - `models.json`: every `Common/**/*.blockymodel` with its textures. A texture comes from the
    server or cosmetic assets that pair it with the model (`Texture`, `CustomModelTexture`,
    `GreyscaleTexture`), most used first; failing that, from images beside the model. Animations
    come from the `AnimationSets` of the `Server/Models` assets that use the model (inheriting
    from `Parent`). The model and animation files are copied to `site/assets/` and loaded when picked.
- `site/sim.js` simulates systems, spawners and particles from that JSON.
- `site/render.js` draws the particles as textured quads and the picked model, with an orbit camera.
- `site/sounds.js` is the Sounds tab; `site/screen.js` and `site/shake.js` are the Screen tab;
  `site/models.js`, `site/blockymodel.js` and `site/blockyanim.js` are the Models tab.
- `site/app.js` is the tabs, the list, the particle details and the controls.

Field meanings come from the documentation strings in the server's asset codecs in the
decompiled server: particles in `com/hypixel/hytale/server/core/asset/type/particle/config/`,
sounds in `server/core/asset/type/soundevent/config/`, camera in `builtin/adventure/camera/asset/`.
The `.blockymodel` layout follows how the Hytale Blockbench plugin
(github.com/JannisX11/hytale-blockbench-plugin) reads it; node transforms also match the
server's `server/core/asset/type/model/BlockyModelBoundsParser.java`.

## Approximations

The game client draws particles and plays sounds and camera effects, and its code is not
available, so the previews are close guesses rather than exact matches. Known gaps:

### Particles

- **Units:** scale is read as blocks; `DampingMultiplier` is read as velocity kept per second.
- **Erosion:** opacity is treated as an alpha cut-off with a soft edge; the in-game glow is not drawn.
- **Distortion:** drawn as a faint grey ghost instead of bending the scene behind it.
- **Not simulated:** `UVMotion` flow maps, soft particles, lighting, block collision,
  intersection highlight, velocity stretch, sprite-frame blending, trail multipliers (the
  preview never moves the system), camera fades.
- **Timing rules:** a burst with no `WaveDelay` fires once; a burst with no `SpawnRate`
  releases its whole `TotalParticles`; a `MaxConcurrentParticles` of 0 means the 512 cap.
- **Duplicate ids:** some ids exist in two folders (usually a `_Test` copy); spawners resolve
  to the one in the system's own top folder first.

### Sounds

- Volume (decibels), pitch (semitones), random ranges, `Probability`, `StartDelay` and
  `Looping` follow the codec docs. Fields left out of an event come from its `Parent`.
- The Volume slider scales every sound; it starts at 25% and the browser remembers it.
- Volume above 0 dB plays at full slider volume (an `<audio>` element cannot go louder).
- **Not simulated:** distance attenuation and 3D position, `SpatialBlend`, audio categories,
  ducking, state bindings, `MaxInstance`, round-robin, `FadeIn`, `MaxStartOffset`,
  `ProbabilityRerollDelay`.
- The files are Ogg Vorbis. If a browser cannot play them, the Sounds tab says so; Chrome and
  Firefox can.

### Screen

- **Units:** `Frequency` is read as radians per second, offsets as blocks and rotations as
  radians, all scaled by the intensity. The intensity defaults to the matching camera
  effect's `Value` (most are 0.05), or 1 when there is none; the box in the details panel
  changes it.
- **Noise:** `Perlin_*` types are one simple 1D gradient noise; easings other than `Linear`
  and `QuadInOut` (the only two in the data) play as `Linear`.
- **View bobbing** plays continuously, as if the player kept moving that way.
- **Camera:** first and third person profiles both shake the same orbit camera.
- **Overlays** are drawn at full opacity, stretched to cover the preview. In game, effects may
  fade, pulse or tint them.
- Weather colour filters and screen tints (`ColorFilters`, `ScreenEffectColors` in
  `Server/Weathers`) are not shown.

### Models

- **Scale:** models under `Blocks/` use 32 units per block, all others 64. The second figure
  comes from the player model's height against its 1.85-block hitbox.
- **Animations:** off by default; the Animate box plays the picked animation set (202 models
  have some). Only the first animation of each set is offered, and when several model assets
  share a model and name the same set, the first by id wins. `smooth` keyframes are read as
  Catmull-Rom curves, orientations as quaternions on top of the rest pose, `shapeStretch` as
  stretch factors on the node's own shape. Blending between animations, `shapeUvOffset`
  (unused in the data) and animation speed changes in game are not reproduced.
- **Bare models:** attachments (hair, faces, gear from `Server/Models` `DefaultAttachments`)
  are not added, so a base character can look incomplete; the player's head has no front face
  because the face is an attachment.
- **Colour:** greyscale textures are drawn grey; gradient tints (`GradientSet`) are not applied.
- **Look:** one fixed light; `shadingMode` is only honoured for `fullbright`. Pixels under half
  opacity are cut out, so glass-like parts are either solid or missing.
- 326 models have no texture to be found (mostly block structures that take their block's
  textures) and are drawn grey.
