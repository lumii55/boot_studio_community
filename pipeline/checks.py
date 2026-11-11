"""Automatic checks for community uploads.

The ZIP rules mirror the Companion module's own preflight (module_source/archive.go), so anything the store
accepts is something the phone would accept too, plus store-only rules (frames-only format, no stray files).

Each check returns findings: {"code", "severity" (0 info … 3 critical), "message"}. The verdict is:
  reject – a hard rule is broken (the file can never be valid);
  review – a person must look (or an automatic check is not available yet);
  clean  – nothing found.
"""

from __future__ import annotations

import io
import stat
import zipfile
from dataclasses import dataclass, field

MAX_ENTRIES = 10000
MAX_UNCOMPRESSED = 1 << 30  # 1 GiB (the module allows 8 GiB; the store is stricter)
MAX_RATIO = 400
MAX_DESC_BYTES = 64 << 10
MAX_SIDE = 16384
MAX_FPS = 240
FRAME_EXTENSIONS = (".png", ".jpg", ".jpeg")
ALLOWED_ROOT_FILES = {"desc.txt", "audio_conf.txt"}
ALLOWED_PART_FILES = {"trim.txt", "audio.wav"}
PREVIEW_MAX_FRAMES = 36
PREVIEW_BOX = (270, 600)
PREVIEW_MAX_BYTES = 2 * 1024 * 1024


def finding(code: str, severity: int, message: str) -> dict:
    return {"code": code, "severity": severity, "message": message}


@dataclass
class ZipReport:
    findings: list = field(default_factory=list)
    metadata: dict = field(default_factory=dict)
    parts: list = field(default_factory=list)  # [(folder, [frame names sorted])]
    valid: bool = False

    def fatal(self, code: str, message: str) -> "ZipReport":
        self.findings.append(finding(code, 3, message))
        self.valid = False
        return self


def entry_name_ok(name: str) -> bool:
    if not name or "\x00" in name or "\\" in name or name.startswith("/"):
        return False
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in name):
        return False
    parts = name.rstrip("/").split("/")
    return all(part not in ("", ".", "..") for part in parts)


def audit_entries(archive: zipfile.ZipFile, report: ZipReport) -> bool:
    entries = archive.infolist()
    if not 0 < len(entries) <= MAX_ENTRIES:
        report.fatal("zip_entry_count", "The ZIP has no files or too many files.")
        return False
    seen = set()
    total = 0
    for entry in entries:
        name = entry.filename
        mode = (entry.external_attr >> 16) & 0xFFFF
        if not entry_name_ok(name):
            report.fatal("zip_unsafe_path", f"Unsafe path in the ZIP: {name[:80]!r}")
            return False
        if entry.flag_bits & 0x1:
            report.fatal("zip_encrypted", "Encrypted ZIP entries are not supported.")
            return False
        if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            report.fatal("zip_method", "Only stored or deflated ZIP entries are supported.")
            return False
        if stat.S_ISLNK(mode):
            report.fatal("zip_symlink", "Symbolic links are not allowed in the ZIP.")
            return False
        canonical = name.rstrip("/")
        if canonical in seen:
            report.fatal("zip_duplicate", f"Duplicate path in the ZIP: {canonical[:80]!r}")
            return False
        seen.add(canonical)
        total += entry.file_size
        if total > MAX_UNCOMPRESSED:
            report.fatal("zip_too_big", "The ZIP expands beyond the allowed size.")
            return False
        if entry.compress_type == zipfile.ZIP_STORED and entry.compress_size != entry.file_size:
            report.fatal("zip_bad_size", "Invalid stored ZIP entry size.")
            return False
        if entry.file_size > 0:
            if entry.compress_size == 0 or (
                entry.compress_type == zipfile.ZIP_DEFLATED and entry.file_size > MAX_RATIO * entry.compress_size
            ):
                report.fatal("zip_ratio", "Unsafe ZIP compression ratio.")
                return False
    return True


def parse_desc(text: str, report: ZipReport):
    lines = text.replace("\r\n", "\n").split("\n")
    header = lines[0].split() if lines else []
    if len(header) < 3:
        report.fatal("desc_header", "desc.txt must start with: width height fps")
        return None
    try:
        width, height, fps = int(header[0]), int(header[1]), int(header[2])
    except ValueError:
        report.fatal("desc_header", "desc.txt must start with: width height fps")
        return None
    if not (1 <= width <= MAX_SIDE and 1 <= height <= MAX_SIDE and 1 <= fps <= MAX_FPS):
        report.fatal("desc_values", "desc.txt has an invalid size or fps.")
        return None
    parts = []
    for raw in lines[1:]:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        fields = line.split()
        if fields[0] in ("p", "c") and len(fields) >= 4:
            try:
                count, pause = int(fields[1]), int(fields[2])
            except ValueError:
                report.fatal("desc_part", f"Invalid part line in desc.txt: {line[:60]!r}")
                return None
            if count < 0 or pause < 0:
                report.fatal("desc_part", f"Invalid part line in desc.txt: {line[:60]!r}")
                return None
            folder = fields[3]
            if not entry_name_ok(folder) or "/" in folder.rstrip("/"):
                report.fatal("desc_part", f"Invalid part folder in desc.txt: {folder[:60]!r}")
                return None
            parts.append({"type": fields[0], "count": count, "pause": pause, "folder": folder.rstrip("/")})
        elif fields[0] in ("p", "c", "f"):
            report.fatal("desc_part", f"Invalid part line in desc.txt: {line[:60]!r}")
            return None
    if not parts:
        report.fatal("desc_parts", "desc.txt does not list any part.")
        return None
    return width, height, fps, parts


def inspect_zip(data: bytes) -> ZipReport:
    report = ZipReport()
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        return report.fatal("zip_invalid", "The file is not a valid ZIP.")
    with archive:
        if not audit_entries(archive, report):
            return report
        names = {info.filename.rstrip("/"): info for info in archive.infolist()}
        desc = names.get("desc.txt")
        if desc is None or desc.is_dir():
            return report.fatal("desc_missing", "desc.txt was not found at the top of the ZIP.")
        if desc.file_size > MAX_DESC_BYTES:
            return report.fatal("desc_too_big", "desc.txt is too large.")
        parsed = parse_desc(archive.read(desc).decode("utf-8", "replace"), report)
        if parsed is None:
            return report
        width, height, fps, parts = parsed
        folders = {part["folder"] for part in parts}

        frames_by_folder: dict[str, list[str]] = {folder: [] for folder in folders}
        has_audio = False
        for name, info in names.items():
            if info.is_dir():
                if "/" in name or name in folders:
                    continue
                return report.fatal("zip_unexpected_dir", f"Unexpected folder in the ZIP: {name[:80]!r}")
            if "/" not in name:
                if name not in ALLOWED_ROOT_FILES:
                    return report.fatal("zip_unexpected_file", f"Unexpected file in the ZIP: {name[:80]!r}")
                continue
            folder, base = name.split("/", 1)
            if folder not in folders or "/" in base:
                return report.fatal("zip_unexpected_file", f"Unexpected file in the ZIP: {name[:80]!r}")
            lower = base.lower()
            if lower.endswith(FRAME_EXTENSIONS):
                frames_by_folder[folder].append(name)
            elif lower in ALLOWED_PART_FILES:
                has_audio = has_audio or lower == "audio.wav"
            else:
                return report.fatal("zip_unexpected_file", f"Unexpected file in the ZIP: {name[:80]!r}")

        empty = [folder for folder, frames in frames_by_folder.items() if not frames]
        if empty:
            return report.fatal("part_empty", f"Part folder without frames: {empty[0][:60]!r}")
        frame_count = sum(len(frames) for frames in frames_by_folder.values())
        report.parts = [(part["folder"], sorted(frames_by_folder[part["folder"]])) for part in parts]
        report.metadata = {
            "width": width,
            "height": height,
            "fps": fps,
            "frame_count": frame_count,
            "parts": len(parts),
            "has_audio": has_audio,
        }
        report.valid = True
        return report


def check_frames(data: bytes, report: ZipReport):
    """Decodes an even sample of frames. Returns (images, step) for the preview and the classifiers."""
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = MAX_SIDE * MAX_SIDE
    ordered = [name for _, frames in report.parts for name in frames]
    if not ordered:
        return [], 1
    step = max(1, -(-len(ordered) // PREVIEW_MAX_FRAMES))
    wanted = (report.metadata["width"], report.metadata["height"])
    images = []
    mismatched = 0
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for name in ordered[::step]:
            try:
                with archive.open(name) as handle:
                    image = Image.open(io.BytesIO(handle.read()))
                    image.load()
            except Exception:  # noqa: BLE001 - any decoder error means a broken frame
                report.fatal("frame_broken", f"A frame could not be read: {name[:80]!r}")
                return [], step
            if image.size != wanted:
                mismatched += 1
            images.append(image.convert("RGB"))
    if mismatched:
        report.findings.append(finding(
            "frame_size", 1, f"{mismatched} sampled frame(s) differ from the size in desc.txt ({wanted[0]}x{wanted[1]}).",
        ))
    return images, step


def make_preview(images: list, fps: int, step: int) -> bytes | None:
    """Animated WebP at the original speed (each sampled frame stands for `step` frames)."""
    if not images:
        return None
    # Every frame gets the same size (an odd-sized frame would break the animation).
    first = images[0].copy()
    first.thumbnail(PREVIEW_BOX)
    size = first.size
    frames = [image.resize(size) for image in images]
    duration = max(20, round(1000 * step / max(1, fps)))
    for quality in (60, 45, 30):
        out = io.BytesIO()
        frames[0].save(out, format="WEBP", save_all=True, append_images=frames[1:], duration=duration, loop=0,
                       quality=quality, method=4)
        if out.tell() <= PREVIEW_MAX_BYTES:
            return out.getvalue()
    return None


def image_check(data: bytes) -> list:
    from PIL import Image

    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception:  # noqa: BLE001
        return [finding("image_broken", 3, "The image could not be read.")]
    return []


def verdict(findings: list) -> str:
    worst = max((item["severity"] for item in findings), default=0)
    if worst >= 3:
        return "reject"
    if worst >= 1 or any(item["code"] == "visual_check_pending" for item in findings):
        return "review"
    return "clean"
