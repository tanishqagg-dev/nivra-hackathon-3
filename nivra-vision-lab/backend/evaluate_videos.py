"""Evaluate full videos through the running JPEG/HTTP inference path.

Usage: ../.venv-fight/bin/python backend/evaluate_videos.py
Then: node --experimental-strip-types scripts/summarize-fight-evaluation.mjs
"""
from __future__ import annotations

import hashlib
import argparse
import io
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

import av
import numpy as np
from PIL import Image

from detector import read_clip

URL = "http://127.0.0.1:5173/api/fight/"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', default=str(Path(__file__).parent / 'evaluation-fresh'))
    parser.add_argument('--expected-engine', default='consensus-v2')
    arguments = parser.parse_args()
    ROOT = Path(arguments.directory)
    manifest = json.loads((ROOT / "inputs.json").read_text())
    health = json.load(urllib.request.urlopen(URL + "health", timeout=10))
    if not health.get("ready") or health.get("engine") != arguments.expected_engine or health.get("frames") != 32:
        raise RuntimeError("The expected frozen backend is not ready")
    started = time.time()
    report = {"method": "Full source videos, complete 4-second windows at 2-second stride, plus a final complete window when needed. Actual JPEG / Vite proxy / backend requests. Alert decisions are summarized by the application's TypeScript FightDecision.",
              "health": health, "manifestSha256": hashlib.sha256((ROOT / "inputs.json").read_bytes()).hexdigest(),
              "videos": []}
    for item in manifest["videos"]:
        path = ROOT / "videos" / (item["id"] + ".mp4")
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".part")
            with urllib.request.urlopen(item["url"], timeout=60) as response, temporary.open("wb") as output:
                while chunk := response.read(262_144):
                    output.write(chunk)
            if hashlib.sha256(temporary.read_bytes()).hexdigest() != item["sha256"]:
                raise RuntimeError("Downloaded video checksum mismatch: " + item["id"])
            temporary.replace(path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
            raise RuntimeError("Video checksum mismatch: " + item["id"])
        with av.open(str(path)) as container:
            stream = container.streams.video[0]
            duration = float(stream.duration * stream.time_base) if stream.duration else container.duration / av.time_base
        final_start = max(0, duration - 4)
        positions = list(np.arange(0, final_start + 1e-6, 2)) if duration >= 4 else []
        if positions and final_start - positions[-1] > .1:
            positions.append(final_start)
        row = {**item, "durationSeconds": duration, "windows": [], "insufficientDuration": duration < 5}
        print(f"{item['id']} START {duration:.1f}s, {len(positions)} windows", flush=True)
        for index, position in enumerate(positions):
            frames = read_clip(str(path), start=float(position))
            strip = Image.fromarray(np.concatenate(list(frames), axis=1))
            payload = io.BytesIO()
            strip.save(payload, format="JPEG", quality=90)
            request = urllib.request.Request(URL + "predict", data=payload.getvalue(), headers={"Content-Type": "image/jpeg"})
            roundtrip_start = time.perf_counter()
            retries = 0
            while True:
                try:
                    with urllib.request.urlopen(request, timeout=20) as response:
                        prediction = json.load(response)
                    break
                except urllib.error.HTTPError as error:
                    if error.code != 429 or retries >= 5:
                        raise
                    retries += 1
                    time.sleep(.5)
            row["windows"].append({"startSeconds": float(position), "endSeconds": float(position + 4),
                                   "roundtripMs": round((time.perf_counter() - roundtrip_start) * 1000, 1),
                                   "busyRetries": retries, **prediction})
            if (index + 1) % 5 == 0:
                print(f"{item['id']} {index + 1}/{len(positions)} windows", flush=True)
        report["videos"].append(row)
        report["elapsedSeconds"] = round(time.time() - started, 1)
        (ROOT / "predictions.json").write_text(json.dumps(report, indent=2))
        positive = sum(window["aboveThreshold"] for window in row["windows"])
        print(f"{item['id']} DONE {positive}/{len(positions)} positive windows", flush=True)


if __name__ == "__main__":
    main()
