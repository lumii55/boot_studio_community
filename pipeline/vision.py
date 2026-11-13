"""Image checks.

  * Nudity: a dedicated classifier, Falconsai/nsfw_image_detection (ViT, Apache-2.0).
  * Gore, violence, hate symbols and logos: CLIP (openai/clip-vit-base-patch32, MIT), zero-shot.

What it can do here:
  * flag frames that may break the rules → the upload goes to a person (never an automatic rejection: these models
    are smoke detectors, not judges);
  * recognise phone-maker logos (it reads big brand names very reliably) → automatic credit;
  * notice "some company logo" it cannot name → ask a person to make sure it is credited.

`assess()` is a pure function over the scores, so the policy is tested without the model.

Compact models: the label lists below are fixed, so their CLIP text embeddings are computed once by `prepare()`
and stored next to the image half of CLIP; both image models are stored in float16 (computed in float32). The
prepared folder (~350 MB instead of ~1.5 GB of downloads) is what the moderation workflow keeps between runs.
Any change to the models, the labels or the format makes `Vision()` prepare the folder again.

    python -I pipeline/vision.py --prepare      # builds BAS_MODEL_DIR (default ~/.cache/bas-vision) if needed
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

PREPARED_FORMAT = 1
MODEL_DIR = Path(os.environ.get("BAS_MODEL_DIR") or Path.home() / ".cache" / "bas-vision")

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


# Sensitivity chosen by the owner in the panel: multiplies every threshold (strict flags more, relaxed less).
SENSITIVITY = {"relaxed": 1.25, "normal": 1.0, "strict": 0.75}


def assess(frames: list[dict], credits: dict | None = None, *, logos: bool = True, sensitivity: str = "normal") -> tuple[list, dict]:
    """frames: [{"unsafe": {group: prob}, "logo": {label: prob}}] → (findings, detected)."""
    factor = SENSITIVITY.get(sensitivity, 1.0)
    nudity_threshold = min(0.95, NUDITY_THRESHOLD * factor)
    strong = min(0.95, UNSAFE_STRONG * factor)
    repeated = min(0.9, UNSAFE_REPEATED * factor)
    findings: list = []
    detected: dict = {}
    worst: dict = {}
    over: dict = {}
    for frame in frames:
        for group, prob in frame.get("unsafe", {}).items():
            worst[group] = max(worst.get(group, 0.0), prob)
            if prob >= repeated:
                over[group] = over.get(group, 0) + 1
    for group in ("nudity", *UNSAFE):
        prob = worst.get(group, 0.0)
        flagged = prob >= nudity_threshold if group == "nudity" else (
            prob >= strong or over.get(group, 0) >= UNSAFE_REPEATED_FRAMES)
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


UNSAFE_LABELS = SAFE + [label for labels in UNSAFE.values() for label in labels]
LOGO_LABELS = [f"the {brand} logo" for brand in BRANDS] + LOGO_OTHER


def manifest() -> dict:
    """What a prepared folder must have been built from; any difference means it is rebuilt."""
    return {
        "format": PREPARED_FORMAT,
        "clip": [MODEL_ID, MODEL_REVISION],
        "nudity": [NUDITY_MODEL_ID, NUDITY_MODEL_REVISION],
        "labels": {"unsafe": UNSAFE_LABELS, "logo": LOGO_LABELS},
    }


def is_prepared(directory: Path = MODEL_DIR) -> bool:
    try:
        return json.loads((Path(directory) / "manifest.json").read_text("utf-8")) == manifest()
    except (OSError, ValueError):
        return False


def prepare(directory: Path = MODEL_DIR) -> Path:
    """Downloads the pinned models (only the files used) and writes the compact folder. Returns the folder."""
    directory = Path(directory)
    if is_prepared(directory):
        return directory
    import torch
    from huggingface_hub import snapshot_download
    from safetensors.torch import save_file
    from transformers import (AutoImageProcessor, AutoModelForImageClassification, CLIPImageProcessor, CLIPModel,
                              CLIPTokenizer, CLIPVisionModelWithProjection)

    directory.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="bas-vision-") as temp:
        downloads = Path(temp) / "downloads"
        # Local folders are loaded without any further network access (no background safetensors conversion).
        clip_path = snapshot_download(MODEL_ID, revision=MODEL_REVISION, cache_dir=downloads,
                                      allow_patterns=["*.json", "*.txt", "pytorch_model.bin"])
        nudity_path = snapshot_download(NUDITY_MODEL_ID, revision=NUDITY_MODEL_REVISION, cache_dir=downloads,
                                        allow_patterns=["*.json", "model.safetensors"])
        build = Path(temp) / "build"
        with torch.no_grad():
            clip = CLIPModel.from_pretrained(clip_path).eval()
            tokenizer = CLIPTokenizer.from_pretrained(clip_path)
            embeddings = {}
            for name, labels in (("unsafe", UNSAFE_LABELS), ("logo", LOGO_LABELS)):
                features = clip.get_text_features(**tokenizer(labels, padding=True, return_tensors="pt"))
                embeddings[name] = (features / features.norm(dim=-1, keepdim=True)).contiguous()
            embeddings["logit_scale"] = clip.logit_scale.exp().reshape(1).contiguous()
            del clip
            build.mkdir()
            save_file(embeddings, build / "labels.safetensors")
            image_clip = CLIPVisionModelWithProjection.from_pretrained(clip_path).eval()
            image_clip.half().save_pretrained(build / "clip")
            CLIPImageProcessor.from_pretrained(clip_path).save_pretrained(build / "clip")
            nudity = AutoModelForImageClassification.from_pretrained(nudity_path).eval()
            nudity.half().save_pretrained(build / "nudity")
            AutoImageProcessor.from_pretrained(nudity_path, use_fast=False).save_pretrained(build / "nudity")
        (build / "manifest.json").write_text(json.dumps(manifest(), indent=1), "utf-8")
        if directory.exists():
            shutil.rmtree(directory)
        shutil.move(str(build), directory)
    return directory


class Vision:
    """Loads both models once and scores frames. Raises on any loading problem (the caller then falls back to a person)."""

    def __init__(self, directory: Path = MODEL_DIR):
        import torch
        from safetensors.torch import load_file
        from transformers import (AutoImageProcessor, AutoModelForImageClassification, CLIPImageProcessor,
                                  CLIPVisionModelWithProjection)

        directory = prepare(directory)
        self.torch = torch
        self.model = CLIPVisionModelWithProjection.from_pretrained(directory / "clip", torch_dtype=torch.float32).eval()
        self.processor = CLIPImageProcessor.from_pretrained(directory / "clip")
        self.labels = load_file(directory / "labels.safetensors")
        self.nudity_model = AutoModelForImageClassification.from_pretrained(directory / "nudity", torch_dtype=torch.float32).eval()
        self.nudity_processor = AutoImageProcessor.from_pretrained(directory / "nudity", use_fast=False)
        self.nsfw_index = {label: index for index, label in self.nudity_model.config.id2label.items()}["nsfw"]
        self.unsafe_labels = UNSAFE_LABELS
        self.logo_labels = LOGO_LABELS

    def _image_embedding(self, image):
        with self.torch.no_grad():
            features = self.model(**self.processor(images=image, return_tensors="pt")).image_embeds
        return features / features.norm(dim=-1, keepdim=True)

    def _probs(self, embedding, name):
        # Same as CLIPModel's logits_per_image, with the text side computed in advance.
        logits = self.labels["logit_scale"] * embedding @ self.labels[name].T
        return logits.softmax(-1)[0].tolist()

    def _nudity(self, image):
        with self.torch.no_grad():
            logits = self.nudity_model(**self.nudity_processor(images=image, return_tensors="pt")).logits
        return float(logits.softmax(-1)[0][self.nsfw_index])

    def score(self, images, *, logos: bool = True) -> list[dict]:
        step = max(1, -(-len(images) // MAX_FRAMES))
        frames = []
        for image in images[::step][:MAX_FRAMES]:
            embedding = self._image_embedding(image)
            probs = dict(zip(self.unsafe_labels, self._probs(embedding, "unsafe")))
            unsafe = {group: sum(probs[label] for label in labels) for group, labels in UNSAFE.items()}
            unsafe["nudity"] = self._nudity(image)
            frame = {"unsafe": unsafe}
            if logos:
                frame["logo"] = dict(zip(self.logo_labels, self._probs(embedding, "logo")))
            frames.append(frame)
        return frames


if __name__ == "__main__":
    if sys.argv[1:] != ["--prepare"]:
        sys.exit("usage: python -I pipeline/vision.py --prepare")
    print(f"vision models ready in {prepare()}")
