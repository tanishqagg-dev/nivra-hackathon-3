# NIVRA Vision: product plan

Goal: turn the demo page into software a site would actually install. Someone lands on the site, sets up a camera and a guard in under five minutes, then leaves the console open all shift.

Look: NIVRA monochrome, matching nivra.tanishq.work. Apple system font, white pages, a black live console, black and white pills, grey hairlines. Red only for alarms and police, green only for the live dot. Full rules in `docs/redesign-contract.md`.

## Who uses it

- **Owner or manager.** Sets it up once. Adds cameras, guards and the site location. Checks incidents the next morning.
- **Operator.** Watches the console during a shift. Needs to see an alert within a second and act in two clicks.
- **Guard.** Never sees the Mac app. Gets the phone alert, the siren and the map (already built).

Every screen is judged by one question: can the operator act on a fight in under five seconds without reading anything?

## Routes

No router dependency. A small hash router in `src/lib/route.ts`.

| Route | Screen | Who |
| --- | --- | --- |
| public domain | Landing page (separate Vercel deploy) | Visitors, the presentation audience |
| `#/` | Redirects to console, or to setup on first run | |
| `#/setup` | Onboarding wizard (5 steps) | Owner, first run |
| `#/console` | Live console | Operator, all day |
| `#/incidents` | Incident log and detail | Owner, review |
| `#/settings` | Cameras, guards, site, detection | Owner |

First run: if no site is saved, "Open console" sends you to `#/setup`. After setup, `#/` keeps a "Go to console" button in the top bar.

## 1. Landing page

The product itself is the hero. Here is the order of the page, top to bottom.

1. **Hero: a live feed with the alert happening.** A real recorded clip of two people, the green skeletons on top, and the confidence bar climbing to the alert. Under it sits one line: "Spots a fight on your existing cameras and rings a guard's phone in seconds." There are two buttons, "Set up a camera" (goes to `#/setup`) and "Watch it work" (scrolls down).
2. **What happens in 4 seconds.** A horizontal timeline of real frames: two people → poses tracked → fight confirmed → guard's phone rings with a map → guard on scene. Each step shows a real screenshot, not an icon.
3. **The guard's phone.** A large phone render of the actual guard page, ringing, with the slide-to-stop. Text: no app store, pair by QR, works on any phone.
4. **Privacy and control.** Video stays on the Mac. Only the alert, the location and the camera name are sent. Police are never called automatically; a person always decides.
5. **Works with what you have.** Mac webcam, an iPhone over USB, a recorded video file. Shows the three as photos.
6. **Footer CTA.** "Set up your first camera." Nothing else.

There is no logo marquee, pricing table or feature card grid.

## 2. Onboarding wizard (`#/setup`)

The wizard is a full-screen flow with a step rail on the left (5 dots) and one task per screen. Each step can be skipped except the camera step. Progress is saved in `localStorage` so a reload does not lose it.

1. **Name the site.** Site name ("Main gate, Sector 21") and camera name. These two fields feed the alert text the guard sees.
2. **Connect a camera.** Three big choices: This Mac's camera, iPhone over USB, Video file. The live preview appears in the same card once connected, with the model loading status under it ("Pose model ready, 41 fps").
3. **Set the location.** Use this Mac's location, or paste a Maps link. Shows the mini map. Explains in one line that the guard gets this map.
4. **Pair a guard.** Name → QR code. The step waits and turns green when the phone pairs ("Asha's phone is linked"). Skip is allowed.
5. **Test alert.** One button sends a test alert to the paired guard. You see their status change from Ringing to Acknowledged. Then "Open console".

## 3. Live console (`#/console`)

The console starts from what works now (one camera, a hidden alert rail) and turns it into a real VMS layout.

- **Left: camera list (collapsible, 240px).** Each camera has a thumbnail, its name, a status dot (Live, Offline, Alert), and fps. "Add camera" at the bottom opens the same picker as the wizard. With one camera the list still shows, so it is clear more cameras can be added.
- **Centre: the view.** Layout switcher 1 / 2x2 / 3x3. With one real camera the default is 1-up. Empty grid slots say "Add camera" instead of showing fake feeds.
- **Camera tile overlay.** Camera name, live clock, fps, the likelihood meter. Red ring when alerting.
- **Right: alert rail.** Slides in on an alert, as now. It shows the incident card with a still frame from the moment of detection, the three actions (Acknowledge, Call guard, Call police), guard progress and the map.
- **Bottom: activity strip.** The last five events as a thin timeline. Clicking one opens the incident.
- **Top bar.** Site name, global status ("All clear" or "1 active alert"), guards on duty count, sound toggle, and links to Incidents and Settings.

Diagnostics, detection sliders and the USB pairing panel move out of the console into Settings. The console shows only what an operator acts on.

## 4. Incidents (`#/incidents`)

- **List.** Table: time, camera, type, peak likelihood, guard, outcome (Acknowledged, Guard on scene, Police called, Dismissed). Filters for today, 7 days, all, plus a camera filter.
- **Detail.** Still frames from before, during and after; the timeline of who did what and when (detected, acknowledged by operator, guard called, guard acknowledged, on scene, cleared, police); the map; and notes.
- **Storage.** Incidents are saved by the backend to `incidents.local.json` with a still and the 5 second clip, so they survive a reload.

## 5. Settings (`#/settings`)

Left tabs:

- **Site:** name, location, timezone.
- **Cameras:** list, rename, remove, add (webcam / USB iPhone / file). The USB code entry lives here.
- **Guards:** the current GuardPanel (list, QR invite, remove).
- **Detection:** sensitivity (Instant / Balanced / Careful), the current sliders behind an "Advanced" section, sound.
- **System:** model status, fps, backend health, public guard link (nivra.aestrum.in).

## 6. Fight clip (5 seconds)

Every alert gets a 5-second clip: 2.5s before the alert and 2.5s after, with the skeletons drawn in. Pre-roll matters because the start of a fight is the part you need to see.

- **How:** the console keeps a rolling buffer of the last 3s of frames (640x360, about 20 fps, roughly 60 frames in memory). When an alert fires, it keeps capturing for 2.5s more, then encodes the frames to a WebM file with MediaRecorder. The clip is ready about 3 seconds after the alert.
- **Where it shows:** a player at the top of the alert rail with a red "Alert" marker on the scrubber; the incident detail page with a frame strip; a Download button.
- **Storage:** the backend saves it as `incidents/<id>.webm` next to the incident (about 1 MB each). Old clips are deleted after 7 days, or when the folder passes 500 MB.
- **Guard phone:** optional (see open questions). If on, the guard page plays the clip muted while ringing. The clip goes through the tunnel only to paired guards.

## 7. Phone screens

- **Guard page (nivra.aestrum.in):** four states. Pair (QR scan or code), All clear (shift control, recent activity), Ringing (red edge, still or clip, map with distance and directions, slide to stop), Responding (progress steps, on scene, clear, police).
- **NIVRA iPhone app as a camera:** choose a role (Guard phone or Camera), Connect to Mac (8-character code, USB detected), Streaming (live view with fps, battery and temperature, screen dims to save heat). This needs changes in the iOS app as well.
- **Mobile landing page:** the hero, a vertical "how it works" timeline and the privacy diagram.

## Build order

1. Router, app shell and top bar. Move the current console into `#/console` unchanged so the demo keeps working.
2. Settings page. Move the detection settings, USB, guards and location out of the console.
3. Onboarding wizard.
4. Console layout: camera list, grid switcher, activity strip, alert stills.
5. Incidents: backend store and the list and detail pages.
6. Fight clip: buffer, encoder, backend storage, player in the rail and incident pages.
7. Guard phone redesign (clip, distance, recent activity).
8. Landing page, using real screenshots and a recorded clip from steps 1 to 5.
9. Tests: update the Playwright specs to `#/console`; add specs for setup, incidents and landing; run the full suite and the guard e2e.

Work happens on a branch (`product-ui`) so the working demo on `main` stays safe until the new UI passes all tests.

## Risks

- **Multi-camera detection is not real yet.** The grid supports several tiles, but running pose detection on more than one stream at once will cut fps. v1 runs the model on the selected camera only and says so on the other tiles.
- **Incident stills** need a frame grab at detection time. The canvas is already available, so this is cheap.
- **The landing hero clip** needs a recording of the real model. I will capture it from the test scenario so it is honest footage.
