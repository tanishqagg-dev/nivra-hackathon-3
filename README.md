# NIVRA — Hackathon 3.0

NIVRA helps a human operator review possible physical conflict and coordinate a response. This repository contains the current project source snapshot for Team Damage Control, Bal Bharati Public School, Pitampura.

Project website: https://nivra.aestrum.in

## Run the desktop demo

Use Node.js 24, uv, Python 3.11, and a current Chrome browser. The desktop USB integration is designed for macOS. First setup needs internet access to install dependencies and download third-party model weights.

```bash
cd nivra-vision-lab
npm ci
npm run fight:setup
npm run build
npm run demo
```

Open the local URL printed by Vite, normally http://127.0.0.1:5173. Allow camera access and wait for model readiness. The Python inference API uses port 18765; the separate guard listener uses port 18766. Stop the demo with Ctrl+C.

For the browser-only motion-rule mode, run `npm run dev -- --host 127.0.0.1` and choose MediaPipe motion rules in Detection settings. This mode does not require the Python fight models.

## Included source

- `nivra-vision-lab/src/`: React/TypeScript operator interface, camera inputs, browser vision workers, review and dispatch workflows.
- `nivra-vision-lab/backend/`: FastAPI inference, model decision policy, guard pairing, incident storage and USB phone transport.
- `nivra-vision-lab/backend/guard_static/`: responder phone interface.
- `mobile/`: iOS and Android companion source, tests and build scripts. See its README for build prerequisites and integration limits.
- `service/nivra/x3d_candidate.py`: model loader required by the optional Core ML export script.
- `nivra-vision-lab/deploy/`: landing page and example deployment configuration.
- `docs/PROJECT_DOCUMENTATION.md`: project explanation, architecture, setup, limitations and submission scope.

## Verification

```bash
cd nivra-vision-lab
npm run verify
cd backend
../../.venv-fight/bin/python -m unittest discover -p 'test_*.py'
```

Browser integration tests are available through `npm run test:e2e` after installing Playwright Chromium.

## Configuration and data

A fresh copy uses local-network guard links. Configure `NIVRA_GUARD_PUBLIC_URL` only when you have deployed your own reachable guard endpoint. The Vercel rewrite deliberately contains a placeholder and must be configured before deployment. The repository does not contain the team's running infrastructure credentials or tunnel address.

Guard registries, incident records, recordings, local logs, signing profiles, dependencies and generated model weights are excluded. The code can store incident media locally; authorized incident sharing is part of the response workflow. Do not treat public deployment as having production authentication or security review.

## Model and project limitations

NIVRA uses third-party pretrained models and experimental motion rules. It does not establish intent, guilt or a crime. False alerts and missed events remain possible; every alert requires human review. Model scores are not accuracy measurements. The reported ten-video diagnostic classified 8/10 clips correctly and is not a deployment benchmark. See the backend validation report and third-party notices.

The source is public for review and hackathon reference. No new license grant for original project code is added here; third-party components retain their own licenses.
