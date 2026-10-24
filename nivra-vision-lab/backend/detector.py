"""Pinned, fight-fine-tuned X3D-M inference. No remote inference or recording."""
from __future__ import annotations

import hashlib
import os
import shutil
import time
from pathlib import Path

import av
import numpy as np
import torch
from torch import nn
from pytorchvideo.models.hub import x3d_m
from policy import decide, needs_temporal

MODEL_REPO = "visionlab-ai/school-violence-detection-models"
MODEL_REVISION = "a744b6af7496f0cbfa4f0ba32acd46b65e52d4e1"
MODEL_FILE = "final/final_x3d_realtime.pt"
MODEL_PATH = Path(__file__).parent / "models" / "final_x3d_realtime.pt"
MODEL_SHA256 = "e833f69d110f167cad4a6c38d385564bdb2f6de63d246e45cb03ff9aa17f0349"
FRAMES = 32
FAST_FRAMES = 16
SIZE = 224
THRESHOLD = 0.4


class ChannelSoftmax(nn.Module):
    """Equivalent channel softmax without MPS's unsupported 5-D memory format."""
    def forward(self, tensor: torch.Tensor) -> torch.Tensor:
        return tensor.flatten(2).softmax(dim=1).reshape(tensor.shape)


class FightDetector:
    def __init__(self, device: str = "cpu") -> None:
        torch.set_num_threads(int(os.environ.get("NIVRA_TORCH_THREADS", "4")))
        if not MODEL_PATH.exists():
            from huggingface_hub import hf_hub_download
            downloaded = hf_hub_download(MODEL_REPO, MODEL_FILE, revision=MODEL_REVISION)
            MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(downloaded, MODEL_PATH)
        self.sha256 = hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest()
        if self.sha256 != MODEL_SHA256:
            raise RuntimeError("Fight checkpoint checksum does not match the pinned model revision")
        self.device = torch.device(device)
        # Match the author's ViolenceX3D wrapper and fail on any missing weights.
        model = nn.Module()
        model.backbone = x3d_m(pretrained=False)
        features = model.backbone.blocks[-1].proj.in_features
        model.backbone.blocks[-1].proj = nn.Sequential(nn.Dropout(0.3), nn.Linear(features, 2))
        # The checkpoint includes NumPy numeric validation metrics alongside tensors.
        with torch.serialization.safe_globals([np._core.multiarray.scalar, np.dtype,
                                                np.dtypes.Float64DType, np.dtypes.Float32DType]):
            checkpoint = torch.load(MODEL_PATH, map_location="cpu", weights_only=True)
        state = checkpoint.get("model", checkpoint.get("model_state_dict", checkpoint))
        model.load_state_dict(state, strict=True)
        if self.device.type == "mps":
            model.backbone.blocks[-1].activation = ChannelSoftmax()
        self.model = model.backbone.to(self.device).eval()
        # Warm up before advertising readiness.
        self.predict(np.zeros((FAST_FRAMES, SIZE, SIZE, 3), dtype=np.uint8))

    def predict(self, frames: np.ndarray) -> dict:
        if frames.shape != (FAST_FRAMES, SIZE, SIZE, 3) or frames.dtype != np.uint8:
            raise ValueError("Expected 16 RGB uint8 frames of 224 × 224 pixels")
        started = time.perf_counter()
        tensor = torch.from_numpy(frames.copy()).permute(3, 0, 1, 2).float().div_(255)
        tensor = tensor.sub_(0.45).div_(0.225).unsqueeze(0).to(self.device)
        with torch.inference_mode():
            logits = self.model(tensor)
            # Match the checkpoint author's inference and calibrated 0.4 threshold,
            # including their second softmax after the X3D head activation.
            score = float(torch.softmax(logits, dim=1)[0, 1].cpu())
        if not np.isfinite(score):
            raise RuntimeError("Model returned a non-finite score")
        return {"score": score, "aboveThreshold": score >= THRESHOLD,
                "threshold": THRESHOLD, "inferenceMs": round((time.perf_counter() - started) * 1000, 1)}


def pinned_file(relative_path: str, repo: str, revision: str, remote_path: str, sha256: str) -> Path:
    path = MODEL_PATH.parent / relative_path
    if not path.exists():
        from huggingface_hub import hf_hub_download
        cached = hf_hub_download(repo, remote_path, revision=revision)
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(cached, path)
    if hashlib.sha256(path.read_bytes()).hexdigest() != sha256:
        raise RuntimeError(f"Checkpoint checksum mismatch: {relative_path}")
    return path


class FightEnsemble:
    """Require two model votes; skip the third model when it cannot change a decision.

    Thresholds are development choices, not a calibrated violence probability.
    The appearance checkpoint uses timm keys despite its Transformers model card.
    """
    def __init__(self, device: str = "cpu") -> None:
        import timm
        from safetensors.torch import load_file
        self.fast = FightDetector(device)
        self.sha256 = self.fast.sha256
        temporal_path = pinned_file("x3d_m_best.pt", MODEL_REPO, MODEL_REVISION,
                                    "x3d_m/x3d_m_best.pt", "5b8e4f95d3b7aa0d9df941f3fffbf07b8b35dac82ded4e994c60b91daa138a50")
        wrapper = nn.Module()
        wrapper.backbone = x3d_m(pretrained=False)
        wrapper.backbone.blocks[-1].proj = nn.Sequential(nn.Dropout(.5), nn.Linear(2048, 2))
        with torch.serialization.safe_globals([np._core.multiarray.scalar, np.dtype,
                                                np.dtypes.Float64DType, np.dtypes.Float32DType]):
            checkpoint = torch.load(temporal_path, map_location="cpu", weights_only=True)
        wrapper.load_state_dict(checkpoint["model"], strict=True)
        if self.fast.device.type == "mps":
            wrapper.backbone.blocks[-1].activation = ChannelSoftmax()
        self.temporal = wrapper.backbone.to(self.fast.device).eval()
        visual_path = pinned_file("vit/model.safetensors", "jaranohaal/vit-base-violence-detection",
                                  "31931091dfd4ea08a30c42be0db8e1488263cbd5", "model.safetensors",
                                  "9eec3237288742eb4267cb2cbbbdacba5bee889be4673215bfe40e1dbd5621a5")
        self.visual_device = torch.device("mps" if torch.backends.mps.is_available() else device)
        self.visual = timm.create_model("vit_base_patch16_224", pretrained=False, num_classes=2)
        self.visual.load_state_dict(load_file(visual_path), strict=True)
        self.visual = self.visual.to(self.visual_device).eval()
        self.device = f"{self.fast.device} + {self.visual_device}" if self.fast.device != self.visual_device else str(self.fast.device)
        self.predict(np.zeros((FRAMES, SIZE, SIZE, 3), dtype=np.uint8))

    def predict(self, frames: np.ndarray) -> dict:
        if frames.shape != (FRAMES, SIZE, SIZE, 3) or frames.dtype != np.uint8:
            raise ValueError("Expected 32 RGB uint8 frames of 224 × 224 pixels")
        started = time.perf_counter()
        fast_indices = np.linspace(0, FRAMES - 1, FAST_FRAMES).astype(int)
        fast = self.fast.predict(frames[fast_indices])
        visual_frames = frames[np.linspace(0, FRAMES - 1, 4).astype(int)]
        visual_tensor = torch.from_numpy(visual_frames.copy()).permute(0, 3, 1, 2).float().div_(255).sub_(.5).div_(.5).to(self.visual_device)
        with torch.inference_mode():
            visual_score = float(self.visual(visual_tensor).softmax(1)[:, 1].mean().cpu())
            temporal_score = None
            if needs_temporal(fast["score"], visual_score):
                tensor = torch.from_numpy(frames.copy()).permute(3, 0, 1, 2).float().div_(255).sub_(.45).div_(.225).unsqueeze(0).to(self.fast.device)
                temporal_score = float(self.temporal(tensor).softmax(1)[0, 1].cpu())
        scores = {"fast": fast["score"], "temporal": temporal_score, "visual": visual_score}
        return {"score": fast["score"], "scores": scores, **decide(scores),
                "threshold": THRESHOLD,
                "inferenceMs": round((time.perf_counter() - started) * 1000, 1)}


def read_clip(path: str, start: float = 0, seconds: float = 4, num_frames: int = FRAMES) -> np.ndarray:
    with av.open(path) as container:
        stream = container.streams.video[0]
        duration = float(stream.duration * stream.time_base) if stream.duration else float(container.duration or 0) / av.time_base
        fps = float(stream.average_rate or 25)
        if duration <= start:
            raise ValueError("Clip has no readable duration")
        targets = np.linspace(start, min(start + seconds, duration - 1 / fps), num_frames)
        frames = []
        if start > 0:
            container.seek(int(start / stream.time_base), stream=stream, backward=True)
        for index, frame in enumerate(container.decode(stream)):
            timestamp = frame.time if frame.time is not None else index / fps
            while len(frames) < num_frames and timestamp >= targets[len(frames)] - 1e-6:
                frames.append(frame.reformat(width=SIZE, height=SIZE, format="rgb24").to_ndarray())
            if len(frames) == num_frames:
                break
        if not frames:
            raise ValueError("Clip has no readable frames")
        while len(frames) < num_frames:
            frames.append(frames[-1])
        return np.stack(frames)
