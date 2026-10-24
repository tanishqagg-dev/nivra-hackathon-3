# Real model smoke-test clip

`pose-squats.mp4` is a 13-second, 5 FPS, 720 x 1280 clip from the official
[TensorFlow.js pose-detection test data](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/test_data/pose_squats.mp4).

The [upstream test](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/blazepose_tfjs/blazepose_test.ts)
credits [Woman doing squats, Pexels video 4838220](https://www.pexels.com/video/woman-doing-squats-4838220/)
as the original footage. Pexels permits use and modification under its
[Pexels license](https://www.pexels.com/license/). The fixture remains outside the
application's `public` directory and is only used by browser tests.

Downloaded on 2026-09-17 from:
`https://raw.githubusercontent.com/tensorflow/tfjs-models/master/pose-detection/test_data/pose_squats.mp4`

SHA-256: `ea9151e447b301985d5d65666551ef863b369a2e0f3a71ddd58abef2e722f96a`

This test checks that the actual bundled pose and object models detect a person
in a local video. It does not measure bag detection, theft detection, recall,
false-positive rates, or performance on a live camera.

`multi-pose.spec.ts` draws two copies of this clip side by side into a test-only
camera stream, then crops the hips out. It checks actual model output and
upper-body analysis through the normal camera pipeline. No landmark outputs are
injected. This is a composite of one person, not footage of a real interaction,
and does not validate conflict detection accuracy.
