# PR #25 continuation checkpoint — 2026-10-08

This continues `qaz492888660/map7e-cloud` / `feat/quark-media-gateway`. No merge, reset of another worktree, Production rollback, secret rotation, DNS change, or paid service was performed. This checkpoint supersedes the runtime status in the earlier acceptance document while retaining its historical evidence and Provider research.

## Current remote state restored

- GitHub was read again before editing and before publishing: PR #25 Open/unmerged; HEAD `47d5d824aa407fb28e715957688ba3fa5bfbc288`; main `c91f555e888afba42267234ae83caa59bafb579d`. [Tests #65](https://github.com/qaz492888660/map7e-cloud/actions/runs/37735605325) is success for that HEAD.
- Vercel connector and the authorized Dashboard identify Production deployment `dpl_8hXKMY4yGSNpEqJdR24vY1zSW7oi`, Ready, source `47d5d824aa407fb28e715957688ba3fa5bfbc288`, bound to `cloud.map7e.com`. It was not rebuilt or promoted in this continuation.
- Last directly verified Worker release remains 0.2.12 / `10383ede-b8c1-4169-85f8-7c33a4d44d9f` / deployment `fc79b0c7-fe6e-4148-9453-9f033571d683`. Current release read-back is blocked: no available Cloudflare connector or authorized Wrangler credentials; Dashboard presents sign-in with a persistent verification error after one reload. A browser health visit was blocked by the browser client, so it supplies no new version evidence.
- Edits were made in a new worktree based on the confirmed PR HEAD. Other worktrees and concurrent branches were preserved. Publishing must use an expected-head lease and a fast-forward, never force or main.

## JPG original: successful file evidence, missing wire headers

The currently authorized Production index contains `壁纸_8.jpg` (2.1 MB displayed). The earlier successful Preview and native download remain valid for the unchanged Production source; they were not repeated merely to reproduce passed checks.

| Check | Evidence / result |
| --- | --- |
| Preview | Prior actual browser render, `complete=true`, 1440 × 2560; retained |
| Native original download | Prior actual Production download around `2026-10-08T08:40:00Z`; retained complete file |
| Downloaded bytes | Actual saved file is 2,245,317 bytes; re-read matches prior evidence and Quark metadata |
| SHA-256 | `bbf0c4c1eff8471688c91cf60ef26a02879ab2ecb3c97607a2e9296a9f998c5e`; re-read matches |
| Integrity | Prior strict complete JPEG pixel decode and EOI check passed, 1440 × 2560; retained |
| Original GET HTTP status | Not captured; native download event does not provide response headers |
| Actual HTTP Content-Type | Not captured; file format detection is not HTTP evidence |
| Content-Length / Transfer-Encoding | Not captured; measured file bytes do not establish transport headers |
| Absence of 401/412/501/502 in that GET chain | Cannot certify without the original network record or sanitized Worker trace |

The retained failed curl artifact has no HTTP chain and zero bytes; it is not successful JPG evidence. Anonymous requests/CI returning `authentication_required` do not establish the outcome of the authorized download and must not be used to bypass access control. Existing browser developer inspection offers console logs but no network-record API; invoking DevTools did not expose a usable network panel. Cloudflare logs are the remaining supported path, blocked by personal sign-in/verification. Minimum additional evidence: the authorized JPG original GET's status, actual type, length/transfer headers and completed stream bytes. Never record ticket, Cookie, credential or signed upstream URL.

## Actual video acceptance

| Case | Actual result |
| --- | --- |
| Quark video ≤50 MiB | No qualifying real sample in the authorized indexed tree; only `07(1).mp4`, 848,086,961 bytes, is present |
| Existing PikPak sample | Authorized index has a text file, APK and PNG; no video sample |
| Small-video first/middle Range | HTTP 206, Accept-Ranges, Content-Range and Content-Length remain unverified against real media |
| Playback and seek | No qualifying sample, not verified; simulated unit ranges are not playback evidence |
| Quark 809 MiB MP4 rejection | Existing real API evidence: download URL endpoint HTTP 400, errno 23018, exact positive 52,428,800-byte policy limit; no ineffective repeated requests or Range splitting |
| Production business-error flow | One authorized visit clicked this MP4; checking completed with the exact friendly 50 MiB restriction, no playback or download retry offered, no indefinite spinner |
| Actual HTTP for that flow | Authorized Vercel logs: GET `/api/storage-download` HTTP **422**, `2026-10-08T11:59:27.340Z`; observed in Dashboard after the browser action |

The displayed message was: `当前夸克接口限制单文件下载大小为 50 MiB，此文件暂不支持站内播放或下载。` This verifies the current Production rejection flow, not large-video playback. Earlier official Quark/PikPak/R2 research is retained in the acceptance document. No lawful, working, no-added-cost large-video path has been demonstrated; no unverified alternative was implemented or deployed.

## Review changes and validation

- The required site domain was missing from checked-in Wrangler vars. Added `MEDIA_GATEWAY_SITE_DOMAIN=map7e.com`, preserving the existing allowed origin and secret handling.
- The eight-cookie eviction race remained reproducible: eight pre-existing grants plus two simultaneous initial requests produced nine root-path cookies in both Node and Worker. Replaced shared-root eviction with identity-specific media paths and exact-path signed video cookies, keeping independent grants and bounded request headers. No server state, new service or additional secret is required.
- Regression tests cover 20 initial video grants, 12 of them arriving simultaneously at the former cap, reversed response application, one browser-selected cookie per URL, ranges after the ticket expires, original six-hour expiry, legacy redirect/migration without upstream access on redirect, unchanged shorter legacy expiry, omission of legacy metadata, path mismatch refusal, old HEAD compatibility and invalid duplicate-cookie handling. Node and Worker paths are checked against the same signing contract.
- Range validation body cleanup and Unicode filename truncation were already fixed in the restored HEAD; source and existing targeted regressions confirm these. No duplicate implementation was added.
- Local validation: 132 Node tests passed; 22 UI tests passed with explicit Vitest output. Final targeted Gateway/Worker/ticket checks passed 73/73 after canonical path normalization. Production build and syntax checks passed. Wrangler 4.147.0 dry-run passed, upload 71.66 KiB / gzip 17.84 KiB, listing both persisted vars. `git diff --check` passed. CI on the new commit is tracked in the PR; historical Tests #65 is not proof for new code.

## Deployment boundary and next steps

The Worker source is prepared as **0.2.13**; it has not been deployed. Production continues serving the verified 47d5d824 release. Do not promote the changed Cloud API while Worker 0.2.12 remains active, because it does not recognize scoped media paths.

After Cloudflare personal sign-in/verification is restored: verify account, Worker target, current deployed version and bindings; inspect sanitized existing JPG logs; deploy the tested Worker with unchanged secrets/domain; read back release and health; verify old-Cloud JPG behavior; then deploy Cloud from the same tested commit and perform actual media checks. Missing real small-video acceptance remains explicitly pending. PR #25 is not ready to merge until runtime checks, review closure and the user's explicit merge consent are complete.
