"""Runs one community moderation job inside GitHub Actions.

    JOB_ID=<id> BAS_API=https://… python -I pipeline/run_job.py

Authentication is the workflow's own OIDC token (audience "bas-community"); there is no stored secret.
Whatever goes wrong, the job reports *something*, so nothing waits forever: an internal error becomes
"review" (a person decides), never "clean".
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import checks  # noqa: E402

AUDIENCE = "bas-community"
MAX_DOWNLOAD = 52 * 1024 * 1024
JOB_RE = re.compile(r"^[A-Za-z0-9_-]{16}$")
USER_AGENT = "bas-community-pipeline"

# Used when the image model cannot run (disabled or failed to load): a person looks instead.
VISUAL_PENDING = checks.finding(
    "visual_check_pending", 0, "Automatic image check did not run; please look at it.",
)
_vision = None


def vision_check(images, credits=None, *, logos=True, sensitivity="normal"):
    """(findings, detected) from the image model; falls back to manual review if it cannot run."""
    global _vision
    if os.environ.get("BAS_VISION", "on") == "off" or not images:
        return [VISUAL_PENDING], {}
    try:
        if _vision is None:
            import vision  # noqa: PLC0415 - heavy import only when needed
            _vision = vision.Vision()
        import vision  # noqa: PLC0415
        return vision.assess(_vision.score(images, logos=logos), credits, logos=logos, sensitivity=sensitivity)
    except Exception as err:  # noqa: BLE001 - never let the model decide by crashing
        print(f"vision unavailable: {type(err).__name__}: {err}", file=sys.stderr)
        return [VISUAL_PENDING], {}


def oidc_token() -> str:
    url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"] + f"&audience={AUDIENCE}"
    request = urllib.request.Request(url, headers={
        "Authorization": "bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"],
        "User-Agent": USER_AGENT,
    })
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)["value"]


class Api:
    def __init__(self, base: str, token: str):
        self.base = base.rstrip("/")
        self.token = token

    def call(self, method: str, path: str, body: bytes | None = None, content_type: str | None = None, limit: int = 1 << 20):
        headers = {"Authorization": f"Bearer {self.token}", "User-Agent": USER_AGENT}
        if content_type:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(self.base + path, data=body, method=method, headers=headers)
        with urllib.request.urlopen(request, timeout=120) as response:
            data = response.read(limit + 1)
            if len(data) > limit:
                raise ValueError("response too large")
            return data

    def json(self, method: str, path: str, payload=None):
        body = None if payload is None else json.dumps(payload).encode()
        return json.loads(self.call(method, path, body, "application/json" if body else None) or b"null")


def check_animation(api: Api, job_id: str, subject: dict) -> dict:
    detected: dict = {}
    data = api.call("GET", f"/v1/pipeline/jobs/{job_id}/file", limit=MAX_DOWNLOAD)
    report = checks.inspect_zip(data)
    if report.valid:
        images, step = checks.check_frames(data, report)
        if report.valid:
            preview = checks.make_preview(images, report.metadata["fps"], step)
            if preview:
                api.call("PUT", f"/v1/pipeline/jobs/{job_id}/preview", preview, "image/webp")
            found, detected = vision_check(images, subject.get("credits"), sensitivity=subject.get("sensitivity", "normal"))
            report.findings.extend(found)
    findings = report.findings
    return {"verdict": checks.verdict(findings), "findings": findings, "metadata": report.metadata, "detected": detected}


def check_media(api: Api, job_id: str, subject: dict) -> dict:
    data = api.call("GET", f"/v1/pipeline/jobs/{job_id}/file", limit=4 * 1024 * 1024)
    findings = checks.image_check(data)
    if not findings:
        import io  # noqa: PLC0415
        from PIL import Image  # noqa: PLC0415
        image = Image.open(io.BytesIO(data)).convert("RGB")
        found, _ = vision_check([image], logos=False, sensitivity=subject.get("sensitivity", "normal"))  # avatars/banners: safety only
        findings.extend(found)
    return {"verdict": checks.verdict(findings), "findings": findings}


def check_profile(api: Api, job_id: str, subject: dict) -> dict:
    # Text is judged in context by a person when reported; no automatic text classifier yet.
    return {"verdict": "clean", "findings": []}


def api_base_from_config() -> str:
    """PUBLIC_URL from wrangler.jsonc, so the Worker address lives in one place."""
    text = (Path(__file__).resolve().parent.parent / "wrangler.jsonc").read_text()
    match = re.search(r'"PUBLIC_URL"\s*:\s*"(https://[^"]+)"', text)
    if not match:
        raise SystemExit("PUBLIC_URL not found in wrangler.jsonc")
    return match.group(1)


CHECKS = {"animation": check_animation, "media": check_media, "profile": check_profile}


def main() -> int:
    job_id = os.environ.get("JOB_ID", "")
    if not JOB_RE.match(job_id):
        print("invalid job id", file=sys.stderr)
        return 2
    api = Api(os.environ.get("BAS_API") or api_base_from_config(), oidc_token())
    job = api.json("GET", f"/v1/pipeline/jobs/{job_id}")
    kind = job["job"]["kind"]
    subject = {**job["subject"], "sensitivity": job.get("sensitivity", "normal")}
    try:
        result = CHECKS[kind](api, job_id, subject)
    except Exception as err:  # noqa: BLE001 - report instead of leaving the job hanging
        print(f"check failed: {type(err).__name__}: {err}", file=sys.stderr)
        result = {"verdict": "review", "findings": [checks.finding("pipeline_error", 1, "Automatic checks failed; review manually.")]}
    api.json("POST", f"/v1/pipeline/jobs/{job_id}/result", result)
    print(json.dumps({"job": job_id, "kind": kind, "verdict": result["verdict"], "codes": [f["code"] for f in result["findings"]]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
