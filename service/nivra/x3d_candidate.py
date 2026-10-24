"""Opt-in experimental RWF-2000 candidate; not a validated classroom classifier."""
import hashlib
from pathlib import Path
import cv2
import numpy as np
import torch

CHECKSUM = 'e833f69d110f167cad4a6c38d385564bdb2f6de63d246e45cb03ff9aa17f0349'
SOURCE = 'https://huggingface.co/visionlab-ai/school-violence-detection-models/tree/a744b6af7496f0cbfa4f0ba32acd46b65e52d4e1'


def scalar(*args):
    # Compatibility for publisher's numpy-2 numeric metadata with our numpy-1 runtime.
    return np.core.multiarray.scalar(*args)


scalar.__module__ = 'numpy._core.multiarray'


class X3DCandidate:
    def __init__(self, path=None):
        path = Path(path or Path(__file__).resolve().parents[1] / 'models/x3d_rwf2000.pt')
        with path.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != CHECKSUM:
                raise ValueError('X3D checkpoint checksum mismatch')
        # Only known numeric metadata constructors are allowlisted. No remote code
        # or unrestricted pickle loading is used, even though the publisher does it.
        with torch.serialization.safe_globals([scalar, np.dtype, type(np.dtype('float64')), type(np.dtype('float32'))]):
            checkpoint = torch.load(path, map_location='cpu', weights_only=True)
        from pytorchvideo.models.hub import x3d_m
        self.model = x3d_m(pretrained=False)
        self.model.blocks[-1].proj = torch.nn.Sequential(torch.nn.Dropout(.3), torch.nn.Linear(2048, 2))
        self.model.load_state_dict({key.removeprefix('backbone.'): value for key, value in checkpoint['model'].items()}, strict=True)
        self.device = 'cuda' if torch.cuda.is_available() else 'cpu'
        self.model.eval().to(self.device)
        torch.set_num_threads(4)

    @torch.inference_mode()
    def predict(self, frames):
        indices = np.linspace(0, len(frames)-1, 16).astype(int)
        images = np.stack([cv2.resize(frames[i][:, :, ::-1], (224, 224)) for i in indices])
        clip = torch.from_numpy(images).permute(3, 0, 1, 2).float().to(self.device) / 255
        result = self.model(((clip-.45)/.225)[None])[0]
        # The upstream wrapper retains the backbone Softmax; its demo applies a
        # second Softmax. Report both so this distinction cannot be hidden.
        return {'backboneScore': float(result[1]), 'publisherScore': float(result.softmax(-1)[1])}
