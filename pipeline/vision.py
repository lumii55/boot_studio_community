"""Image checks.

  * Nudity: a dedicated classifier, Falconsai/nsfw_image_detection (ViT, Apache-2.0).
  * Gore, violence, hate symbols and logos: CLIP (openai/clip-vit-base-patch32, MIT), zero-shot.

What it can do here:
  * flag frames that may break the rules → the upload goes to a person (never an automatic rejection: these models
    are smoke detectors, not judges);
  * recognise phone-maker logos (it reads big brand names very reliably) → automatic credit;
  * notice "some company logo" it cannot name → ask a person to make sure it is credited.

`assess()` is a pure function over the scores, so the policy is tested without the model.
"""

from __future__ import annotations

MODEL_ID = "openai/clip-vit-base-patch32"
MODEL_REVISION = "3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268"
NUDITY_MODEL_ID = "Falconsai/nsfw_image_detection"
NUDITY_MODEL_REVISION = "96cb0d0342c7afb80cab76ecc58b265fa44da256"
MAX_FRAMES = 12

# Zero-shot only works when the harmless things in boot animations have a label of their own; with a short list,
# a cute cartoon character "leaked" 35 % into an unsafe label (first real false alarm, 2026-11-12).
SAFE = [
    "a boot animation", "a logo on a dark background", "an abstract colorful animation", "text on a plain background",
    "a cartoon character", "a game character", "a landscape", "a fully clothed person", "a geometric pattern",
    "a phone startup screen", "a cute cartoon animal", "an anime character", "a chibi mascot with a hat", "a cute drawing",
    "a sticker", "an emoji", "a smiley face", "pixel art", "a video game screenshot", "neon text", "a loading screen",
    "a black screen", "a dark background with small shapes", "outer space with stars", "flowers", "a pet",
    "a portrait of a person", "a photo of food", "a brand logo", "a circle", "a gradient", "red paint", "blurry colors",
    "an illustration",
]
UNSAFE = {
    "gore": ["gore with blood and wounds", "a dead body", "a bloody injury"],
    "violence": ["a person holding a gun", "people fighting violently", "a weapon pointed at someone"],
    "hate": ["a nazi swastika", "a hate symbol", "a racist image"],
}
BRANDS = [
    "Samsung", "Motorola", "Xiaomi", "Google", "Android", "OnePlus", "Huawei", "OPPO", "vivo", "realme", "Sony", "LG",
    "Nokia", "ASUS", "Lenovo", "Apple",
]
LOGO_OTHER = ["a logo of a company", "a word written in large letters", "abstract shapes with no logo", "a plain color background"]

# Nudity (dedicated model): review when any sampled frame reaches this score.
NUDITY_THRESHOLD = 0.60
# Zero-shot groups: review when one frame is clearly over, or several frames are suspicious.
UNSAFE_STRONG = 0.60
UNSAFE_REPEATED = 0.40
UNSAFE_REPEATED_FRAMES = 2
# A brand counts as recognised above this; "a logo of a company" above UNKNOWN_LOGO asks for a credit check.
BRAND_THRESHOLD = 0.85
UNKNOWN_LOGO_THRESHOLD = 0.60

MESSAGES = {
    "nudity": "Possible nudity or sexual content (automatic check, {p}%).",
    "gore": "Possible gore (automatic check, {p}%).",
    "violence": "Possible violence or weapons (automatic check, {p}%).",
    "hate": "Possible hate symbol (automatic check, {p}%).",
}


def assess(frames: list[dict], credits: dict | None = None, *, logos: bool = True) -> tuple[list, dict]:
    """frames: [{"unsafe": {group: prob}, "logo": {label: prob}}] → (findings, detected)."""
    findings: list = []
    detected: dict = {}
    worst: dict = {}
    over: dict = {}
    for frame in frames:
        for group, prob in frame.get("unsafe", {}).items():
            worst[group] = max(worst.get(group, 0.0), prob)
            if prob >= UNSAFE_REPEATED:
                over[group] = over.get(group, 0) + 1
    for group in ("nudity", *UNSAFE):
        prob = worst.get(group, 0.0)
        flagged = prob >= NUDITY_THRESHOLD if group == "nudity" else (
            prob >= UNSAFE_STRONG or over.get(group, 0) >= UNSAFE_REPEATED_FRAMES)
        if flagged:
            findings.append({"code": f"possible_{group}", "severity": 2, "message": MESSAGES[group].format(p=round(prob * 100))})

    if logos:
        brand_scores: dict = {}
        unknown = 0.0
        for frame in frames:
            for label, prob in frame.get("logo", {}).items():
                if label.startswith("the ") and label.endswith(" logo"):
                    brand = label[4:-5]
                    brand_scores[brand] = max(brand_scores.get(brand, 0.0), prob)
                elif label == "a logo of a company":
                    unknown = max(unknown, prob)
        brand, score = max(brand_scores.items(), key=lambda item: item[1], default=(None, 0.0))
        credits = credits or {}
        art_credited = any(str(credits.get(key) or "").strip() for key in ("art_by", "manufacturer", "original_author"))
        if brand and score >= BRAND_THRESHOLD:
            detected["manufacturer"] = brand
            findings.append({"code": "logo_detected", "severity": 0, "message": f"{brand} logo recognised and credited automatically."})
        elif unknown >= UNKNOWN_LOGO_THRESHOLD and not art_credited:
            findings.append({"code": "logo_unknown", "severity": 1,
                             "message": "A company logo seems to appear but is not credited; check the credits."})
    return findings, detected


class Vision:
    """Loads both models once and scores frames. Raises on any loading problem (the caller then falls back to a person)."""

    def __init__(self):
        import torch
        from transformers import AutoImageProcessor, AutoModelForImageClassification, CLIPModel, CLIPProcessor

        self.torch = torch
        self.model = CLIPModel.from_pretrained(MODEL_ID, revision=MODEL_REVISION).eval()
        self.processor = CLIPProcessor.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
        self.nudity_model = AutoModelForImageClassification.from_pretrained(NUDITY_MODEL_ID, revision=NUDITY_MODEL_REVISION).eval()
        self.nudity_processor = AutoImageProcessor.from_pretrained(NUDITY_MODEL_ID, revision=NUDITY_MODEL_REVISION)
        self.nsfw_index = {label: index for index, label in self.nudity_model.config.id2label.items()}["nsfw"]
        self.unsafe_labels = SAFE + [label for labels in UNSAFE.values() for label in labels]
        self.logo_labels = [f"the {brand} logo" for brand in BRANDS] + LOGO_OTHER

    def _probs(self, image, labels):
        inputs = self.processor(text=labels, images=image, return_tensors="pt", padding=True)
        with self.torch.no_grad():
            return self.model(**inputs).logits_per_image.softmax(-1)[0].tolist()

    def _nudity(self, image):
        with self.torch.no_grad():
            logits = self.nudity_model(**self.nudity_processor(images=image, return_tensors="pt")).logits
        return float(logits.softmax(-1)[0][self.nsfw_index])

    def score(self, images, *, logos: bool = True) -> list[dict]:
        step = max(1, -(-len(images) // MAX_FRAMES))
        frames = []
        for image in images[::step][:MAX_FRAMES]:
            probs = dict(zip(self.unsafe_labels, self._probs(image, self.unsafe_labels)))
            unsafe = {group: sum(probs[label] for label in labels) for group, labels in UNSAFE.items()}
            unsafe["nudity"] = self._nudity(image)
            frame = {"unsafe": unsafe}
            if logos:
                frame["logo"] = dict(zip(self.logo_labels, self._probs(image, self.logo_labels)))
            frames.append(frame)
        return frames
