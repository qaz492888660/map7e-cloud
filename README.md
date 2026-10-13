# Worker 0.2.17 delivery only

This branch distributes the previously validated, complete single-file Worker bundle. It is not an application branch, deployment workflow, or confirmation of a live deployment. Do not merge this branch.

Source: be27c424da4214faffc8fac77a8ae241a5eeb8be. Worker source compiled from 10122966975a584e8ffe78b6225b89306f47f630 and unchanged in that HEAD.

File: map7e-worker-0.2.17.js; 90,605 bytes.

SHA-256: a7987e222b1821b08615d16e89a597dc09fda334f8cda64186a32ebe432d4938

The bundle was recovered without rebuilding. ES module syntax and default export were checked; no static or dynamic imports remain. Static credential checks found no hardcoded production values. Existing tests/build evidence is reused.

On the GitHub file page, use Download raw file to save the JavaScript file. If the raw file opens as text, save it with the exact .js filename. Never use the unbundled services/media-gateway/src/worker.js as this release file.

For the existing map7e-quark-media-gateway only, read the current version before any publish. If it is already 0.2.17 or newer, do not deploy or roll back. If still 0.2.16, replace the existing entry file contents in Edit code with this entire bundle, preserving configuration, Secrets and media.map7e.com. Deploy once. Then read the active version/deployment, 100% traffic, health 200/0.2.17 and no-ticket 401. A download or a Deploy click is not functional acceptance.

No production credentials, app sources, or GitHub Actions workflow are included. vercel.json disables automatic deployment for this delivery branch only; main and the PR branch are not changed.
