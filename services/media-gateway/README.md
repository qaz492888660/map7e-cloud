# Map7e Media Gateway

Standalone Node.js 22 service for Quark preview, original-file downloads, and video Range streaming. It shares Map7e Cloud's provider and encrypted Upstash storage modules; it does not maintain a second Quark credential store.

## Build and run

Build from the repository root so the image can include the shared `lib/` modules:

```sh
docker build -f services/media-gateway/Dockerfile -t map7e-media-gateway .
docker run --rm -p 8080:8080 --env-file media-gateway.env map7e-media-gateway
```

`GET /health` returns only `{ "ok": true, "version": "0.1.0" }`. Configure the host's health check to use `/health` on port `8080`.

## Required environment

Configure the same Production values used by `cloud.map7e.com`:

| Variable | Purpose |
| --- | --- |
| `MEDIA_GATEWAY_SIGNING_SECRET` | HMAC key shared with Cloud; at least 32 UTF-8 bytes. |
| `MEDIA_GATEWAY_SITE_DOMAIN` | Required site root, such as `map7e.com`; Cloud signs a Gateway URL only when the Cloud and Gateway hosts are within this same site. |
| `MEDIA_GATEWAY_ALLOWED_ORIGIN` | Exact browser origin, normally `https://cloud.map7e.com`. |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Same persistent store as Cloud; alternatively use `KV_REST_API_URL` + `KV_REST_API_TOKEN`. |
| `STORAGE_ENCRYPTION_KEY` | Same effective key Cloud uses to decrypt stored Quark auth. If Cloud currently relies on the legacy `PIKPAK_PAT` fallback, use that same value here until a separate-key migration is done. |
| `QUARK_CLIENT_ID` / `QUARK_SIGN_KEY` | Set only if Cloud overrides the official defaults; values must match Cloud. |

Do not set `VERCEL_ENV=preview`: Cloud's production records use the production Redis key prefix. The Gateway needs no `CLOUD_PASSWORD`, admin session secret, or separate Quark database. Store all values in the host's secret manager; never commit an env file.

In Map7e Cloud Production, set:

```text
MEDIA_GATEWAY_URL=https://media.map7e.com
MEDIA_GATEWAY_SIGNING_SECRET=<same value as Gateway>
MEDIA_GATEWAY_SITE_DOMAIN=map7e.com
```

`MEDIA_GATEWAY_URL` must be an HTTPS origin with no path, query, or fragment, and its hostname must be the Cloud site's hostname or a subdomain under `MEDIA_GATEWAY_SITE_DOMAIN`. The current Cloud site is `cloud.map7e.com`, so `workers.dev` is rejected for signed media links. Add the corresponding DNS record and HTTPS custom domain at the selected host before enabling these variables.

## Request and streaming model

Cloud runs the normal storage lookup and `requireItemRead()` permission check, then signs a five-minute HMAC ticket for exactly one `storageId`, `fileId`, `parentId`, purpose, and optional preview variant. It redirects the browser to the Gateway only after that check.

The Gateway verifies the ticket, re-resolves the selected Quark provider and current auth from the shared encrypted store, checks the file and parent identity again, then obtains a fresh Quark download URL itself. It does not accept an upstream URL from the browser. The Quark media Cookie (`x_pan_client_id`, `x_pan_access_token`, and optional `x_pan_client_token`) stays between Gateway and Quark.

Cloud issues `/v1/media/<identity-HMAC>` URLs. Inline videos use a signed `__Secure-map7e-media-<identity-HMAC>` HttpOnly cookie with that exact `Path`, no `Domain`, `Secure`, and `SameSite=Strict`. The browser sends only the relevant video's grant on each media request, so opening more videos does not grow every request's Cookie header or race with a shared eight-cookie eviction list. There is no application-wide eight-video cap; ordinary browser cookie-storage limits still apply. Video attachments, previews, and other one-shot downloads create no session cookie. Each grant is file and purpose scoped, contains no Quark metadata, and expires six hours after the original ticket was issued. Session-authenticated Range requests do not renew that deadline. The Quark video element uses credentialed CORS so same-site `media.map7e.com` Range requests include this cookie.

Worker 0.2.13 also accepts older `/v1/media` URLs. GET redirects to the matching scoped path before any Provider read; legacy HEAD continues serving Cloud's manual Range probe without a redirect. A valid old root-path video session migrates only when its own file is requested, preserving its original expiry and dropping metadata. Other valid legacy grants remain until their own requests or natural expiry, avoiding concurrent migration deleting another session. Stale-cookie cleanup examines at most 32 names and emits at most 3,000 bytes of deletion headers. Signed-ticket identity and path are checked independently of the browser's cookie-path selection.

The media body is piped as a stream. There is no whole-file array buffer or disk staging. Single byte ranges are forwarded to Quark and its `206`, `Content-Range`, length, type, and range support are checked before safe headers are returned. Invalid, out-of-file, and multipart ranges are rejected. Each range request independently resolves the download URL; a Quark `401` or `403` clears the account-scoped short cache, refreshes the URL once, and retries once.

Upstream media hosts must be HTTPS Quark domains and resolve only to public addresses. Redirects are checked again before following. The Gateway allows only `GET` and `HEAD` on media, restricts CORS to the configured Cloud origin, and logs no ticket, token, Cookie, or upstream URL. Configure the reverse proxy and host access logs to omit or redact query strings, since the initial signed ticket is carried in the Gateway URL.

## Host choice

The service needs a continuously available container or VM, long-lived HTTP responses, Range support, custom HTTPS, and affordable outbound traffic. A small persistent VM is the cost-first option for high media egress; the Singapore Hetzner Cloud region currently includes at least 0.5 TB monthly outbound traffic, with larger plans including more. Fly.io offers Tokyo and Singapore locations with easier managed TLS and machine lifecycle controls, but current Asia-Pacific egress is $0.04/GB. Railway and Render both offer Singapore regions; their published public egress rates are $0.05/GB and $0.15/GB above the workspace allowance, respectively. The attached code is host independent. No host credentials or eligible existing VM were available during implementation, so no provider account, DNS, or deployment has been created.

For a VM deployment, put a reverse proxy such as Caddy in front of this container for automatic HTTPS and route `media.map7e.com` to port `8080`. Disable idle suspension. Keep at least 512 MB RAM for the Node service; memory use is based on active stream chunks, not file size. Test actual Quark playback from the target mobile browsers after deployment.

## Cloudflare Workers deployment

The repository also includes a Fetch/Streams Worker entry point for Cloudflare. Cloudflare Workers support streaming multi-gigabyte response bodies without a response-size cap, and Cloudflare currently charges no data-transfer egress fee. The Free plan has a 100,000-request daily limit and a 10 ms CPU limit per invocation; check current plan limits against expected use. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/), and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

Install the repository dependencies, authenticate Wrangler with `npm exec -- wrangler login --device`, then build and deploy:

```sh
npm run build:media-gateway-worker
npm run deploy:media-gateway-worker
```

Set these as Worker Secrets from the same Production values as Map7e Cloud. Wrangler prompts for each value; do not place secret values in command arguments or commit them:

```sh
npm exec -- wrangler secret put MEDIA_GATEWAY_SIGNING_SECRET --config services/media-gateway/wrangler.jsonc
npm exec -- wrangler secret put KV_REST_API_URL --config services/media-gateway/wrangler.jsonc
npm exec -- wrangler secret put KV_REST_API_TOKEN --config services/media-gateway/wrangler.jsonc
npm exec -- wrangler secret put STORAGE_ENCRYPTION_KEY --config services/media-gateway/wrangler.jsonc
```

`KV_REST_API_URL` and `KV_REST_API_TOKEN` must point to Map7e Cloud's existing Upstash REST database. `STORAGE_ENCRYPTION_KEY` must equal the effective key used by Cloud to decrypt its Quark auth record. If Cloud still uses `PIKPAK_PAT` as its legacy encryption-key fallback, provide that same value under the Worker secret name `STORAGE_ENCRYPTION_KEY`. Only set `QUARK_CLIENT_ID` or `QUARK_SIGN_KEY` if Production overrides the official defaults. The Worker limits its automatic invocation logs and redacts query strings because the short-lived ticket is sent in the URL; application logs contain only sanitized request metadata.

The default Worker URL on `workers.dev` is for health checks and short-lived diagnostic probes only. It is cross-site from `cloud.map7e.com`, so it must never be configured as the Cloud `MEDIA_GATEWAY_URL`. For production, attach `media.map7e.com` as a Worker Custom Domain and set the three matching Production variables shown above. `wrangler.jsonc` persists both `MEDIA_GATEWAY_SITE_DOMAIN=map7e.com` and the allowed Cloud origin; a normal deployment must not depend on a Dashboard-only site-domain value. Do not enable Cloud's Quark redirect until the custom domain, Worker Secrets, and matching Cloud Production signing secret are in place.

For the scoped-path update, deploy and verify Worker 0.2.13 first, then deploy Cloud from the same commit. Worker 0.2.12 does not understand Cloud's new scoped paths. The new Worker remains compatible with Cloud's old URLs and HEAD preflight during this order of rollout. Verify JPG and a real supported video's ranges/playback after each actual deployment; a dry-run or Ready deployment is not media acceptance.

Worker 0.2.14 adds optional CDN phase diagnostics without changing the 15-second response-header deadline, authorization, or host allowlist. Diagnostics remain off unless both `MEDIA_GATEWAY_DIAGNOSTIC_FILE_HASH` (the existing 16-character HMAC file identity from application logs) and `MEDIA_GATEWAY_DIAGNOSTIC_UNTIL` (Unix time in milliseconds, at most one hour ahead) are set. They apply only to that authorized file, expire automatically, and produce at most 48 entries per request. Keep the target and expiry out of committed configuration.

Worker 0.2.15 and Cloud share an end-to-end deadline for Cloud's capability probe: Cloud sends `X-Media-Probe-Deadline` with its existing 20-second cutoff on authenticated `HEAD` requests with `Range: bytes=0-0`. After grant validation, Worker reserves one second to return the response and caps its total remaining wait at 19 seconds. Independent 15-second Quark API and CDN limits remain unchanged; retries and redirects consume the same remaining probe budget. The marker never applies to original GETs or playback bodies. Worker returns `504` with `X-Media-Error: media_probe_deadline_exceeded`; Cloud reports `storage_range_probe_timeout` rather than a misleading generic 502. Caller cancellation propagates to owned Quark/CDN fetches, with `enable_request_signal` enabling Worker disconnect notification. This protocol currently targets the deployed Worker adapter, not the alternative standalone Node service.

Shared KV reads retain their existing bounded lifetime so cancelling one caller cannot break another request. The cancelled caller stops waiting and starts no further Provider work. A refresh transaction that has already started is registered with `ctx.waitUntil` to continue saving rotated credentials; it does not proceed to media after cancellation. Existing transport limits and the platform's background lifetime still bound that persistence attempt. These are explicit exceptions to aborting owned media reads, not extensions of the response deadline.

Cloud emits failure-only `quark_list_transport_failure` records for the directory API: attempt, headers/body stage, numeric received status and elapsed time, deadline classification, generated request UUID, and retry decision. The bounded cause chain uses finite allowlists for error names and transport codes, including connection/header timeouts, DNS/socket/TLS failures and redirect rejection. It also records the safe Node/Undici version, abort-reason classification, whether credential rotation was attempted, and current process-local Quark/list attempt counts; these counts do not represent other function instances. It logs no URL, query, raw exception, credentials, headers, socket addresses or payload. Existing 15-second attempt limits, two read attempts and 250ms retry delay are preserved. This instrumentation cannot retrospectively determine old 502 failures or separate platform DNS/TCP/TLS timings; a roughly 10-second rejection alone does not prove a connection timeout.

Worker 0.2.16 also uses the existing original-file fallback when a raster full preview's CDN request fails to connect or times out before headers. It does not fall back for thumbnails, RAW, client cancellation, or rejected hosts/redirects. This handles a preview routing gap; it does not establish a cause for historical original-file GET timeouts. Cloud associates asynchronous preview work with each opening, aborts an old video probe when closed or replaced, and ignores its late results, errors and loading updates.

The alternative Node gateway also refuses raster original-file fallback after caller cancellation. Its preview/thumbnail and source URL reads forward the caller signal to owned Quark/CDN requests; cancellation stops read retries, credential-refresh starts and subsequent CDN/metadata requests. A credential rotation already shared by callers may finish and persist normally, but the cancelled media request does not start another read afterward. Original per-attempt 15-second deadlines and all access/host checks remain unchanged. This Node correction is not evidence of a new Worker deployment or of real video acceptance.

Ordinary downloads of large or unknown-size Quark files use `check=download`, which verifies the existing file read policy and obtains a validated source through the existing provider without returning that URL or fetching CDN bytes. Actual Quark size-policy rejections remain 422. Video playback retains strict `check=range`; normal attachment downloads do not require Range support. Source availability is not proof of a successful CDN response or complete download.

`media_diagnostic` entries correlate request ID, attempt, redirect hop, allowed CDN host, status, elapsed header-wait time, safe media response headers, URL-cache decisions, and refresh outcomes. Deadline, parent cancellation, and fetch failure are distinct classifications. No signed URL, path, query string, credential, raw exception message, or sensitive request/response header is logged. Header-wait time includes the platform's connection setup and upstream wait; these application logs cannot separate DNS, TCP, and TLS timings. Retain query-string redaction and disabled automatic invocation logs during diagnostics.

The standalone Node gateway also stops waiting for CDN DNS validation when its caller cancels. DNS answers that arrive after cancellation cannot start a connection; listeners and timers are released. Node's already-started operating-system DNS lookup may still finish in the background. This does not change the DNS address checks, pinned HTTPS lookup, host allowlist, or existing header deadline, and does not diagnose the unrelated Cloud API file/list transport failures.

## Local verification

```sh
npm test
npm run build
npm run build:media-gateway
```

Gateway unit tests use simulated Quark responses, including first and middle byte ranges and a 30 GB `Content-Length` without creating a large file. They do not replace Production acceptance against a real Quark account.

### Verified Quark upstream policy (2026-10-08)

An owner-authenticated, read-only probe on the existing Worker used its unchanged Production bindings and the same `quark-main` auth for both real files:

| Sample | Actual bytes | `file/info` | `get_download_url` |
| --- | ---: | --- | --- |
| `壁纸_8.jpg` | 2,245,317 | HTTP 200, errno 0 | HTTP 200, errno 0; URL obtained but not logged |
| `07(1).mp4` | 848,086,961 | HTTP 200, errno 0 | HTTP 400, errno 23018, API status -1 |

The MP4 response explicitly matched `download file size limit[52428800]` (50 MiB). The diagnostic returned only the fixed reason `download_file_size_limit` and numeric limit, never the raw response, credentials or media URL. Adding Bearer auth and separately removing `device_id` both returned the same rejection. The stored optional client token was absent; this comparison does not claim every possible authorization difference has been excluded.

The observed failing request ID was `099a69a0-0655-4a7c-90fd-27a92cc42ed0`. Failure precedes CDN byte transfer and was reproduced by a plain POST with only the file ID in its JSON body, independent of browser HEAD/Range semantics. This proves a limit on the currently authorized Quark API download channel, not a universal Quark account or membership limit. Do not infer this policy from errno 23018 alone, fake an agent identity, or bypass the upstream restriction.

GitHub Actions run `37705552040`, latest job `113156013161`, also completed successfully using normal curl and its short-lived, verified GitHub OIDC identity. It independently reproduced both file results and the same explicit MP4 limit; the failing MP4 request ID was `b192d63e-4614-49d5-aa64-a4f5728be21c`. The one-time diagnostic workflow is removed after verification.

Worker 0.2.11 cancels rejected upstream Range bodies and adds exact-match, sanitized size-policy diagnostics. Worker 0.2.12 normalizes only the download endpoint's HTTP 400 / errno 23018 / exact positive size-limit message into HTTP 422 `quark_file_size_limit`. GET responses include a fixed friendly message and numeric `limitBytes`; bodyless HEAD responses expose `X-Media-Error` and `X-Media-Limit-Bytes` for the Cloud API's Range check. The policy rejection does not retry or rotate credentials. Other 23018 errors retain their upstream failure classification.

The Cloud API preserves this business error and the UI explains the current 50 MiB limit without offering a failing playback/download retry. Larger or unknown-size Quark downloads use a real Gateway preflight rather than rejecting from list metadata alone. Ordinary small-file downloads and PikPak keep their existing behavior. This code does **not** remove Quark's upstream limit.

PR #25 remains Open. The latest continuation evidence is in [the PR #25 recovery checkpoint](../../docs/media-gateway-pr25-resume-2026-10-08.md); the earlier [acceptance and large-video assessment](../../docs/media-gateway-acceptance-2026-10-08.md) is retained as history and Provider research. Obtaining a JPG download URL alone is not proof of a successful Production image download or render. The Worker release and Cloud frontend/API Production release must be verified independently.
