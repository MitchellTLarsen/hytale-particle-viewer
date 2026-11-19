#!/usr/bin/env python3
"""Build the effects viewer data from a Hytale Assets.zip.

Writes three files to site/data/:
- particles.json: every .particlesystem and .particlespawner under Server/Particles/.
- sounds.json: every sound event under Server/Audio/SoundEvents/.
- screen.json: camera shakes, camera effects and view bobbing under Server/Camera/, plus the
  screen overlay images in Common/ScreenEffects/ and the server assets that use them.
It also copies the textures and sound files those reference into site/assets/. The output
contains Hypixel's assets, so it stays on this machine (see .gitignore).
"""
import argparse
import json
import zipfile
from pathlib import Path, PurePosixPath

DEFAULT_ZIP = (
    Path.home() / "Library/Application Support/Hytale/install/release/package/game/latest/Assets.zip"
)
PARTICLES_ROOT = "Server/Particles/"
SOUNDS_ROOT = "Server/Audio/SoundEvents/"
CAMERA_ROOT = "Server/Camera/"
OVERLAYS_ROOT = "Common/ScreenEffects/"
COMMON_ROOT = "Common/"
SYSTEM_SUFFIX = ".particlesystem"
SPAWNER_SUFFIX = ".particlespawner"
# Large folders that never reference screen overlays; skipping them keeps the scan fast.
SCAN_SKIP = ("Server/Prefabs/", "Server/World/", "Server/HytaleGenerator/")


def main():
    parser = argparse.ArgumentParser(description="Build the effects viewer data.")
    parser.add_argument("--assets", type=Path, default=DEFAULT_ZIP, help="path to Assets.zip")
    parser.add_argument("--out", type=Path, default=Path(__file__).parent / "site", help="site folder")
    parser.add_argument("--no-sounds", action="store_true", help="skip copying the ~200 MB of sound files")
    args = parser.parse_args()

    problems = []
    assets_dir = args.out / "assets"
    with zipfile.ZipFile(args.assets) as assets:
        names = set(assets.namelist())
        systems = read_assets(assets, names, PARTICLES_ROOT, SYSTEM_SUFFIX, problems)
        spawners = read_assets(assets, names, PARTICLES_ROOT, SPAWNER_SUFFIX, problems)
        check_spawner_refs(systems, spawners, problems)
        textures = {s["data"].get("Particle", {}).get("Texture") for s in spawners}
        copied = copy_files(assets, names, textures, assets_dir, problems)

        sounds = read_assets(assets, names, SOUNDS_ROOT, ".json", problems)
        if not args.no_sounds:
            files = {f for s in sounds for layer in s["data"].get("Layers", []) for f in layer.get("Files", [])}
            copied += copy_files(assets, names, files, assets_dir, problems)

        camera = read_assets(assets, names, CAMERA_ROOT, ".json", problems)
        overlays = read_overlays(assets, names)
        copied += copy_files(assets, names, {o["texture"] for o in overlays}, assets_dir, problems)

    data_dir = args.out / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    write_json(data_dir / "particles.json", {"systems": systems, "spawners": spawners, "problems": problems})
    write_json(data_dir / "sounds.json", {"sounds": sounds})
    write_json(data_dir / "screen.json", {"camera": camera, "overlays": overlays})

    print(
        f"{len(systems)} systems, {len(spawners)} spawners, {len(sounds)} sound events, "
        f"{len(camera)} camera assets, {len(overlays)} overlays, {copied} files -> {args.out}"
    )
    for problem in problems:
        print("WARNING:", problem)


def write_json(path, data):
    path.write_text(json.dumps(data, separators=(",", ":")))


def read_assets(assets, names, root, suffix, problems):
    """Return [{id, path, data}] where path is relative to root without the suffix."""
    entries = []
    for name in sorted(n for n in names if n.startswith(root) and n.endswith(suffix)):
        path = name[len(root) : -len(suffix)]
        try:
            data = json.loads(assets.read(name))
        except (ValueError, UnicodeDecodeError) as error:
            problems.append(f"{name}: unreadable JSON ({error})")
            continue
        entries.append({"id": PurePosixPath(path).name, "path": path, "data": data})
    return entries


def check_spawner_refs(systems, spawners, problems):
    known = {spawner["id"] for spawner in spawners}
    for system in systems:
        for group in system["data"].get("Spawners", []):
            spawner_id = group.get("SpawnerId")
            if spawner_id not in known:
                problems.append(f"{system['path']}: unknown SpawnerId {spawner_id!r}")


def read_overlays(assets, names):
    """Return [{id, path, texture, usedBy}] for each screen overlay image."""
    textures = sorted(n[len(COMMON_ROOT) :] for n in names if n.startswith(OVERLAYS_ROOT) and n.endswith(".png"))
    used_by = {texture: [] for texture in textures}
    for name in sorted(n for n in names if n.startswith("Server/") and n.endswith(".json")):
        if name.startswith(SCAN_SKIP):
            continue
        text = assets.read(name).decode("utf-8", "replace")
        if "ScreenEffects/" not in text:
            continue
        for texture in textures:
            if texture in text:
                used_by[texture].append(name)
    return [
        {"id": PurePosixPath(t).stem, "path": t.removesuffix(".png"), "texture": t, "usedBy": used_by[t]}
        for t in textures
    ]


def copy_files(assets, names, files, out_dir, problems):
    """Copy Common/<file> to out_dir/<file> for each file path taken from asset data."""
    copied = 0
    for file in sorted(f for f in files if f):
        relative = PurePosixPath(file)
        # Paths come from asset data; refuse anything that could escape out_dir.
        if relative.is_absolute() or ".." in relative.parts:
            problems.append(f"file {file!r}: unsafe path, skipped")
            continue
        source = COMMON_ROOT + file
        if source not in names:
            problems.append(f"file {file!r}: not in Assets.zip")
            continue
        target = out_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(assets.read(source))
        copied += 1
    return copied


if __name__ == "__main__":
    main()
