"""Report isolated scene decisions for the two predeclared native clip checks."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
DECLARED_LABELS = {"F07": True, "C01": False}


def summarize_outcomes(clips):
    """Derive conclusions from observed alerts and declared labels, never clip names."""
    if not clips:
        raise ValueError("No clip outcomes to summarize")
    descriptions = []
    matches = 0
    for clip in clips:
        count = clip["nativeCadenceReviewAlerts"]
        positive = clip["declaredLabelPositive"]
        if type(count) is not int or count < 0 or type(positive) is not bool:
            raise ValueError("Invalid alert count or declared label")
        alerted = count > 0
        matches += alerted == positive
        verdict = (
            "matched positive label" if alerted and positive else
            "false alert" if alerted else
            "missed positive label" if positive else
            "matched negative label"
        )
        descriptions.append(
            f"{clip['clip']}: {count} review alert(s), {verdict}."
        )
    return (
        " ".join(descriptions)
        + f" {matches} of {len(clips)} declared clip outcomes matched."
        + " This is not an accuracy estimate."
    )


def apply_scene_decisions(clip, decisions_class):
    engine = decisions_class()
    first_alert = None
    for window in clip["windows"]:
        # The declared core is an independent check. It cannot supply temporal
        # confirmation to the native-cadence sequence.
        isolated = engine if window["protocol"] == "native" else decisions_class()
        people = [{"observed": True} for _ in range(window["observedPeople"])]
        new = isolated.scene_update(
            window["windowEndMs"], people, window["publisherScore"],
            window["windowStartMs"],
        )
        window["newReviewAlert"] = bool(new)
        window["decisionCumulativeAlerts"] = len(isolated.events)
        if new and window["protocol"] == "native" and first_alert is None:
            first_alert = window["windowEndMs"]
    clip["nativeCadenceReviewAlerts"] = len(engine.events)
    clip["firstAlertSourceMs"] = first_alert
    clip["declaredLabelPositive"] = DECLARED_LABELS[clip["clip"]]
    clip["clipDecisionMatchesLabel"] = (
        bool(engine.events) == clip["declaredLabelPositive"]
    )


def enrich_source_metadata(clip, candidates):
    path = Path(clip["path"])
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    expected = next(c for c in candidates if c["id"] == clip["clip"])["sha256"]
    if actual != expected:
        raise ValueError(f"Source hash mismatch for {clip['clip']}")
    clip["sha256"] = actual
    clip["hashVerified"] = True
    probe = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=width,height,r_frame_rate,duration,start_time", "-of", "json",
        str(path),
    ])
    clip["sourceVideoMetadata"] = json.loads(probe)["streams"][0]
    clip["frameRegion"] = "entire source frame resized to 224x224, no crop"
    first = next(w for w in clip["windows"] if w["protocol"] == "native")
    clip["firstModelWindowEndMs"] = first["windowEndMs"]
    clip["firstModelWindowInferenceMs"] = first["inferenceMs"]


def render_report(data):
    lines = [
        "# Two declared clip checks", "",
        "This is an isolated CPU-only replay of the current float32 Core ML "
        "model and native RGB/window/tensor helpers. It applies the unchanged "
        "scene decision function. No live alerts were created or thresholds changed.",
        "",
        "The two clips were chosen before inference. They are not an independent "
        "holdout; training overlap is unknown. Labels describe the declared visible "
        "action, not dense human ground truth. These two outcomes cannot establish "
        "90% accuracy.", "",
        "| Clip | Window (s) | Backbone softmax | Publisher second softmax | "
        "Rectangle people / poses | New review alert | CPU inference |",
        "|---|---:|---:|---:|---:|---|---:|",
    ]
    for clip in data["clips"]:
        for window in clip["windows"]:
            lines.append(
                f"| {clip['clip']} ({window['protocol']}) | "
                f"{window['windowStartMs']/1000:.3f}–{window['windowEndMs']/1000:.3f} | "
                f"{window['modelScore']:.6f} | {window['publisherScore']:.6f} | "
                f"{window['observedPeople']} / {window['posePeople']} | "
                f"{'yes' if window['newReviewAlert'] else 'no'} | "
                f"{window['inferenceMs']:.0f} ms |"
            )
    lines += [
        "", summarize_outcomes(data["clips"]), "",
        "modelScore is the existing backbone's class-1 softmax output, not a raw "
        "logit. publisherScore applies the existing publisher's second softmax "
        "to the two backbone outputs. The scene decision uses publisherScore. "
        "Neither score is a calibrated violence probability.", "",
        "The isolated scene gate requires at least two rectangle detections, "
        "publisher score ≥0.4 on two windows no more than one second apart, or a "
        "single score ≥0.7, with an eight-second scene cooldown. Pose count does "
        "not replace rectangle count for this decision.", "",
        "This replay does not exercise the active transport/runtime gates: ready "
        "state, video received within three seconds, source/report freshness, "
        "people/fight timestamp separation ≤1.5 seconds, socket report deduplication, "
        "or the persisted eight-second camera cooldown across reconnects. Here, "
        "person detections are computed from the same source frame as the fight "
        "window end. It therefore cannot establish end-to-end alert delivery.", "",
        "The post-fix replay admits actual decoded frames at least 200 ms after "
        "the preceding admitted source PTS, with a 0.001 ms roundoff tolerance. "
        "It keeps source PTS without rescaling. Native windows use the existing "
        "≥3.8-second readiness rule and ≥400 ms prediction interval. Exact source "
        "timestamps and bounds are in JSON.", "",
        "The declared-core row independently checks nominal 0.5–4.5 seconds; "
        "its confirmation state is not mixed into the native cadence. The "
        "preserved baseline used a nearest 5 Hz source grid, so its native rows "
        "are not a controlled tolerance-only comparison. Core rows keep the same "
        "requested interval. The tolerance fixes floating-point boundary losses; "
        "model weights, preprocessing and score thresholds are unchanged.", "",
        "BGRA decoding and CPU-only Vision were used on Mac. Phone capture can "
        "be NV12, and Vision can choose another processor on phone. This does "
        "not measure phone runtime, camera-angle generalization, busy-worker "
        "frame dropping, or end-to-end alert latency. First alert source time "
        "is null when no alert occurred. CPU inference excludes model load and "
        "compilation.", "",
        "Reproduce from repository root:", "", "```sh",
        "mkdir -p test-results/native-two-clip",
        "swiftc -O mobile/ios/Nivra/NativeFightVision.swift "
        "mobile/ios/Nivra/NativePeopleVision.swift "
        "mobile/scripts/evaluate-native-clips.swift -o /tmp/nivra-native-clip-eval",
        '/tmp/nivra-native-clip-eval "/path/to/footage/fights/cuts"',
        'service/.venv/bin/python mobile/scripts/report-native-clips.py '
        '"/path/to/footage/fights"',
        "```", "",
    ]
    return "\n".join(lines)


class OutcomeRegressionTests(unittest.TestCase):
    def test_miss_and_correct_negative_are_derived(self):
        clips = [
            {"clip": "positive", "nativeCadenceReviewAlerts": 0,
             "declaredLabelPositive": True},
            {"clip": "negative", "nativeCadenceReviewAlerts": 0,
             "declaredLabelPositive": False},
        ]
        summary = summarize_outcomes(clips)
        self.assertIn("missed positive label", summary)
        self.assertIn("matched negative label", summary)
        self.assertIn("1 of 2", summary)
        self.assertNotIn("false alert", summary)

    def test_changed_results_report_detection_and_false_alert(self):
        clips = [
            {"clip": "positive", "nativeCadenceReviewAlerts": 1,
             "declaredLabelPositive": True},
            {"clip": "negative", "nativeCadenceReviewAlerts": 2,
             "declaredLabelPositive": False},
        ]
        summary = summarize_outcomes(clips)
        self.assertIn("matched positive label", summary)
        self.assertIn("negative: 2 review alert(s), false alert", summary)
        self.assertIn("1 of 2", summary)
        self.assertNotIn("missed positive label", summary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("footage_directory", nargs="?", type=Path,
                        help="Directory containing candidates.json")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        result = unittest.TextTestRunner().run(
            unittest.defaultTestLoader.loadTestsFromTestCase(OutcomeRegressionTests)
        )
        return 0 if result.wasSuccessful() else 1
    if not args.footage_directory:
        parser.error("footage_directory is required unless --self-test is used")
    candidates_path = args.footage_directory / "candidates.json"
    if not candidates_path.is_file():
        parser.error("footage_directory must contain candidates.json")

    sys.path.insert(0, str(ROOT / "service"))
    from nivra.decision import Decisions

    out = ROOT / "test-results/native-two-clip"
    data = json.loads((out / "raw.json").read_text())
    candidates = json.loads(candidates_path.read_text())
    for clip in data["clips"]:
        enrich_source_metadata(clip, candidates)
        apply_scene_decisions(clip, Decisions)
    data["outcomeSummary"] = summarize_outcomes(data["clips"])
    data["scoreSemantics"] = {
        "modelScore": "backbone class-1 softmax, not a raw logit",
        "publisherScore": "publisher second softmax at class 1; decision input",
        "calibratedViolenceProbability": False,
    }
    data["limitations"] = [
        "two predeclared clips only", "training overlap unknown",
        "not independently annotated holdout",
        "CPU-only source-time replay, not phone scheduling or end-to-end latency",
        "same-frame people counts, not asynchronous transport/runtime gates",
    ]
    data["decisionRules"] = (
        "isolated nivra.decision.Decisions.scene_update; excludes transport/runtime gates"
    )
    (out / "results.json").write_text(json.dumps(data, indent=2) + "\n")
    (out / "README.md").write_text(render_report(data))
    print(data["outcomeSummary"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
