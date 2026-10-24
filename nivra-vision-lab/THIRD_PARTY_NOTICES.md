# Third-party notices

## Local fight models

The webcam ensemble uses pretrained weights from [visionlab-ai/school-violence-detection-models](https://huggingface.co/visionlab-ai/school-violence-detection-models), whose repository metadata declares MIT, and [jaranohaal/vit-base-violence-detection](https://huggingface.co/jaranohaal/vit-base-violence-detection), whose metadata declares Apache-2.0. The visionlab card also describes research/noncommercial usage; its metadata and prose should not be treated as a resolved commercial license grant.

X3D architectures are supplied by [PyTorchVideo](https://github.com/facebookresearch/pytorchvideo) under Apache-2.0. The ViT architecture is supplied by [timm](https://github.com/huggingface/pytorch-image-models) under Apache-2.0. These are third-party trained models, not models trained by NIVRA. Revisions, hashes, loading details, and local validation limits are in [backend/VALIDATION.md](backend/VALIDATION.md).

## MediaPipe Tasks Vision

This project uses `@mediapipe/tasks-vision`, the MediaPipe Pose Landmarker Full and Lite models, and the EfficientDet-Lite0 float16 object-detection model from Google AI Edge.

- Package: <https://www.npmjs.com/package/@mediapipe/tasks-vision>
- Source: <https://github.com/google-ai-edge/mediapipe>
- Pose model guide: <https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker>
- Full pose model, float16 version 1: <https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task>
- Lite pose model, float16 version 1: <https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task>
- Pose model card: <https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf>
- Object detector model: <https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/latest/efficientdet_lite0.tflite>
- License: Apache License 2.0, <https://www.apache.org/licenses/LICENSE-2.0>
- Full upstream license text: [licenses/MEDIAPIPE-LICENSE.txt](./licenses/MEDIAPIPE-LICENSE.txt)

The worker-based integration follows architectural patterns from Google's official MediaPipe browser samples:

- Source: <https://github.com/google-ai-edge/mediapipe-samples-web>
- License: Apache License 2.0

Copyright 2026 The MediaPipe Authors. Licensed under the Apache License, Version 2.0.

Model versions and SHA-256 checksums are pinned in `scripts/prepare-models.mjs`.

## qrcode.react

Guard pairing QR codes use [qrcode.react](https://github.com/zpao/qrcode.react) 4.2.0 under the ISC License.

## Phosphor Icons

Interface icons come from `@phosphor-icons/react`, the icon set the NIVRA app uses.

- Package: <https://www.npmjs.com/package/@phosphor-icons/react>
- Source: <https://github.com/phosphor-icons/react>
- License: MIT

## Landing page motion

The public landing page in `deploy/guard-domain/` vendors GSAP 3.15 (ScrollTrigger, SplitText) and Lenis 1.3. Versions, sources and licenses are listed in `deploy/guard-domain/assets/vendor/README.md`.
