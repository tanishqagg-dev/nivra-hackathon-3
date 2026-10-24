"""Cross-model confirmation. A single model cannot raise a fight window."""
import math

THRESHOLDS = {"fast": .4, "temporal": .7, "visual": .9}
ENGINE_VERSION = "consensus-v2"


def needs_temporal(fast: float, visual: float) -> bool:
    return (fast >= THRESHOLDS["fast"]) != (visual >= THRESHOLDS["visual"])


def decide(scores: dict[str, float | None]) -> dict:
    for value in scores.values():
        if value is not None and (not math.isfinite(value) or not 0 <= value <= 1):
            raise ValueError("Invalid model score")
    triggers = [name for name, threshold in THRESHOLDS.items()
                if scores.get(name) is not None and scores[name] >= threshold]
    return {"aboveThreshold": len(triggers) >= 2, "triggers": triggers,
            "agreement": {"votes": len(triggers), "required": 2}}
