# Hytale particle viewer (proof of concept)

A static web page that lists every particle system in Hytale's `Assets.zip` and plays an
approximate live preview of each one in WebGL2. No dependencies beyond Python 3 and a browser.

## Use

```bash
python3 build_site.py                    # reads Assets.zip, writes site/data and site/assets
python3 -m http.server -d site 8000      # browsers refuse to fetch JSON from file:// pages
open http://localhost:8000
```

`build_site.py --assets <path>` points at a different `Assets.zip`; the default is the launcher
install at `~/Library/Application Support/Hytale/install/release/package/game/latest/Assets.zip`.
Re-run it after a game update.

The generated `site/data/` and `site/assets/` contain Hypixel's assets. They are git-ignored;
keep them on your machine and check Hytale's terms before publishing them anywhere.

## How it works

- `build_site.py` copies every `Server/Particles/**/*.particlesystem` and `*.particlespawner`
  into one JSON file and copies the textures they reference from `Common/`.
- `site/sim.js` simulates systems, spawners and particles from that JSON.
- `site/render.js` draws the particles as textured quads with an orbit camera.
- `site/app.js` is the list, the details panel and the controls.

Field meanings come from the documentation strings in the server's particle asset codecs
(`com/hypixel/hytale/server/core/asset/type/particle/config/*.java` in the decompiled server).

## Approximations

The game client draws particles and its code is not available, so the preview is a close
guess rather than an exact match. Known gaps:

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
