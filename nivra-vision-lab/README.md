# NIVRA Vision Lab

A local camera and video workspace with trained fight detection, optional body skeletons, and audible review alerts. Webcam fight analysis uses a Python backend on this Mac. Motion rules and object analysis use MediaPipe inside the browser. Inference runs locally. Incident records can include locally saved clips and stills.

## Run locally

Requirements: Node.js 24, [uv](https://docs.astral.sh/uv/), and a current Chrome browser. Setup installs Python 3.11 and downloads pinned model weights.

```bash
npm ci
npm run fight:setup
npm run build
npm run demo
```

Open the URL printed by Vite, normally `http://127.0.0.1:5173`. Keep the server running. Do not open `index.html` directly.

## Live webcam fight demo

1. Wait for **Fight model ready**, click **Start camera**, and allow access. If the embedded preview blocks camera access, open the local address in your browser.
2. Keep the interaction clearly visible. About four seconds of fresh frames prepare the first window. Two consecutive positive windows raise a review banner and optional tone. On the tested Mac, each combined inference took roughly 1.4–2.8 seconds; this adds to alert delay.
3. Check the scene and click **Acknowledge**. Stop releases the camera and clears pending evidence. A paused or frozen source must collect fresh frames before it can alert again.

The ensemble combines a 16-frame X3D-M checkpoint, a 32-frame X3D-M checkpoint, and a high-threshold ViT appearance classifier. Appearance alone can trigger a review, so a still image or nonviolent scene may also cause a false alert. Scores are model outputs, not accuracy measurements. See [validation and model details](backend/VALIDATION.md).

**Latest test: 8/10 new source videos classified correctly (80%).** It detected all five labelled fight videos and correctly left three of five normal videos quiet. Two normal videos caused false alerts. See the [ten-video report, with playable source links](backend/evaluation/REPORT.md). These videos were new to this development run; overlap with model training sources is unknown. This does not meet or validate the 90% target. Physical webcam verification remains an attended check.

The earlier development set had 11 correct classifications out of 12 clips, with one missed action clip. An additional two-second pre-incident negative produced a false positive, giving 11/13 across those clip checks. The first 12 clips helped select the model combination and thresholds; they are not an independent accuracy benchmark.

For the original browser-only detector, run `npm run dev -- --host 127.0.0.1` and select **Detection settings → Webcam fight detector → MediaPipe · motion rules**. Video files and scripted scenarios continue to use the original motion rules.

## iPhone camera over USB

Use an iPhone running the installed NIVRA app as the live camera, over a cable. No Wi-Fi or internet is needed.

1. Plug the iPhone into the Mac, unlock it and tap **Trust** if asked. The workspace shows **iPhone found on USB**.
2. On the phone, open NIVRA, tap **Other options**, then **Start camera without scanning**. Keep NIVRA open and the phone unlocked.
3. Type the 8-character code from the phone into the Mac and click **Link phone**. The live camera switches to the phone and the trained fight model analyses it.

The backend pulls the phone's latest JPEG through macOS usbmuxd on phone port 8940 (adapted from NIVRA `service/nivra/usb_transport.py`). The code stays in memory; unlink or restart to forget it. If frames stop for five seconds, the camera shows as interrupted.

## Guard phones

Guards get alerts on their own phones at **https://nivra.aestrum.in/guard**, on any network. A person on the Mac reviews every alert before anything is sent.

The domain is a Vercel project (`deploy/guard-domain`) that forwards `/guard` to this Mac through Tailscale Funnel (`tailscale funnel --bg --set-path /nivra-lab http://127.0.0.1:18766`). The Mac must stay on, online and running `npm run demo`. Set `NIVRA_GUARD_PUBLIC_URL=` (empty) to fall back to same-Wi-Fi QR codes.

1. In **Guards**, type a name and click **Add guard**. A one-time QR appears and lasts five minutes.
2. Scan the QR with the NIVRA app or the phone camera. The phone stays linked after reloads.
3. On the phone, tap **On shift**. Keep the page open with the screen on.
4. Every review has three buttons: **Acknowledge**, **Call guard** and **Call police**. Check the scene first. **Call guard** notifies the best available guard (online and on shift first); a picker appears when more than one guard is linked. With no guard linked, it opens guard setup. The phone rings and vibrates until the guard taps **Acknowledge**, then **I'm on scene** and **Clear alert**. The Mac shows each step.

**Call police** (112) is on every open alert, on the phone and on the Mac. It opens the dialer and records who tapped it and when. NIVRA never calls police by itself. Change the number in `src/hooks/useGuards.ts` and `backend/guard_static/app.js` if your site uses another.

Guard phones reach a separate listener on port 18766. It serves only the guard page and that guard's own alerts: no unrestricted access to other guards or the owner inference API. The Mac API stays on loopback and is not reachable through the domain. Guard names, shifts and hashed phone keys persist in `backend/guards.local.json`; alerts reset when the backend restarts. Locked or backgrounded phones may not ring, and there is no push notification.

## Check a two-person interaction with motion rules

Select **MediaPipe · motion rules** for this workflow. Object analysis starts off to leave more processing time for pose analysis.

1. Wait for `Waiting for camera`, then click **Start camera** and allow access, or open a local **Video file**.
2. Keep both people's shoulders and hands in view. Hips and legs may be cropped out. The **Physical conflict** panel shows detected skeletons, usable upper bodies, usable arms, and nearby pairs, with a specific reason when it cannot assess the interaction.
3. NIVRA compares fresh poses across time. It looks for repeated fast arm extensions and retractions directed toward the other person's upper body. It checks body-relative motion so a camera pan or walking movement alone is not evidence.
4. Cameras use **Standard** sensitivity: three distinct motion pulses within five seconds can create **Possible physical conflict**, a visible review banner, and a local tone. Video files default to **Early review**, which accepts two clear arm-motion episodes and a slightly wider approach direction for bent arms. A bent-arm approach also needs an observed withdrawal. If an elbow is hidden, wrist-only evidence needs stricter motion checks and four pulses in either mode. Check the scene and **Acknowledge** the event.

Use prerecorded or safely staged non-contact footage for a demo. Do not strike anyone to test it. A single-person air punch does not satisfy the two-person rule.

The camera needs a view of the arm moving toward the other person. Punches directed straight into the camera can have little visible 2D extension and may be missed. Upper-body framing uses shoulder-based scale, not invented leg joints. Each displayed skeleton uses up to 33 available landmarks; hidden or low-confidence joints are not drawn as reliable bones.

Side-on shoulders can overlap in the image. When both hips are visible, the detector uses torso size instead of rejecting a narrow shoulder width. A missing body can rejoin its recent motion history within two seconds only through a close, unambiguous full-torso match. Its velocity resets and it must warm up again. No hidden person is drawn or treated as observed. Similar people can still be confused; these are temporary matches, not identities.

**Detection settings** offers Full/Lite pose models, a 2/4/6/8-person cap, and pose confidence. Full processes inputs up to 960 pixels on the longest side; Lite uses up to 640. More people and a larger model cost time. The cap does not guarantee that many people will be found. Lowering confidence can recover weak detections but also create false poses; it does not lower the temporal conflict checks.

The MediaPipe mode is an experimental motion-rule detector. It does not establish physical contact, intent, injury, or a crime. Sports and play can look similar, and occlusion or missed poses can hide a real conflict. Test representative positive and negative clips before any deployment.

## Optional object watch

Turn on **Object analysis** under **Detection settings** first.

1. Wait for `Waiting for camera`, then click **Start camera** and allow camera access.
2. Place a supported item, such as a backpack, bottle, or phone, clearly in view. Wait for it to appear under **Objects in view**.
3. Click **Watch item** beside it. NIVRA watches one selected item at a time.
4. Move the item away from that position or remove it from view. Sustained movement or disappearance creates a review event, a camera banner, and a short tone when sound is available.
5. Check what happened, then click **Acknowledge**. The event remains in the session log. Use **Rearm** to watch the item's new position, or **Clear watch** to choose another item.

An ordinary object appearing does not trigger an alarm. Automatic rules also look for unattended bags, rapid bag transitions, and repeated detections of knives, scissors, or baseball bats. These are observations for a person to review, not proof of theft or danger.

Under **Detection settings**, adjust object confidence, the people limit, and the unattended-bag timer. Lower confidence may reveal more items but also more false detections. Stop or source changes clear the session's tracks, watch, and review queue.

## Video and test scenario

**Video file** opens a local video without uploading it once the models are ready. MP4 with H.264 or WebM is a useful starting point; playback depends on browser codec support. Portrait footage is letterboxed so heads and feet are not cropped by the display.

Video files start in **Review scan**. It samples every 40 ms of source video and waits for each pose result before advancing. This is 25 sample positions per video second, not a promise to decode every original frame in an arbitrary file. A scan can take longer than playback. Motion speed, evidence windows, and object timers use the original video timestamps, while inference latency and processed FPS still measure actual processing time.

Review scans use the CPU reference runtime. The supplied sparring clip produced different motion evidence on GPU and CPU during verification; the CPU path is the tested reference for this mode, not a claim that CPU is always more accurate. Opening a review scan can briefly reload the models. Cameras and real-time video attempt GPU unless it has already failed in this session. The selected runtime is shown under **Detection settings**.

Choose **Real-time playback** under **Detection settings → Video analysis** to watch at normal speed and skip frames while analysis is busy. Stop an active clip before changing mode. Live camera processing always stays real-time. Faster playback is less reliable for brief actions when the model cannot keep up.

**Video review sensitivity** starts on **Early** to bring short striking-like sequences to a human's attention. It can flag martial-arts practice, sparring, or play. Choose **Standard** for the original three-episode rule. Neither setting identifies crime or intent, and neither is a calibrated probability. Visibility, implausible-jump rejection, the five-second window, minimum episode spacing, and alert cooldowns still apply.

Use **Pause**, **Resume**, **Replay**, and **Stop**. Paused time never counts toward an alert. Replaying a completed scan starts a fresh observation window; Stop or a source change cancels pending analysis and clears the session. The final sampled result is processed before a scan is marked complete.

**Test scenario** runs scripted observations through the event rules. The default scene shows repeated directed arm movements. **Waving · no conflict** is a quiet comparison. The other scenes watch a moving backpack or show a person leaving a bag behind. **Replay** resets the scene and queue.

The test scenario does not run object recognition on real footage. Its events and metrics are labeled as simulated. It checks the alert workflow, not model accuracy.

## Sound and recovery

Sound alerts start enabled. Click **Test sound** to check browser audio and your speaker volume. If sound is blocked, check the site's sound permission and click again. Muting **Sound alerts** cancels current tones; visual reviews continue. The explicit test button can still play a preview while automatic alerts are muted.

If camera permission is blocked, allow it for the site and browser in macOS **System Settings → Privacy & Security → Camera**, then try **Start camera** again. If an embedded browser stays blocked, open the local address in Chrome. Choose another camera from the camera selector if needed. A local video or test scenario is also available. **Retry analysis** or **Restart analysis** reloads failed or stalled models.

Known software WebGL renderers, such as SwiftShader, start on CPU directly. Hardware or unknown renderers still attempt GPU. If the GPU pose worker stops responding, analysis automatically restarts once on CPU and shows a notice. Video files pause during recovery and resume at the same position when the models are ready. Detection settings show the active runtime. If CPU analysis also fails, the app shows a recovery action instead of silently retaining a frozen overlay.

## Local models and offline use

Pose quality starts on **Full**. Choose **Lite** for less model work on slower devices. Changing quality reloads analysis without changing the people limit or confidence settings. The active CPU fallback is retained for the session. Both options use Google's local float16 Pose Landmarker bundles; see the [official model guide](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker).

The application serves these files locally:

- `public/models/pose_landmarker_full.task`
- `public/models/pose_landmarker_lite.task`
- `public/models/efficientdet_lite0_float16.tflite`
- `public/mediapipe/wasm/`

After dependencies are installed, the local server and bundled models do not need an internet connection. This is not an installed offline web app; keep the local server running. Production builds include the same assets in `dist/`.

`npm run models:prepare` verifies the three model checksums and downloads missing files from Google's version-pinned URLs. It leaves an existing file unchanged if its checksum differs. The script needs a connection only for missing models; normal inference never uses those remote URLs. WASM assets are already included under `public/mediapipe/wasm/`.

## Commands

```bash
npm run lint
npm run test
npm run build
npm run test:e2e
```

Playwright's first run may require:

```bash
npx playwright install chromium
```

For a supplied local clip, run the opt-in diagnostic test after building:

```bash
NIVRA_TEST_VIDEO=/absolute/path/to/clip.mp4 npx playwright test tests/local-clip.spec.ts
```

Add `NIVRA_EXPECT_REVIEW=1` when that clip is expected to produce a physical-conflict review. The test observes the real workers, blocks non-local network requests, and checks sample timing. It writes diagnostic landmark traces and screenshots to `test-results/`; this is test instrumentation, not application recording. Do not commit private footage or its traces. Passing one clip does not establish detection accuracy.

## How it works

- `useVisionSession` manages camera, video, and scripted inputs, playback, frame capture, and session cleanup.
- `BrowserCameraSource` owns camera permission, device selection, and track cleanup.
- Two instances of `vision.worker.ts` isolate the MediaPipe runtimes. Real-time pose analysis uses GPU when available; Review scans use CPU. Object detection uses a lower-frequency CPU worker so the two graphs do not contend for WebGL.
- `VisionWorkerClient` gives each task independent backpressure, publishes object observations without waiting for another pose result, and drops stale frames instead of accumulating latency. Cached overlays expire when their worker stops returning results.
- `SceneEngine` maintains temporary tracks, a selected-item watch, and rules that require observations across frames.
- `ConflictEngine` associates upper-body poses across frames and checks body-scale-normalized arm velocity, swept movement paths, extension, retraction, repeated pulses, visibility, sampling gaps, and alert cooldowns. Its evidence progress is not a probability of violence. Pending motion resets when model settings change; existing reviews remain.
- `ReviewTonePlayer` generates tones with Web Audio. It handles blocked audio, cancels pending playback, and releases completed audio nodes.
- The video element displays the source once. Canvas draws the aligned skeletons, object boxes, and watch position.

## Privacy boundary

- Inference uses the local browser and Python backend. Incident clips and stills can be saved on the host.
- Microphone audio is never requested. Optional alert tones are generated locally as browser audio output.
- A linked USB iPhone sends frames to this Mac. Incident metadata and bounded recordings can persist locally; see backend/incidents.py for retention limits.
- Guard phones receive their assigned alerts. The current incident workflow also supports authorized access to incident media.
- Person and object tracks are temporary observations, not stable identities.
- Review events describe visible changes and never assert intent, guilt, or a crime.

## Detection limits

EfficientDet-Lite0 recognizes a fixed set of common COCO objects. Small items, occlusion, poor lighting, overlapping people, and unusual viewpoints can cause missed or incorrect detections. A watched item disappearing may mean it was hidden rather than removed. Temporary tracks can switch when similar objects overlap.

This build does not detect firearms, identify people, determine ownership or intent, or establish whether an action is illegal. No real-world accuracy or four-person frame-rate guarantee is claimed. Test representative footage before relying on its observations.

The review panel selects one pair at a time, and an eight-second global alert cooldown limits repeat tones. Simultaneous incidents are not independently covered. Automated checks include real model inference on a two-person composite of the local exercise fixture, cropped upper-body inference, model switching, and scripted positive/negative motion sequences. These checks are not an evaluation of real fight detection accuracy.

The [BlazePose model card linked by Google](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf) describes fitness-oriented use and places surveillance and life-critical decisions outside its intended use. A larger pose model does not validate NIVRA's conflict rules for those uses.

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for MediaPipe attribution.
