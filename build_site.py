#!/usr/bin/env python3
"""Build the particle viewer data from a Hytale Assets.zip.

Reads every .particlesystem and .particlespawner under Server/Particles/, writes them to
site/data/particles.json and copies the particle textures they reference into site/assets/.
The output contains Hypixel's assets, so it stays on this machine (see .gitignore).
"""
import argparse
import json
import zipfile
from pathlib import Path, PurePosixPath

DEFAULT_ZIP = (
    Path.home() / "Library/Application Support/Hytale/install/release/package/game/latest/Assets.zip"
)
PARTICLES_ROOT = "Server/Particles/"
TEXTURES_ROOT = "Common/"
SYSTEM_SUFFIX = ".particlesystem"
SPAWNER_SUFFIX = ".particlespawner"


def main():
    parser = argparse.ArgumentParser(description="Build the particle viewer data.")
    parser.add_argument("--assets", type=Path, default=DEFAULT_ZIP, help="path to Assets.zip")
    parser.add_argument("--out", type=Path, default=Path(__file__).parent / "site", help="site folder")
    args = parser.parse_args()

    problems = []
    with zipfile.ZipFile(args.assets) as assets:
        names = set(assets.namelist())
        systems = read_assets(assets, names, SYSTEM_SUFFIX, problems)
        spawners = read_assets(assets, names, SPAWNER_SUFFIX, problems)
        check_spawner_refs(systems, spawners, problems)
        copied = copy_textures(assets, names, spawners, args.out / "assets", problems)

    data_dir = args.out / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    data = {"systems": systems, "spawners": spawners, "problems": problems}
    (data_dir / "particles.json").write_text(json.dumps(data, separators=(",", ":")))

    print(f"{len(systems)} systems, {len(spawners)} spawners, {copied} textures -> {args.out}")
    for problem in problems:
        print("WARNING:", problem)


def read_assets(assets, names, suffix, problems):
    """Return [{id, path, data}] where path is relative to Server/Particles without the suffix."""
    entries = []
    for name in sorted(n for n in names if n.startswith(PARTICLES_ROOT) and n.endswith(suffix)):
        path = name[len(PARTICLES_ROOT) : -len(suffix)]
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


def copy_textures(assets, names, spawners, out_dir, problems):
    textures = {s["data"].get("Particle", {}).get("Texture") for s in spawners}
    copied = 0
    for texture in sorted(t for t in textures if t):
        relative = PurePosixPath(texture)
        # Texture paths come from asset data; refuse anything that could escape out_dir.
        if relative.is_absolute() or ".." in relative.parts:
            problems.append(f"texture {texture!r}: unsafe path, skipped")
            continue
        source = TEXTURES_ROOT + texture
        if source not in names:
            problems.append(f"texture {texture!r}: not in Assets.zip")
            continue
        target = out_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(assets.read(source))
        copied += 1
    return copied


if __name__ == "__main__":
    main()
