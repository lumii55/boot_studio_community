"""Tests for the upload checks: python -m unittest discover -s pipeline (needs Pillow)."""

import io
import sys
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import checks  # noqa: E402
from PIL import Image  # noqa: E402


def frame(size=(108, 240), color=(200, 30, 90), fmt="PNG"):
    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, format=fmt)
    return out.getvalue()


def build_zip(entries, compression=zipfile.ZIP_STORED):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression) as archive:
        for name, data in entries:
            if isinstance(data, zipfile.ZipInfo):
                archive.writestr(data, b"")
            else:
                archive.writestr(name, data)
    return out.getvalue()


def good_entries(frames=3, size=(108, 240)):
    entries = [("desc.txt", "108 240 30\np 1 0 part0\np 0 0 part1\n")]
    entries += [(f"part0/{i:05d}.png", frame(size, (i * 5 % 256, 30, 90))) for i in range(frames)]
    entries += [(f"part1/{i:05d}.jpg", frame(size, (30, i * 5 % 256, 90), fmt="JPEG")) for i in range(frames)]
    return entries


class ZipRules(unittest.TestCase):
    def codes(self, data):
        report = checks.inspect_zip(data)
        return report, [item["code"] for item in report.findings]

    def test_valid_animation(self):
        report, codes = self.codes(build_zip(good_entries() + [("part0/audio.wav", b"RIFF")]))
        self.assertTrue(report.valid, codes)
        self.assertEqual(report.metadata, {
            "width": 108, "height": 240, "fps": 30, "frame_count": 6, "parts": 2, "has_audio": True,
        })
        self.assertEqual(checks.verdict(report.findings), "clean")

    def test_hard_rules_reject(self):
        cases = {
            "not a zip": (b"hello", "zip_invalid"),
            "traversal": (build_zip(good_entries() + [("../evil.sh", b"x")]), "zip_unsafe_path"),
            "absolute": (build_zip(good_entries() + [("/etc/passwd", b"x")]), "zip_unsafe_path"),
            "no desc": (build_zip(good_entries()[1:]), "desc_missing"),
            "bad header": (build_zip([("desc.txt", "wide tall\np 1 0 part0\n")] + good_entries()[1:]), "desc_header"),
            "huge fps": (build_zip([("desc.txt", "108 240 999\np 1 0 part0\n")] + good_entries()[1:]), "desc_values"),
            "no parts": (build_zip([("desc.txt", "108 240 30\n")]), "desc_parts"),
            "script": (build_zip(good_entries() + [("install.sh", b"rm -rf /")]), "zip_unexpected_file"),
            "apk in part": (build_zip(good_entries() + [("part0/app.apk", b"PK")]), "zip_unexpected_file"),
            "unlisted folder": (build_zip(good_entries() + [("extra/00000.png", frame())]), "zip_unexpected_file"),
            "empty part": (build_zip([("desc.txt", "108 240 30\np 1 0 part0\np 1 0 part9\n")] + good_entries()[1:4]), "part_empty"),
        }
        for label, (data, code) in cases.items():
            with self.subTest(label):
                report, codes = self.codes(data)
                self.assertFalse(report.valid)
                self.assertIn(code, codes)
                self.assertEqual(checks.verdict(report.findings), "reject")

    def test_zip_bomb_ratio(self):
        data = build_zip(good_entries() + [("part0/99999.png", b"\0" * (4 << 20))], zipfile.ZIP_DEFLATED)
        _, codes = self.codes(data)
        self.assertIn("zip_ratio", codes)

    def test_symlink(self):
        info = zipfile.ZipInfo("part0/link.png")
        info.external_attr = (0o120777 << 16)
        _, codes = self.codes(build_zip(good_entries() + [("part0/link.png", info)]))
        self.assertIn("zip_symlink", codes)

    def test_frames_preview_and_size_warning(self):
        data = build_zip(good_entries(frames=50) + [("part1/00000.png", frame((50, 50)))])
        report = checks.inspect_zip(data)
        self.assertTrue(report.valid)
        images, step = checks.check_frames(data, report)
        self.assertGreater(len(images), 10)
        self.assertLessEqual(len(images), checks.PREVIEW_MAX_FRAMES)
        self.assertEqual(step, 3)
        self.assertEqual([item["code"] for item in report.findings], ["frame_size"])
        preview = checks.make_preview(images, 30, step)
        self.assertEqual(preview[:4], b"RIFF")
        self.assertEqual(preview[8:12], b"WEBP")
        self.assertLessEqual(len(preview), checks.PREVIEW_MAX_BYTES)
        out = Image.open(io.BytesIO(preview))
        self.assertTrue(getattr(out, "is_animated", False))
        self.assertLessEqual(out.size[0], 270)

    def test_broken_frame(self):
        entries = good_entries()
        entries[1] = ("part0/00000.png", b"\x89PNG broken")
        data = build_zip(entries)
        report = checks.inspect_zip(data)
        checks.check_frames(data, report)
        self.assertFalse(report.valid)
        self.assertEqual(checks.verdict(report.findings), "reject")

    def test_pending_visual_check_forces_review(self):
        self.assertEqual(checks.verdict([checks.finding("visual_check_pending", 0, "")]), "review")
        self.assertEqual(checks.verdict([checks.finding("frame_size", 1, "")]), "review")
        self.assertEqual(checks.verdict([]), "clean")

    def test_images(self):
        self.assertEqual(checks.image_check(frame()), [])
        self.assertEqual(checks.image_check(b"<svg/>")[0]["code"], "image_broken")


if __name__ == "__main__":
    unittest.main()
