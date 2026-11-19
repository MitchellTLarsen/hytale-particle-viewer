#!/usr/bin/env python3
"""Build the effects viewer data from a Hytale Assets.zip.

Writes these files to site/data/ (and the converted prefabs to site/data/prefabs/):
- particles.json: every .particlesystem and .particlespawner under Server/Particles/.
- sounds.json: every sound event under Server/Audio/SoundEvents/.
- screen.json: camera shakes, camera effects and view bobbing under Server/Camera/, plus the
  screen overlay images in Common/ScreenEffects/ and the server assets that use them.
- models.json: every .blockymodel in Common/ with the textures it is drawn with.
- prefabs.json: the prefabs under Server/Prefabs/ (each converted to data/prefabs/) and the block types
  they are built from.
It also copies the textures, sound files and models those reference into site/assets/. The
output contains Hypixel's assets, so it stays on this machine (see .gitignore).
"""
import argparse
import collections
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
MODEL_ASSETS_ROOT = "Server/Models/"
PREFABS_ROOT = "Server/Prefabs/"
PREFAB_SUFFIX = ".prefab.json"
# Bigger prefabs (59 of 9,282, up to 24 MB) are listed but not converted; they are too heavy to view.
PREFAB_MAX_BYTES = 5_000_000
SYSTEM_SUFFIX = ".particlesystem"
SPAWNER_SUFFIX = ".particlespawner"
MODEL_SUFFIX = ".blockymodel"
# Keys that sit beside a model path and name its texture (items and models, blocks, cosmetics).
TEXTURE_KEYS = ("Texture", "CustomModelTexture", "GreyscaleTexture")
# A reference to an id of each kind counts only under a key containing one of these words.
REFERENCE_KEY_HINTS = {
    "particle": ("System", "Particle"),
    "sound": ("Sound",),
    "camera": ("Camera", "Shake", "Bobbing"),
    "modelAsset": ("Appearance", "Model"),
}
# Longer strings (descriptions, comments) are left out of the search index.
SEARCH_STRING_LENGTH = 120
# Large folders that never reference overlays or models; skipping them keeps the scans fast.
SCAN_SKIP = ("Server/Prefabs/", "Server/World/", "Server/HytaleGenerator/")


def main():
    parser = argparse.ArgumentParser(description="Build the effects viewer data.")
    parser.add_argument("--assets", type=Path, default=DEFAULT_ZIP, help="path to Assets.zip")
    parser.add_argument("--out", type=Path, default=Path(__file__).parent / "site", help="site folder")
    parser.add_argument("--no-sounds", action="store_true", help="skip copying the ~200 MB of sound files")
    parser.add_argument("--no-prefabs", action="store_true", help="skip converting the prefabs (slow, ~1 GB of input)")
    args = parser.parse_args()

    problems = []
    assets_dir = args.out / "assets"
    data_dir = args.out / "data"
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

        models, named_textures = read_models(assets, names)
        model_files = {m["path"] + MODEL_SUFFIX for m in models} | {t for m in models for t in m["textures"]}
        model_files |= {t for t in named_textures if COMMON_ROOT + t in names}
        model_files |= {a["file"] for m in models for a in m.get("animations", [])}
        copied += copy_files(assets, names, model_files, assets_dir, problems)

        json_files = server_json_files(names)
        known = {
            "particle": {s["id"] for s in systems},
            "sound": {s["id"] for s in sounds},
            "camera": {c["id"] for c in camera},
            "modelAsset": {PurePosixPath(n).stem for n in names if n.startswith(MODEL_ASSETS_ROOT) and n.endswith(".json")},
            "asset": {PurePosixPath(n).stem for n in json_files},
        }
        references, asset_paths, search, icons = read_references(assets, names, json_files, known)
        copied += copy_json_files(assets, json_files, data_dir / "json")
        copied += copy_files(assets, names, set(icons.values()), assets_dir, problems)

        prefabs, blocks = [], {}
        if not args.no_prefabs:
            blocks = read_blocks(assets, names)
            faces = {face for block in blocks.values() for face in block["faces"] or [] if face}
            copied += copy_files(assets, names, faces, assets_dir, problems)
            prefabs = convert_prefabs(assets, data_dir / "prefabs")

    data_dir.mkdir(parents=True, exist_ok=True)
    write_json(data_dir / "particles.json", {"systems": systems, "spawners": spawners, "problems": problems})
    write_json(data_dir / "sounds.json", {"sounds": sounds})
    write_json(data_dir / "screen.json", {"camera": camera, "overlays": overlays})
    write_json(data_dir / "models.json", {"models": models})
    write_json(data_dir / "references.json", references)
    write_json(data_dir / "assets.json", {"assets": asset_paths, "icons": icons})
    write_json(data_dir / "search.json", {"entries": search})
    write_json(data_dir / "prefabs.json", {"prefabs": prefabs, "blocks": blocks})

    print(
        f"{len(systems)} systems, {len(spawners)} spawners, {len(sounds)} sound events, "
        f"{len(camera)} camera assets, {len(overlays)} overlays, {len(models)} models, "
        f"{len(asset_paths)} server assets, {len(prefabs)} prefabs, {copied} files -> {args.out}"
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


def server_json_files(names):
    return sorted(
        n for n in names if n.startswith(("Server/", "Cosmetics/")) and n.endswith(".json") and not n.startswith(SCAN_SKIP)
    )


def names_an_asset(value, key):
    """Asset ids match loosely: one with an underscore under any key, a one-word id only under an id-like key."""
    return "_" in value or key.endswith("Id") or key in ("Parent", "Reference", "Appearance")


def read_references(assets, names, json_files, known):
    """Index which server and cosmetic assets mention each viewer asset, and list the assets.

    Returns ({"sources": [...], "refs": {"<kind>:<id>": [[source index, key], ...]}}, asset paths,
    search entries, icons). A search entry is [source, its distinct short strings joined by newlines];
    icons maps an asset path to the Icon image it names (items, model assets).
    Kind "signal" lists who sends a trigger volume signal (SendSignal, SignalNearbyVolumes).
    A source or asset path is a file path, or "<TriggerVolumeData path>#<volume name>" for a
    volume in an instance. Model files and screen overlays match by path; ids of the other kinds
    only count under a key that names their kind, so a sound and a tag that share a word don't
    get mixed up.
    """
    sources, refs, seen, asset_paths = [], collections.defaultdict(list), set(), []
    strings = collections.defaultdict(set)
    icons = {}

    def add(kind, value, source, key):
        if (kind, value, source) in seen:
            return
        seen.add((kind, value, source))
        if not sources or sources[-1] != source:
            sources.append(source)
        refs[f"{kind}:{value}"].append([len(sources) - 1, key])

    def walk(value, source, key=""):
        if isinstance(value, dict):
            for child_key, child in value.items():
                walk(child, source, child_key)
        elif isinstance(value, list):
            for child in value:
                walk(child, source, key)
        elif isinstance(value, str):
            if len(value) <= SEARCH_STRING_LENGTH:
                strings[source].add(value)
            if value.endswith(MODEL_SUFFIX):
                add("model", value, source, key)
            elif value.startswith("ScreenEffects/"):
                add("texture", value, source, key)
            for kind, hints in REFERENCE_KEY_HINTS.items():
                if value in known[kind] and any(hint in key for hint in hints):
                    add(kind, value, source, key)
            if value in known["asset"] and names_an_asset(value, key):
                add("asset", value, source, key)
            if key == "SignalKeys":
                add("signal", value, source, key)

    for name in json_files:
        try:
            data = json.loads(assets.read(name))
        except (ValueError, UnicodeDecodeError):
            continue
        if name.endswith("/TriggerVolumeData.json"):
            for volume in data.get("Volumes", {}).values():
                source = f"{name}#{volume.get('Name', '')}"
                asset_paths.append(source)
                walk(volume, source)
        else:
            asset_paths.append(name)
            walk(data, name)
            icon = data.get("Icon") if isinstance(data, dict) else None
            if isinstance(icon, str) and icon.endswith(".png") and COMMON_ROOT + icon in names:
                icons[name] = icon
    search = [[source, "\n".join(sorted(values))] for source, values in strings.items()]
    return {"sources": sources, "refs": refs}, asset_paths, search, icons


def copy_json_files(assets, files, out_dir):
    """Copy each zip entry to out_dir/<entry path>, for the Assets tab to load."""
    for name in files:
        if ".." in PurePosixPath(name).parts:
            continue
        target = out_dir / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(assets.read(name))
    return len(files)


def read_blocks(assets, names):
    """Return {block name: {faces, model, modelTexture, opaque}} from every item's BlockType, inheriting
    from Parent (a child's BlockType keys override its parent's).

    faces lists the up, down, north, south, east and west textures of a cube block (from Up/Down/North/...,
    else UpDown/Sides, else All, of the first Textures entry), or None. model and modelTexture are a
    Model block's CustomModel and first CustomModelTexture. Blocks that draw nothing are left out.
    """
    items = {}
    for name in names:
        if name.startswith("Server/Item/Items/") and name.endswith(".json"):
            try:
                items[PurePosixPath(name).stem] = json.loads(assets.read(name))
            except (ValueError, UnicodeDecodeError):
                continue

    def block_type(item_id, depth=0):
        item = items.get(item_id)
        if not isinstance(item, dict) or depth > 10:
            return {}
        own = item.get("BlockType") if isinstance(item.get("BlockType"), dict) else {}
        return {**block_type(item.get("Parent"), depth + 1), **own}

    blocks = {}
    for item_id in items:
        found = block_type(item_id)
        draw = found.get("DrawType")
        textures = found.get("Textures")
        first = textures[0] if isinstance(textures, list) and textures and isinstance(textures[0], dict) else None
        faces = None
        if first and draw in (None, "Cube", "CubeWithModel"):
            pick = lambda *keys: next((first[k] for k in keys if isinstance(first.get(k), str)), None)
            faces = [
                pick("Up", "UpDown", "All"),
                pick("Down", "UpDown", "All"),
                pick("North", "Sides", "All"),
                pick("South", "Sides", "All"),
                pick("East", "Sides", "All"),
                pick("West", "Sides", "All"),
            ]
            faces = faces if any(faces) else None
        model = found.get("CustomModel") if draw in ("Model", "CubeWithModel") and isinstance(found.get("CustomModel"), str) else None
        model_textures = found.get("CustomModelTexture")
        model_texture = model_textures[0].get("Texture") if isinstance(model_textures, list) and model_textures and isinstance(model_textures[0], dict) else None
        if faces or model:
            blocks[item_id] = {"faces": faces, "model": model, "modelTexture": model_texture, "opaque": found.get("Opacity") in (None, "Solid")}
    return blocks


def convert_prefabs(assets, out_dir):
    """Write each prefab up to PREFAB_MAX_BYTES as {palette, blocks, markers} and return the index.

    blocks is a flat list of x, y, z and palette index per block, without air ("Empty"); markers are the
    spawn markers among its entities, as {name, x, y, z}. Bigger prefabs are listed with "skipped".
    """
    index = []
    files = sorted((i for i in assets.infolist() if i.filename.startswith(PREFABS_ROOT) and i.filename.endswith(PREFAB_SUFFIX)), key=lambda i: i.filename)
    for info in files:
        path = info.filename[len(PREFABS_ROOT) : -len(PREFAB_SUFFIX)]
        if ".." in PurePosixPath(path).parts:
            continue
        if info.file_size > PREFAB_MAX_BYTES:
            index.append({"path": path, "skipped": True})
            continue
        try:
            data = json.loads(assets.read(info.filename))
        except (ValueError, UnicodeDecodeError):
            continue
        palette, lookup, flat = [], {}, []
        for block in data.get("blocks") or []:
            name = block.get("name")
            if not name or name == "Empty":
                continue
            if name not in lookup:
                lookup[name] = len(palette)
                palette.append(name)
            flat += [block.get("x", 0), block.get("y", 0), block.get("z", 0), lookup[name]]
        markers = []
        for entity in data.get("entities") or []:
            components = entity.get("Components", {}) if isinstance(entity, dict) else {}
            marker = components.get("SpawnMarkerComponent", {}).get("SpawnMarker")
            position = components.get("Transform", {}).get("Position", {})
            if isinstance(marker, str):
                markers.append({"name": marker, "x": position.get("X", 0), "y": position.get("Y", 0), "z": position.get("Z", 0)})
        target = out_dir / f"{path}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        write_json(target, {"palette": palette, "blocks": flat, "markers": markers})
        index.append({"path": path, "blocks": len(flat) // 4})
    return index


def read_overlays(assets, names):
    """Return [{id, path, texture}] for each screen overlay image."""
    textures = sorted(n[len(COMMON_ROOT) :] for n in names if n.startswith(OVERLAYS_ROOT) and n.endswith(".png"))
    return [{"id": PurePosixPath(t).stem, "path": t.removesuffix(".png"), "texture": t} for t in textures]


def read_models(assets, names):
    """Return ([{path, textures, animations?}] for every .blockymodel, every texture an asset names).

    A model's path is relative to Common/ without the suffix.

    Textures come from the server and cosmetic assets that pair the model with one, most used
    first; failing that, from the image files beside the model. Animations come from the
    Server/Models assets that use the model.
    """
    animations = model_animations(assets, names)
    pairs = collections.defaultdict(collections.Counter)
    named = set()
    for name in sorted(n for n in names if n.startswith(("Server/", "Cosmetics/")) and n.endswith(".json")):
        if name.startswith(SCAN_SKIP):
            continue
        try:
            collect_model_textures(json.loads(assets.read(name)), pairs, named)
        except (ValueError, UnicodeDecodeError):
            continue
    images = collections.defaultdict(list)
    for name in sorted(n for n in names if n.startswith(COMMON_ROOT) and n.endswith(".png")):
        image = PurePosixPath(name[len(COMMON_ROOT) :])
        images[str(image.parent)].append(image)
    known = {str(i) for folder in images.values() for i in folder}
    models = []
    for name in sorted(n for n in names if n.startswith(COMMON_ROOT) and n.endswith(MODEL_SUFFIX)):
        file = name[len(COMMON_ROOT) :]
        textures = [t for t, _ in pairs[file].most_common() if t in known] or textures_beside(file, images)
        entry = {"path": file.removesuffix(MODEL_SUFFIX), "textures": textures}
        if file in animations:
            entry["animations"] = animations[file]
        models.append(entry)
    return models, named


def model_animations(assets, names):
    """Return {model file: [{name, file, speed}]}: the first animation of each animation set of the model assets.

    A model asset inherits Model and AnimationSets from its Parent when it leaves them out. When
    several assets share a model and name the same set, the first asset by id wins.
    """
    model_assets = {}
    for name in sorted(n for n in names if n.startswith(MODEL_ASSETS_ROOT) and n.endswith(".json")):
        try:
            model_assets[PurePosixPath(name).stem] = json.loads(assets.read(name))
        except (ValueError, UnicodeDecodeError):
            continue

    def inherited(asset_id, key):
        seen = set()
        while asset_id in model_assets and asset_id not in seen:
            seen.add(asset_id)
            if model_assets[asset_id].get(key) is not None:
                return model_assets[asset_id][key]
            asset_id = model_assets[asset_id].get("Parent")
        return None

    found = collections.defaultdict(dict)
    for asset_id in sorted(model_assets):
        model = inherited(asset_id, "Model")
        for set_name, animation_set in (inherited(asset_id, "AnimationSets") or {}).items():
            first = next(iter(animation_set.get("Animations") or []), {})
            file = first.get("Animation")
            if model and file and COMMON_ROOT + file in names:
                found[model].setdefault(set_name, {"name": set_name, "file": file, "speed": first.get("Speed", 1)})
    return {model: list(sets.values()) for model, sets in found.items()}


def collect_model_textures(value, pairs, named):
    """Count the textures named beside each model path; add every texture named at all to `named`."""
    if isinstance(value, dict):
        textures = textures_named_in(value)
        named.update(textures)
        for item in value.values():
            if isinstance(item, str) and item.endswith(MODEL_SUFFIX):
                pairs[item].update(textures)
            collect_model_textures(item, pairs, named)
    elif isinstance(value, list):
        for item in value:
            collect_model_textures(item, pairs, named)


def textures_named_in(entry):
    for key in TEXTURE_KEYS:
        value = entry.get(key)
        if isinstance(value, str):
            return [value]
        if isinstance(value, list):
            return [v["Texture"] for v in value if isinstance(v, dict) and isinstance(v.get("Texture"), str)]
    return []


def textures_beside(file, images):
    """Images named after the model or Texture.png, else a <model>_Textures folder, else the folder's only image.

    images maps each folder to the images in it.
    """
    folder, stem = str(PurePosixPath(file).parent), PurePosixPath(file).stem
    in_folder = images.get(folder, [])
    named = [i for i in in_folder if i.name.startswith(stem) or i.name == "Texture.png"]
    found = named or images.get(f"{folder}/{stem}_Textures", []) or (in_folder if len(in_folder) == 1 else [])
    return [str(i) for i in found]


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
