# Fight detector validation

Checked on 22 October 2026 on an Apple M5 MacBook Air with 24 GB RAM.

## What is implemented

The webcam sends a JPEG filmstrip of 32 RGB frames, each 224 × 224 pixels, to a loopback-only FastAPI service. Sampling targets 8 FPS, covering about four seconds. There is at most one request in flight per browser session and one inference in flight at the backend. Overlapping windows are analyzed as processing permits. No frames are recorded or sent to a cloud service.

A window is positive when any of these conditions holds:

| Signal | Input | Threshold |
|---|---|---|
| X3D-M realtime | 16 frames sampled from the window | 0.4 |
| X3D-M baseline | All 32 frames | 0.7 |
| ViT appearance | Mean class-1 output across four frames | 0.9 |

Two consecutive positive windows raise a human-review event. They overlap and are not independent measurements. Two quiet windows rearm the event; an eight-second cooldown prevents repeated alerts. Source changes, pauses, stale frames, and errors clear pending evidence. A result more than four seconds old is rejected.

The two X3D thresholds follow the checkpoint author's realtime and pre-retrain settings. The ViT threshold is a development choice to reduce false positives. This combination was selected using the clips below; it is not a calibrated probability of violence. Appearance alone can trigger a review without a temporal action model agreeing.

## Checkpoint integrity and loading

All model state dictionaries load strictly, with no missing or unexpected keys. Downloaded files must match pinned SHA-256 hashes. PyTorch checkpoints use `weights_only=True` with only NumPy numeric metric types allowlisted. ViT uses safetensors.

| Checkpoint | Revision | SHA-256 |
|---|---|---|
| `visionlab-ai/school-violence-detection-models`, `final/final_x3d_realtime.pt` | `a744b6af7496f0cbfa4f0ba32acd46b65e52d4e1` | `e833f69d110f167cad4a6c38d385564bdb2f6de63d246e45cb03ff9aa17f0349` |
| Same repository, `x3d_m/x3d_m_best.pt` | Same revision | `5b8e4f95d3b7aa0d9df941f3fffbf07b8b35dac82ded4e994c60b91daa138a50` |
| `jaranohaal/vit-base-violence-detection`, `model.safetensors` | `31931091dfd4ea08a30c42be0db8e1488263cbd5` | `9eec3237288742eb4267cb2cbbbdacba5bee889be4673215bfe40e1dbd5621a5` |

The ViT card describes a Transformers loader, but the actual safetensors file has timm parameter names. The implementation uses `timm.create_model('vit_base_patch16_224', num_classes=2)` and strict loading. A naive Transformers load left the weights unmatched; those outputs were discarded. The source config does not name its labels. Treating class 1 as the violence signal is an empirical inference from the labelled development clips, not confirmed source metadata.

X3D preprocessing uses RGB, 224 × 224 full-frame resize, mean 0.45 and standard deviation 0.225. It retains the author's second softmax and corresponding thresholds. ViT uses RGB with mean and standard deviation 0.5. Scores across these models are not directly comparable.

## Development clip checks

The existing NIVRA footage pack supplied eight action segments from six incidents and three calm segments. The local squat fixture supplied another negative. Some action segments share an incident, so the 12 clips are not 12 independent incidents. First-window results below use decoded frames before JPEG transport.

| Clip | Expected | Ensemble window |
|---|---|---|
| F01 | Action | Positive |
| F02 | Action | Positive |
| F03 | Action | Positive |
| F04 | Action | Positive |
| F05 | Action | Positive |
| F06 | Action | **Missed** |
| F07 | Action | Positive |
| F08 | Action | Positive |
| C01 | Calm | Negative |
| C02 | Calm | Negative |
| C03 | Calm | Negative |
| pose-squats | Exercise | Negative |

That is 7/8 action clips detected and 4/4 negative clips correctly left quiet: 11/12 development checks. The realtime X3D-M alone detected 3/8 action clips in its original 16-frame check. The 32-frame baseline, R(2+1)D-18, and a bus-tuned VideoMAE were also explored; no published score was substituted for local results.

These results do not establish 90% accuracy, precision, recall, or live-webcam performance. The set is tiny, selected, partly correlated, and used to choose the implementation. It lacks enough hugging, dancing, sports, camera motion, poor-lighting, and crowded negative cases. An independent evaluation must use unseen source videos and report both missed incidents and false alerts per hour.

### Actual HTTP/JPEG transport check

The same 12 clips were encoded as 32-frame JPEG filmstrips and sent through the Vite proxy to the running backend. Outcomes were unchanged: 7/8 action clips positive and 4/4 negatives quiet. An additional previously excluded two-second pre-incident segment, P01, was flagged by the appearance signal (0.911) despite being labelled pre-incident. This is a false positive in that clip check, not evidence of predicting a future fight. The short clip differs from the four-second live window, so it is also not a direct measurement of live alert behavior.

Across all 13 transport checks, 11 were correct: one missed action clip and one false positive. Median inference was 1,784 ms, with a 1,462–3,657 ms range under varying load. The new negative exposed a failure; thresholds were not retuned to hide it. Full scores are saved locally in the ignored `transport.local.json` file.

## Runtime and verification boundaries

The ensemble ran on CPU for X3D and Apple MPS for ViT. Development clip inference ranged from about 1.4 to 2.8 seconds under varying load. First-alert latency also includes window collection and confirmation; inference time alone is not end-to-end alert latency.

The original 16-frame detector was verified through the browser using a prerecorded fight clip as a camera stream: it raised a review event. A calm replay stayed clear. This is replay evidence, not a physical-camera test. Automated lifecycle tests cover confirmation, acknowledgement, stop/restart, paused input, delayed results, and backend failure. The combined detector was verified through HTTP/JPEG transport and the ten-video offline scan below; a full physical-camera trial remains unverified.

Physical webcam verification needs the user's camera permission and an attended, non-contact trial. The shared preview reported camera permission blocked. No physical fight was staged or requested.

## Ten new whole-video tests

Five fighting and five normal videos from the XD-Violence test-file index were selected before inference, using the smallest eligible files with distinct source IDs to fit the deadline. They were new to this development run; overlap with model training videos is unknown. The exact source revision, URLs, labels, and SHA-256 hashes are saved in `evaluation/inputs.json`. Dataset code identifies B1 as fighting and A as normal.

The scan covered all ten videos, 413.5 seconds of source media, using 200 complete four-second windows at two-second stride. Each window passed through the running JPEG/Vite/backend path. The app's actual TypeScript `FightDecision` produced the alerts. Five windows exceeding the live client's four-second response-age limit were discarded before decisions. Browser sampling and recovery backoff were not simulated.

Result: **8/10 correct (80%)**, with 5 true positives, 3 true negatives, 2 false positives, and 0 false negatives at video level. Recall was 5/5 and precision was 5/7 on this small sample. The 90% target was not met. Correct positive labels do not establish frame-level incident coverage or general accuracy.

T06, a crowded walkway, produced appearance-only false alerts. T08, showing people in formation, produced false alerts primarily from the fast video model. These descriptions are based on sampled frame inspection; the published dataset labels supply the scoring labels. The settings were not changed after seeing these failures.

Median window inference was 1,989 ms, with a 1,438–7,613 ms range under varying load. Source-video first-alert positions ranged from 6 to 18 seconds; these are not physical webcam wall-clock delays. The full offline scan took 567.9 seconds.

See [per-video report and playable files](evaluation/REPORT.md), [raw predictions](evaluation/predictions.json), and [decision results](evaluation/results.json).

To reproduce from the application directory, keep `npm run demo` running in one terminal and use another:

```bash
../.venv-fight/bin/python backend/evaluate_videos.py
node --experimental-strip-types scripts/summarize-fight-evaluation.mjs
```

The evaluator downloads any missing source files from their pinned URLs and verifies hashes. It does not change model weights or thresholds.

## Sources

- [X3D checkpoints and model card](https://huggingface.co/visionlab-ai/school-violence-detection-models)
- [Author's wrapper and inference application](https://huggingface.co/spaces/visionlab-ai/school-violence-detection-app/tree/main)
- [ViT checkpoint and model card](https://huggingface.co/jaranohaal/vit-base-violence-detection)
- [PyTorchVideo X3D](https://pytorch.org/hub/facebookresearch_pytorchvideo_x3d/)
