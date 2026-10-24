# Ten-video test

New to this development run. Source videos and model thresholds were frozen before inference. Training-source overlap is unknown. The ten smallest eligible files were used for the deadline; this is a convenience sample, not a representative benchmark.

Full source videos, complete 4-second windows at 2-second stride, plus a final complete window when needed. Actual JPEG / Vite proxy / backend requests. Alert decisions are summarized by the application's TypeScript FightDecision.

| Video | Expected | Result | Duration | Windows | First alert in video |
|---|---|---|---|---|---|
| [T01](http://127.0.0.1:5173/backend/evaluation/videos/T01.mp4) | Fight | Detected | 23.2 s | 11 | 14.0 s |
| [T02](http://127.0.0.1:5173/backend/evaluation/videos/T02.mp4) | Fight | Detected | 40.1 s | 19 | 8.0 s |
| [T03](http://127.0.0.1:5173/backend/evaluation/videos/T03.mp4) | Fight | Detected | 53.1 s | 26 | 6.0 s |
| [T04](http://127.0.0.1:5173/backend/evaluation/videos/T04.mp4) | Fight | Detected | 54.0 s | 26 | 6.0 s |
| [T05](http://127.0.0.1:5173/backend/evaluation/videos/T05.mp4) | Fight | Detected | 128.0 s | 63 | 18.0 s |
| [T06](http://127.0.0.1:5173/backend/evaluation/videos/T06.mp4) | Normal | False alert | 6.6 s | 3 | 6.0 s |
| [T07](http://127.0.0.1:5173/backend/evaluation/videos/T07.mp4) | Normal | Correctly quiet | 10.6 s | 5 | — |
| [T08](http://127.0.0.1:5173/backend/evaluation/videos/T08.mp4) | Normal | False alert | 28.5 s | 14 | 8.0 s |
| [T09](http://127.0.0.1:5173/backend/evaluation/videos/T09.mp4) | Normal | Correctly quiet | 29.5 s | 14 | — |
| [T10](http://127.0.0.1:5173/backend/evaluation/videos/T10.mp4) | Normal | Correctly quiet | 40.0 s | 19 | — |

8/10 videos classified correctly. TP 5, TN 3, FP 2, FN 0.

Median model inference: 1988.8 ms; range 1438.2–7612.5 ms. This excludes video-window collection and confirmation delay.

The result is video-level: a video is positive if the actual application decision engine raises at least one two-window alert. A correct positive does not prove every alert occurred inside the annotated fight interval. First alert time is source-video time, not physical webcam wall-clock latency. This sample alone does not validate 90% general accuracy.

5 windows exceeded the live client's four-second response-age limit and were discarded before alert decisions. The offline scan does not simulate browser sampling, health-retry backoff, or a physical webcam. Click a video ID to inspect its source file while the local demo server is running.

Where frame annotations were available, results.json records the delay from annotated fight onset and any alert whose preceding six-second evidence span did not overlap an annotation. T02 and T05 have no matched frame-level annotation in the downloaded index; their timing remains unverified. Frame indices were converted using each decoded video’s actual frame rate.

## False-alert signals

- T06: visual above threshold in 3 windows.
- T08: fast above threshold in 9 windows; visual above threshold in 1 windows.

The false alerts were kept in the score. No model or threshold was changed after viewing this test set.

## Sources

- T01: [OE9t3XImErk](https://huggingface.co/datasets/jherng/xd-violence/resolve/8eba22ca666b5061cf4f3e1b1907c05af520dc07/data/video/test_videos/v%3DOE9t3XImErk__%231_label_B1-0-0.mp4)
- T02: [BpargJW29Wo](https://huggingface.co/datasets/jherng/xd-violence/resolve/8eba22ca666b5061cf4f3e1b1907c05af520dc07/data/video/test_videos/v%3DBpargJW29Wo__%2300-00-50_00-01-30_label_B1-0-0.mp4)
- T03: [gENp4SyNxkI](https://huggingface.co/datasets/jherng/xd-violence/resolve/8eba22ca666b5061cf4f3e1b1907c05af520dc07/data/video/test_videos/v%3DgENp4SyNxkI__%231_label_B1-0-0.mp4)
- T04: [Q8K7roZu3WU](https://huggingface.co/datasets/jherng/xd-violence/resolve/8eba22ca666b5061cf4f3e1b1907c05af520dc07/data/video/test_videos/v%3DQ8K7roZu3WU__%231_label_B1-0-0.mp4)
- T05: [Y1hxr1MWLjM](https://huggingface.co/datasets/jherng/xd-violence/resolve/8eba22ca666b5061cf4f3e1b1907c05af520dc07/data/video/test_videos/v%3DY1hxr1MWLjM__%231_label_B1-0-0.mp4)
- T06: [hgoGZZSMhMQ](https://huggingface.co/datasets/jherng/xd-violence/resolve/8eba22ca666b5061cf4f3e1b1907c05af520dc07/data/video/test_videos/v%3DhgoGZZSMhMQ__%231_label_A.mp4)
- T07: [mfFYGFJhBI4](https://huggingface.co/datasets/jherng/xd-violence/resolve/8eba22ca666b5061cf4f3e1b1907c05af520dc07/data/video/test_videos/v%3DmfFYGFJhBI4__%231_label_A.mp4)
- T08: [GnN9VTh_s2A](https://huggingface.co/datasets/jherng/xd-violence/resolve/8eba22ca666b5061cf4f3e1b1907c05af520dc07/data/video/test_videos/v%3DGnN9VTh_s2A__%231_label_A.mp4)
- T09: [rmDBn5Rpd3s](https://huggingface.co/datasets/jherng/xd-violence/resolve/8eba22ca666b5061cf4f3e1b1907c05af520dc07/data/video/test_videos/v%3DrmDBn5Rpd3s__%231_label_A.mp4)
- T10: [y7JEq-kf-2I](https://huggingface.co/datasets/jherng/xd-violence/resolve/8eba22ca666b5061cf4f3e1b1907c05af520dc07/data/video/test_videos/v%3Dy7JEq-kf-2I__%2300-01-50_00-02-30_label_A.mp4)
