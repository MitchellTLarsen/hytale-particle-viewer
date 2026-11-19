# Hytale effects viewer (proof of concept)

A static web page that browses Hytale's effects and models from `Assets.zip`, in four tabs:

- **Particles:** every particle system, with an approximate live preview in WebGL2.
- **Sounds:** every sound event, playable in the browser.
- **Screen:** camera shakes and view bobbing (applied to the preview camera) and the
  full-screen overlay images (fire, poison, spyglass and so on).
- **Models:** every `.blockymodel` (NPCs, characters, items, blocks, cosmetics) with its texture
  and animations.
- **Assets:** every server and cosmetic JSON asset (NPC roles, model assets, items, interactions,
  entity effects, drops, spawns and so on), plus each trigger volume in an instance on its own.
  NPC roles, interactions and trigger volumes also get a plain-English card: a role's states and
  rules ("When state is Idle and a player is within 64 blocks in line of sight: start timer..."),
  an interaction's steps, a volume's rules by event with their delays.

A **Used by** panel on the right lists the server assets that use the picked item (NPC roles,
items and blocks, interactions, entity effects, trigger volumes and so on), when there are any;
each entry opens in the Assets tab. In every JSON view, names of things the viewer can show are
links: a role's `Appearance` opens its model asset, the asset's `Model` opens the model, an
interaction's `SystemId` opens the particle system, and so on.

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

- `build_site.py` copies the effect and model assets into six JSON files, copies the textures,
  sound files and models they reference from `Common/`, and copies every scanned server and
  cosmetic JSON file to `site/data/json/` for the Assets tab:
  - `particles.json`: `Server/Particles/**/*.particlesystem` and `*.particlespawner`.
  - `sounds.json`: `Server/Audio/SoundEvents/**/*.json`.
  - `screen.json`: `Server/Camera/**/*.json` (camera shakes, camera effects, view bobbing) and
    the `Common/ScreenEffects/*.png` overlays.
  - `references.json`: for each particle system, sound event, camera asset, model, model asset,
    overlay and server asset, the server and cosmetic assets that mention it (trigger volumes in
    instances by volume name). `Server/Prefabs`, `Server/World` and `Server/HytaleGenerator` are
    not scanned.
  - `assets.json`: the list for the Assets tab.
  - `models.json`: every `Common/**/*.blockymodel` with its textures. A texture comes from the
    server or cosmetic assets that pair it with the model (`Texture`, `CustomModelTexture`,
    `GreyscaleTexture`), most used first; failing that, from images beside the model. Animations
    come from the `AnimationSets` of the `Server/Models` assets that use the model (inheriting
    from `Parent`). The model and animation files are copied to `site/assets/` and loaded when picked.
- `site/sim.js` simulates systems, spawners and particles from that JSON.
- `site/render.js` draws the particles as textured quads and the picked model, with an orbit camera.
- `site/sounds.js` is the Sounds tab; `site/screen.js` and `site/shake.js` are the Screen tab;
  `site/models.js`, `site/blockymodel.js` and `site/blockyanim.js` are the Models tab.
- `site/assets.js` is the Assets tab, `site/behaviour.js` its cards, `site/related.js` the Used
  by panel and `site/links.js` the linked JSON views.
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
  share a model and name the same set, the first by id wins. Looping animations wrap from each
  track's last keyframe round to its first, since most looping tracks stop well before the
  animation's end. `smooth` keyframes are read as Catmull-Rom curves with tangents scaled to
  the keyframe spacing, orientations as quaternions on top of the rest pose, `shapeStretch` as
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

### Used by

- Model files and overlays match by path. Ids of particle systems, sound events, camera assets
  and model assets only count under a key that names their kind (`System`/`Particle`, `Sound`,
  `Camera`/`Shake`/`Bobbing`, `Appearance`/`Model`), so a reference under another key is missed.
- NPC roles reach a model through a model asset: the role's `Appearance` names the asset, the
  asset's `Model` names the file. Roles that only inherit an appearance from a template are not
  linked to it.
- Server assets are named by their file name, which is not unique (1346 names are shared, such
  as a role and its model asset). An asset name counts when it has an underscore, or under an
  id-like key (`...Id`, `Parent`, `Reference`, `Appearance`). So "used by" can list a file that
  meant another asset of the same name, and a link to a shared name opens the folder the key
  suggests (`NpcType` a role, `Appearance` a model asset and so on), else the first match.

### Behaviour cards

- Rule order follows the server's instruction docs: the first rule whose sensor holds runs and
  ends the list unless it has `Continue` ("then keeps checking the next rules").
- The wording for sensors and actions ("a player is within 24 blocks in line of sight", "start
  timer ... at 30 s") is read from their parameter names, not from the server code. Types
  without wording show as their type and parameters; `‹Name›` is a template parameter.
- A rule that uses a shared component (`Reference`) links to it rather than expanding it.
- A trigger volume's effects run when the conditions with the same event and `Entry` pass
  (verified in the server's `TriggerVolumeTickingSystem`); "rule 2" is `Entry` 1.
