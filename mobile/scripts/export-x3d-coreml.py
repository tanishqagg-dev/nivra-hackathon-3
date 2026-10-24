#!/usr/bin/env python3
"""Convert the existing X3D candidate and verify generated-input numerical parity.

Run in an isolated environment with coremltools==9.0 and numpy==1.26.4.
The prepared service environment supplies the existing Torch/PyTorchVideo runtime.
No model weights are downloaded. Both export lowerings preserve graph mathematics.

Stage the verified iOS resource with:
  python mobile/scripts/export-x3d-coreml.py --output mobile/ios/Models/NivraX3D.mlpackage
Use float32. The half-precision prototype failed numerical parity and is not shipped.
"""
import argparse
import copy
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'service'))
for runtime_packages in (ROOT/'service/.venv/lib').glob('python*/site-packages'):
    sys.path.append(str(runtime_packages))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT/'mobile/artifacts/models/NivraX3D.mlpackage')
    parser.add_argument('--precision', choices=['float32', 'float16'], default='float32')
    args = parser.parse_args()
    import numpy as np
    import torch
    import coremltools as ct
    from nivra.x3d_candidate import X3DCandidate, CHECKSUM

    class PhoneGraph(torch.nn.Module):
        def __init__(self, backbone):
            super().__init__()
            self.backbone = backbone
        def forward(self, frames):
            scores = self.backbone((frames/255-.45)/.225)
            return scores, scores.softmax(-1)

    candidate = X3DCandidate()
    reference_graph = PhoneGraph(candidate.model.cpu()).eval()
    class ExportSwish(torch.nn.Module):
        def forward(self, value): return value*torch.sigmoid(value)
    class ExportGlobalAverage(torch.nn.Module):
        def forward(self, value): return value.mean(dim=(2,3,4), keepdim=True)
    def lower_export_ops(module):
        for name, child in module.named_children():
            if type(child).__module__ == 'pytorchvideo.layers.swish' and type(child).__name__ == 'Swish':
                setattr(module, name, ExportSwish())
            elif isinstance(child, torch.nn.AdaptiveAvgPool3d):
                if child.output_size not in (1, (1,1,1)):
                    raise RuntimeError('Only exact global average pooling can be lowered.')
                setattr(module, name, ExportGlobalAverage())
            else: lower_export_ops(child)
    lowered = copy.deepcopy(candidate.model)
    lower_export_ops(lowered)
    graph = PhoneGraph(lowered).eval()
    generator = torch.Generator().manual_seed(42)
    example = torch.randint(0, 256, (1,3,16,224,224), generator=generator).float()
    with torch.inference_mode():
        original = reference_graph(example)
        lowered_output = graph(example)
        lowering_error = max(float((a-b).abs().max()) for a,b in zip(original,lowered_output))
        if lowering_error > 1e-6: raise RuntimeError('Export lowering changed the original model output.')
        traced = torch.jit.trace(graph, example)
    started = time.perf_counter()
    model = ct.convert(traced, source='pytorch', convert_to='mlprogram',
        inputs=[ct.TensorType(name='frames', shape=example.shape, dtype=np.float32)],
        outputs=[ct.TensorType(name='backboneScores', dtype=np.float32), ct.TensorType(name='publisherScores', dtype=np.float32)],
        compute_precision=ct.precision.FLOAT32 if args.precision=='float32' else ct.precision.FLOAT16,
        minimum_deployment_target=ct.target.iOS17, compute_units=ct.ComputeUnit.CPU_ONLY)
    model.short_description = 'NIVRA experimental X3D-M RWF-2000 candidate. Scores are not calibrated probabilities.'
    model.input_description['frames'] = 'RGB float32 0..255, NCTHW [1,3,16,224,224]. Uniform16-frame temporal sample; fullframe resized224x224.'
    model.output_description['backboneScores'] = 'Existing checkpoint backbone softmax, two classes. Candidate fight score at index1.'
    model.output_description['publisherScores'] = 'Existing publisher second softmax, two classes. Current service decision score at index1.'
    model.user_defined_metadata.update({'checkpointSHA256':CHECKSUM,'experimental':'true','preprocessing':'(RGB / 255 - 0.45) / 0.225','precision':args.precision})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    conversion_seconds = time.perf_counter()-started
    results = []
    for label, value in [('gray',torch.full_like(example,127)), ('seeded_pixels',example)]:
        with torch.inference_mode():
            start=time.perf_counter();reference=reference_graph(value);torch_ms=(time.perf_counter()-start)*1000
        samples=[]
        for _ in range(3):
            start=time.perf_counter();prediction=model.predict({'frames':value.numpy()});samples.append((time.perf_counter()-start)*1000)
        difference=max(float(np.max(np.abs(reference[i].numpy()-prediction[name]))) for i,name in enumerate(('backboneScores','publisherScores')))
        if not np.isfinite(difference) or difference > (.002 if args.precision=='float16' else .0001):
            raise RuntimeError(f'Core ML numerical parity failed for {label}: {difference}')
        results.append(dict(input=label,maxAbsoluteError=difference,torchMs=round(torch_ms,2),coreMLCPUColdMs=round(samples[0],2),coreMLCPUWarmMs=round(min(samples[1:]),2)))
    # Never publish an artifact whose measured conversion parity failed.
    model.save(str(args.output))
    result=dict(output=str(args.output),precision=args.precision,checkpointSHA256=CHECKSUM,packageBytes=sum(path.stat().st_size for path in args.output.rglob('*') if path.is_file()),conversionSeconds=round(conversion_seconds,2),inputShape=[1,3,16,224,224],minimumIOS=17,exportLoweringMaxAbsoluteError=lowering_error,comparisons=results,physicalIPhoneVerified=False)
    (args.output.parent/(args.output.stem+'-conversion.json')).write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))


if __name__=='__main__':main()
