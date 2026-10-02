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
| `MEDIA_GATEWAY_ALLOWED_ORIGIN` | Exact browser origin, normally `https://cloud.map7e.com`. |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Same persistent store as Cloud; alternatively use `KV_REST_API_URL` + `KV_REST_API_TOKEN`. |
| `STORAGE_ENCRYPTION_KEY` | Same effective key Cloud uses to decrypt stored Quark auth. If Cloud currently relies on the legacy `PIKPAK_PAT` fallback, use that same value here until a separate-key migration is done. |
| `QUARK_CLIENT_ID` / `QUARK_SIGN_KEY` | Set only if Cloud overrides the official defaults; values must match Cloud. |

Do not set `VERCEL_ENV=preview`: Cloud's production records use the production Redis key prefix. The Gateway needs no `CLOUD_PASSWORD`, admin session secret, or separate Quark database. Store all values in the host's secret manager; never commit an env file.

In Map7e Cloud Production, set:

```text
MEDIA_GATEWAY_URL=https://media.map7e.com
MEDIA_GATEWAY_SIGNING_SECRET=<same value as Gateway>
```

`MEDIA_GATEWAY_URL` must be an HTTPS origin with no path, query, or fragment. Add the corresponding DNS record and HTTPS custom domain at the selected host before enabling these variables.

## Request and streaming model

Cloud runs the normal storage lookup and `requireItemRead()` permission check, then signs a five-minute HMAC ticket for exactly one `storageId`, `fileId`, `parentId`, purpose, and optional preview variant. It redirects the browser to the Gateway only after that check.

The Gateway verifies the ticket, re-resolves the selected Quark provider and current auth from the shared encrypted store, checks the file and parent identity again, then obtains a fresh Quark download URL itself. It does not accept an upstream URL from the browser. The Quark media Cookie (`x_pan_client_id`, `x_pan_access_token`, and optional `x_pan_client_token`) stays between Gateway and Quark. A ticket-scoped HttpOnly cookie lets the browser request later independent Range segments after the initial five-minute URL ticket expires; the session is file and purpose scoped and expires after six hours.

The media body is piped as a stream. There is no whole-file array buffer or disk staging. Single byte ranges are forwarded to Quark and its `206`, `Content-Range`, length, type, and range support are checked before safe headers are returned. Invalid, out-of-file, and multipart ranges are rejected. Each range request independently resolves the download URL; a Quark `401` or `403` clears the account-scoped short cache, refreshes the URL once, and retries once.

Upstream media hosts must be HTTPS Quark domains and resolve only to public addresses. Redirects are checked again before following. The Gateway allows only `GET` and `HEAD` on media, restricts CORS to the configured Cloud origin, and logs no ticket, token, Cookie, or upstream URL. Configure the reverse proxy and host access logs to omit or redact query strings, since the initial signed ticket is carried in the Gateway URL.

## Host choice

The service needs a continuously available container or VM, long-lived HTTP responses, Range support, custom HTTPS, and affordable outbound traffic. A small persistent VM is the cost-first option for high media egress; the Singapore Hetzner Cloud region currently includes at least 0.5 TB monthly outbound traffic, with larger plans including more. Fly.io offers Tokyo and Singapore locations with easier managed TLS and machine lifecycle controls, but current Asia-Pacific egress is $0.04/GB. Railway and Render both offer Singapore regions; their published public egress rates are $0.05/GB and $0.15/GB above the workspace allowance, respectively. The attached code is host independent. No host credentials or eligible existing VM were available during implementation, so no provider account, DNS, or deployment has been created.

For a VM deployment, put a reverse proxy such as Caddy in front of this container for automatic HTTPS and route `media.map7e.com` to port `8080`. Disable idle suspension. Keep at least 512 MB RAM for the Node service; memory use is based on active stream chunks, not file size. Test actual Quark playback from the target mobile browsers after deployment.

## Local verification

```sh
npm test
npm run build
npm run build:media-gateway
```

Gateway unit tests use simulated Quark responses, including first and middle byte ranges and a 30 GB `Content-Length` without creating a large file. They do not replace Production acceptance against a real Quark account.
