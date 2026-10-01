# Multi-storage implementation and Quark evidence

The legacy `/api/pikpak-*` endpoints still address `pikpak-main`. Existing PAT,
password cookies, administrator sessions, albums, access rules and production
Upstash metadata keys are retained. New `/api/storage-*` routes resolve a storage
instance; omitted storageId selects the configured default. Additional instances
use scoped metadata keys. The frontend enters one storage at a time.

`lib/storage/registry.js` is the factory registry. Providers declare capabilities
and unsupported operations return HTTP 501. Storage configuration and encrypted
credentials use the existing Upstash pipeline, isolated under the existing Preview
prefix. Account OAuth tokens never appear in descriptors, static assets or redirects.
AES-256-GCM credentials are bound to storageId. Set a stable server-only
STORAGE_ENCRYPTION_KEY if desired; existing deployments use PIKPAK_PAT as fallback.
Changing the encryption secret requires reauthorization of additional instances.
The primary PAT remains environment-managed. No persistent filesystem is used.

## Quark integration boundary

See [quark-official.md](./quark-official.md) for first-party sources, the inspected
official runtime revision, and capability limits.

Map7e Cloud uses the official **Agent Skill authorization flow**. It is not a
verified ordinary web-developer OAuth application. The application
client/signing constants in `quark-client.js` come from that official SDK; they
are not account tokens. No community Cookie API is used. A signed authorization
page request was previously verified, but personal account calls remain
unverified until Preview authorization and acceptance are complete.

The official flow returns an authorization page code for server-side polling; it
does not provide an app redirect URI. `/api/quark-oauth` therefore has a `start`
action and a CSRF-bound `complete` action rather than a browser callback URL. The
`complete` action polls the official page code, exchanges it, encrypts tokens in
Upstash and consumes the pending state.

| Capability | Official route / current implementation |
|---|---|
| Authorization | POST `/agent/v1/get_authorize_page_url` |
| Consent code | GET `/agent/v1/oauth/get_aac_by_pagecode` |
| Code exchange | GET `/agent/v1/oauth/agent_auth_code` |
| Refresh | POST `/agent/v1/oauth/access_token/rotate` |
| Account / member | GET `/open/v1/user/info`, `/open/v1/user/get_vip_info` |
| List / item | POST `/open/v1/file/list`, GET `/open/v1/file/info` |
| Download link | POST `/open/v1/file/get_download_url`; redirects only after an unauthenticated range probe succeeds |
| Create directory | POST `/open/v1/dir` |
| Upload / rename / move | Official CLI supports workflows, but there is no published general-purpose web contract; capability false |
| Trash / recycle bin | Official Skill does not expose deletion; capability false |

Expiry is taken from `access_token_expires_at` / `refresh_token_expires_at` on
exchange and `expires_in` on rotation. No fixed account token lifetime is assumed.
Rotation saves both new tokens encrypted and uses a Redis ownership lock plus
in-process single flight. Pending authorization expires after 600 seconds and is
bound to the signed administrator session plus an HttpOnly SameSite state cookie.
A successful exchange consumes pending state; a replay fails.

The official SDK sends `x_pan_access_token` as a Cookie for file data downloads.
That account credential must not be copied into a browser cookie or URL. Therefore
the adapter probes each official temporary link with a credential-free one-byte
Range request and immediately cancels the body. Only confirmed HTTP 200/206 links
are redirected. Credential-required or unverified links return explicit HTTP 501;
no large file/image relay is introduced. Quota is shown only if the account
response contains validated numeric capacity fields; missing values remain
unknown rather than rendering as zero. Thumbnails containing an account token
are discarded. Album grids do not load original images until the viewer opens.

Run all tests: `node --test tests/*.test.js`. Storage tests use protocol fixtures,
not live personal-account acceptance. Preview must additionally confirm PikPak
list/download/write compatibility and authorize Quark before claiming live Quark
account, list or download support.
