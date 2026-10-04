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

The Gateway verifies the ticket, re-resolves the selected Quark provider and current auth from the shared encrypted store, checks the file and parent identity again, then obtains a fresh Quark download URL itself. It does not accept an upstream URL from the browser. The Quark media Cookie (`x_pan_client_id`, `x_pan_access_token`, and optional `x_pan_client_token`) stays between Gateway and Quark. Inline video tickets use signed file-scoped HttpOnly cookies whose names derive from the media identity, so simultaneous first requests for different videos cannot overwrite one another's Range grants. Video attachments, previews, and other one-shot downloads do not create these six-hour session cookies. Each grant is file and purpose scoped, contains no Quark metadata, and expires after six hours. The Quark video element uses credentialed CORS so same-site `media.map7e.com` Range requests include this cookie.

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

The default Worker URL on `workers.dev` is for health checks and short-lived diagnostic probes only. It is cross-site from `cloud.map7e.com`, so it must never be configured as the Cloud `MEDIA_GATEWAY_URL`. For production, attach `media.map7e.com` as a Worker Custom Domain, set the Worker variable `MEDIA_GATEWAY_SITE_DOMAIN=map7e.com`, and set the three matching Production variables shown above. Do not enable Cloud's Quark redirect until the custom domain, Worker Secrets, and matching Cloud Production signing secret are in place.

## Local verification

```sh
npm test
npm run build
npm run build:media-gateway
```

Gateway unit tests use simulated Quark responses, including first and middle byte ranges and a 30 GB `Content-Length` without creating a large file. They do not replace Production acceptance against a real Quark account.
