"""Policy of the image checks (no model needed). With BAS_VISION_MODEL=1 also runs the real CLIP model."""

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vision  # noqa: E402


def frame(unsafe=None, logo=None):
    return {"unsafe": {group: 0.01 for group in ("nudity", *vision.UNSAFE)} | (unsafe or {}), "logo": logo or {}}


class Policy(unittest.TestCase):
    def test_clean_frames(self):
        findings, detected = vision.assess([frame(), frame()], {"animation_by": "self"})
        self.assertEqual((findings, detected), ([], {}))

    def test_nudity_model_score_goes_to_review_never_reject(self):
        findings, _ = vision.assess([frame(), frame({"nudity": 0.61})])
        self.assertEqual([(item["code"], item["severity"]) for item in findings], [("possible_nudity", 2)])
        self.assertIn("61%", findings[0]["message"])
        # The first real false alarm scored 35 %: a cartoon cat. That must stay clean.
        self.assertEqual(vision.assess([frame({"nudity": 0.35})] * 12)[0], [])

    def test_zero_shot_groups_need_a_strong_frame_or_repeated_suspicion(self):
        self.assertEqual(vision.assess([frame({"gore": 0.45})])[0], [])
        self.assertEqual([item["code"] for item in vision.assess([frame({"gore": 0.45}), frame({"gore": 0.41})])[0]], ["possible_gore"])
        self.assertEqual([item["code"] for item in vision.assess([frame({"hate": 0.65})])[0]], ["possible_hate"])

    def test_recognised_brand_is_credited_automatically(self):
        findings, detected = vision.assess([frame(logo={"the Motorola logo": 0.97, "a logo of a company": 0.02})])
        self.assertEqual(detected, {"manufacturer": "Motorola"})
        self.assertEqual([(item["code"], item["severity"]) for item in findings], [("logo_detected", 0)])

    def test_unknown_logo_asks_for_credit_unless_art_is_credited(self):
        logo = {"the Sony logo": 0.2, "a logo of a company": 0.7}
        findings, detected = vision.assess([frame(logo=logo)], {"animation_by": "self"})
        self.assertEqual(([item["code"] for item in findings], detected), (["logo_unknown"], {}))
        findings, _ = vision.assess([frame(logo=logo)], {"animation_by": "self", "art_by": "Brand logo by its maker"})
        self.assertEqual(findings, [])

    def test_media_skips_logos(self):
        findings, detected = vision.assess([frame(logo={"the Apple logo": 0.99})], logos=False)
        self.assertEqual((findings, detected), ([], {}))


@unittest.skipUnless(os.environ.get("BAS_VISION_MODEL") == "1", "set BAS_VISION_MODEL=1 to run the real model")
class RealModel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from PIL import Image, ImageDraw, ImageFont
        cls.model = vision.Vision()

        def text(word):
            image = Image.new("RGB", (540, 1200), (0, 0, 0))
            draw = ImageDraw.Draw(image)
            try:
                font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 90)
            except OSError:
                font = ImageFont.load_default()
            draw.text(((540 - draw.textlength(word, font=font)) / 2, 540), word, font=font, fill=(255, 255, 255))
            return image
        cls.text = staticmethod(text)
        cls.Image = Image

    def test_brand_text_is_recognised(self):
        for word, brand in (("SAMSUNG", "Samsung"), ("motorola", "Motorola")):
            findings, detected = vision.assess(self.model.score([self.text(word)]), {})
            self.assertEqual(detected.get("manufacturer"), brand)
            self.assertFalse([item for item in findings if item["severity"] >= 2])

    def test_harmless_drawings_are_clean_and_a_hate_symbol_is_not(self):
        smiley = self.Image.new("RGB", (540, 1200))
        from PIL import ImageDraw
        draw = ImageDraw.Draw(smiley)
        draw.ellipse((170, 450, 370, 650), fill=(255, 220, 0))
        draw.ellipse((220, 510, 245, 535), fill=0)
        draw.ellipse((295, 510, 320, 535), fill=0)
        draw.arc((220, 540, 320, 610), 0, 180, fill=0, width=8)
        skin = self.Image.new("RGB", (540, 1200), (250, 220, 180))
        ImageDraw.Draw(skin).ellipse((170, 300, 370, 500), fill=(255, 200, 150))
        findings, _ = vision.assess(self.model.score([smiley, skin]), {"art_by": "x"})
        self.assertFalse([item for item in findings if item["severity"] >= 2], findings)
        # Positive control: a drawn swastika must still be caught.
        symbol = self.Image.new("RGB", (540, 1200), (255, 255, 255))
        draw = ImageDraw.Draw(symbol)
        center, arm = (270, 600), 140
        for dx, dy, ex, ey in ((0, -1, 1, 0), (1, 0, 0, 1), (0, 1, -1, 0), (-1, 0, 0, -1)):
            x1, y1 = center[0] + dx * arm, center[1] + dy * arm
            draw.line([center, (x1, y1)], fill=0, width=34)
            draw.line([(x1, y1), (x1 + ex * arm, y1 + ey * arm)], fill=0, width=34)
        findings, _ = vision.assess(self.model.score([symbol]), {})
        self.assertIn("possible_hate", [item["code"] for item in findings])

    def test_plain_frames_are_clean(self):
        gradient = self.Image.linear_gradient("L").resize((540, 1200)).convert("RGB")
        findings, detected = vision.assess(self.model.score([self.Image.new("RGB", (540, 1200)), gradient]), {"art_by": ""})
        self.assertFalse([item for item in findings if item["severity"] >= 1], findings)
        self.assertEqual(detected, {})


if __name__ == "__main__":
    unittest.main()
