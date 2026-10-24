# Source-package verification

Checked on 24 October 2026.

- `npm ci --ignore-scripts` completed using the committed lockfile.
- `npm run verify`: lint passed, 236 frontend tests passed, TypeScript and Vite production build passed.
- Backend unittest discovery: 33 tests passed using the existing local Python environment.
- Credential-pattern scan of source and configuration found no matches for the checked common token/private-key patterns. This is not a security audit.
- Local runtime data, recordings, dependency folders, signing material and generated model weights are excluded from Git.
- `npm audit` reported six dependency advisories: three high and three moderate, affecting source-map-js, undici, vite and Vitest-related dependencies. No dependency upgrades were made during source packaging.

The packaged source was not validated with a fresh model download, physical camera, iPhone/Android build or public deployment in this packaging run. Mobile model export prerequisites and older hosted-protocol limits are documented in `mobile/README.md`.
