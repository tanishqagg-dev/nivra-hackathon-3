# Optional public proxy configuration

This directory contains an example Vercel configuration. Its rewrite points to `https://YOUR-TUNNEL.example.invalid` and must be replaced with an endpoint you control before deployment. The example forwards all routes; it is not limited to guard routes and does not add authentication.

The separate static landing-page source is in `../landing`. The desktop demo can run locally without either deployment.

Set `NIVRA_GUARD_PUBLIC_URL` to your own reachable guard URL when testing remote responder phones. The default in this submission is local-network pairing. Do not reuse the team's historical tunnel or expose the owner API without appropriate access controls.
