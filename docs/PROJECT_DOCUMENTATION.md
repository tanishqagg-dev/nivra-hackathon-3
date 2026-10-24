# NIVRA project documentation

## Submission details

- Event: Hackathon 3.0
- School: Bal Bharati Public School, Pitampura
- Team: Team Damage Control
- Project: NIVRA
- Website: https://nivra.aestrum.in

- Theme: Theme 4 — Community and Civic Innovation
- Category: Category 2

## Problem and purpose

A camera feed only helps when someone notices an event and responds. NIVRA brings possible physical conflict to an operator's attention, provides a review workflow and lets that person notify a responder. Its intended settings include schools and other monitored spaces with an authorized operator.

The prototype supports local webcam and video inputs, browser pose overlays, trained local fight analysis, phone-camera transport, incident history and responder alerts. Compatibility with an arbitrary CCTV installation is not established by the prototype.

## Workflow

1. Start the local services and select an available camera or video source.
2. Browser vision or the Python classifier processes recent frames. Pose overlays and model status help the operator understand what is being observed.
3. A possible event enters the review workflow. The operator checks the scene and decides what to do.
4. A human can acknowledge, dismiss or dispatch an alert to a paired guard. The application does not automatically call police.
5. The guard acknowledges the alert and updates response status. Incident notes and available media support later review.

## Architecture

The operator interface uses React, TypeScript and Vite. MediaPipe workers perform browser pose and object analysis. Motion rules consider observations across time rather than treating a single pose as evidence of conflict.

A FastAPI service performs local webcam fight classification. The ensemble combines two X3D temporal models and a ViT appearance model; the implementation and thresholds are in `backend/detector.py` and `backend/policy.py`. Weights are downloaded during setup from pinned third-party sources. NIVRA did not train these models.

The inference service binds to loopback. A separate guard listener provides responder pages and authenticated guard routes. Guard pairing uses expiring invitations and hashed credentials. The browser application proxies local API calls during development and preview. Publishing that proxy requires deployment-specific access controls; loopback binding alone does not secure an externally exposed proxy.

Incident storage writes local metadata and bounded media. Current limits include seven-day retention, a 500 MB media quota and a maximum of 1,000 incident records. Guard state persists locally; alert state and availability depend on the running host.

The optional iOS companion includes USB camera transport and experimental native analysis. Android companion code is also included. Mobile build prerequisites and compatibility boundaries are documented separately.

## Installation and operation

Follow the repository README for the desktop setup. Install Node.js 24 and uv first. `npm ci` installs the locked JavaScript dependencies. `npm run fight:setup` prepares Python 3.11 and model dependencies. `npm run build` creates the preview build. `npm run demo` starts the local services.

Allow browser camera access only when using a live camera. Use prerecorded or safely staged footage for demonstrations. Physical contact is not required to show the review and dispatch workflow.

For responder testing, pair a guard using the operator interface and keep the phone page open. Public access requires a reachable deployment configured by the person running the project. The published source contains example configuration, not access to the team's live host.

## Testing and evidence

Unit tests cover temporal rules, browser service behavior, React hooks, guard pairing, incident storage, USB transport and model decision policy. Browser integration tests cover workflow behavior. They do not establish classifier accuracy.

The retained ten-video diagnostic classified eight videos correctly: five labelled fight videos were detected and three of five normal videos stayed quiet. Two normal videos produced alerts. Training-set overlap is unknown. This small sample does not establish a general accuracy rate or satisfy a 90% target. Detailed source links and results are in `backend/evaluation/REPORT.md`.

Physical-device capture, mobile delivery, network behavior and camera placement need verification in the actual deployment. The project should not be described as a validated emergency-response system.

## Privacy and limitations

Inference runs locally, but the incident workflow can persist clips, stills, notes and event metadata. Authorized responder access to media must be considered when deploying the application. Private recordings, guard records, credentials and signing files are not included in this submission.

Occlusion, poor feed quality, sports, play and unusual camera views can cause missed events or false alerts. Appearance-based classification can react to still images. Phone background restrictions may interrupt alerts. The host must stay online for remote responders. No automatic police decision, facial identity or proof of criminal intent is claimed.

## Future work

Priorities include representative held-out evaluation, camera-specific calibration, more reliable responder delivery, deployment authentication and access controls, retention controls and supervised pilots. These are future work, not claims about current readiness.

## Source and acknowledgements

See `nivra-vision-lab/THIRD_PARTY_NOTICES.md` for MediaPipe, model, icon and library provenance. The source snapshot contains the application, backend, responder pages, mobile companion code, tests and setup/build scripts. Generated weights, build outputs, private evaluation recordings and signing credentials are intentionally excluded.
