# Map7e Cloud

Map7e Cloud is a mobile-first web interface for browsing a protected PikPak drive. Static files under public/ provide the app shell and underwater background; routes under api/ handle authenticated directory, download, and upload requests.

## Interface

- The home screen has a non-clickable Map7e space overview and real image/file counts from directory entries the app has loaded. Counts do not include unopened nested folders.
- Albums are searchable in a three-column mobile grid. Images open in an in-page viewer with swipe navigation, zoom, available metadata, and an original-download action.
- Files appear as folder and file rows. Folders open the next directory level; current-directory search filters its files and folders.
- File rows support downloads and browser previews for image, PDF, text, and video types when the browser and PikPak download response allow them.
- Uploads use the protected direct-upload ticket API and submit file content to PikPak.
- The video background is the same source clip served by https://blog.map7e.com/videos/underwater.mp4. A 1080p H.264 copy converted from that clip is loaded first; the blog's original HEVC video is the fallback source.
- Scrolling stays in document flow. The layout uses dynamic viewport sizing and iOS safe-area insets.

## Key Paths

- public/index.html: browser entrypoint and mobile viewport settings
- public/components/CloudStoragePage.vue: home, albums, file browser, viewer, previews, login, and upload interface
- api/cloud-login.js, api/cloud-logout.js, lib/cloud-auth.js: protected cloud session
- api/pikpak-files.js, api/pikpak-download.js, api/pikpak-upload-ticket.js: authenticated PikPak operations
- public/assets/underwater-h264.mp4: browser-compatible copy of the blog video
- public/files/library.json: retained static sample manifest; the live interface reads PikPak through the API
- vercel.json: static path rewrites; Vercel also serves the API functions

## Configuration

The Vercel project needs PIKPAK_PAT and CLOUD_PASSWORD. Configure both for each environment in which the protected APIs should work. The session cookie is signed with PIKPAK_PAT.

## Developer Admin

Open `/admin` to manage global access and the type/access metadata for the current PikPak folders. Administrator authentication uses a separate HttpOnly cookie; it does not reuse the visitor login as an administrator credential. `ADMIN_PASSWORD` is only the bootstrap password used before an administrator password hash has been saved. On the first successful login with Upstash configured, the bootstrap password is stored as a scrypt hash. Later logins use the saved hash, so changing `ADMIN_PASSWORD` during a deployment will not overwrite a password changed in the dashboard.

The **设置 → 修改管理员密码** form requires the current admin session and current password. It saves only a scrypt hash to Upstash, increments the admin session version, and invalidates existing admin sessions. Passwords and hashes are never sent back by the API or saved in browser local storage.

Folder metadata is stored by PikPak folder ID in Upstash Redis through its REST API. It is map7e-cloud metadata and does not change PikPak folder names or contents. Folders without a saved record default to `type: folder` and `access: inherit`. Global access defaults to `locked`, preserving the existing password gate.

To enable persistent settings and admin password changes, create or connect an Upstash Redis database in Vercel. The server requires the bootstrap password plus one complete Redis REST variable pair:

- `ADMIN_PASSWORD`
- Either `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, or Vercel Upstash integration's `KV_REST_API_URL` + `KV_REST_API_TOKEN`.

Use the `ADMIN_PASSWORD` value only for first-time initialization. Keep the Upstash REST URL and token secret. When the same Upstash database is attached to Preview and Production, Preview uses a separate `map7e-cloud:preview:` keyspace; Production keeps the existing `map7e-cloud:` keys so the two environments cannot overwrite each other's settings.

Keep the existing `PIKPAK_PAT` and `CLOUD_PASSWORD` configured as before. Deploy once after adding the variables. After that, changes made at `/admin` are persisted immediately and do not require another build or deployment. The management page remains read-only for settings while the Redis variables are missing or unavailable; it never falls back to process memory.

When the global policy is locked, only explicitly public top-level folders are listed to unauthenticated visitors. The admin folder list also provides a direct `?folderId=...` link for explicitly public nested folders. Opening inherited or locked content and downloading its files requires the existing cloud password session. These checks run in the serverless API routes as well as in the UI.

## Local Preview

The UI assets can be served with any static server, but live directory, login, download, and upload actions require the Vercel API runtime and environment variables.

Run:

    python3 -m http.server 8080 --directory public

Backend and permission tests can be run without installing dependencies:

    node --test tests/*.test.js
