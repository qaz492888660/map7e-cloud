# Media Gateway acceptance and large-video assessment

Recorded 2026-10-08 for `qaz492888660/map7e-cloud`, PR #25. The PR remains Open. This record distinguishes a verified Worker release, tested code and actual Production media delivery.

## Code and release

- Restored remote HEAD `18f273a232d1fd85e4592f22c3e5113d4000f5ff`; the recovered local file tree matched it. Existing worktrees and their branches were preserved.
- Code fix: `af99e1ac32597b60798127036ead4eaf3c7f23cf`, pushed to `feat/quark-media-gateway` and read back from GitHub.
- `npm test`: 124 Node tests and 22 UI tests passed. `npm run build`, syntax checks, `git diff --check`, and Wrangler 4.147.0 dry-run passed; dry-run upload 69.89 KiB / gzip 17.47 KiB.
- [GitHub Actions Tests #64](https://github.com/qaz492888660/map7e-cloud/actions/runs/37734576670), job `113171103479`: success. Actual job logs report 124 Node tests, 124 pass, zero failures. The current Actions workflow runs Node tests; the UI/build/dry-run results above are local checks.
- Existing Worker `map7e-quark-media-gateway`: version `10383ede-b8c1-4169-85f8-7c33a4d44d9f`, number 70. Deployment `fc79b0c7-fe6e-4148-9453-9f033571d683`, created `2026-10-08T05:54:38.094266Z`; deployment read-back confirms 100% of this version.
- Bundled source SHA-256: `c3c8199d92cdba6afed740a05a12f86504bf39e78382f857212ef285ecda3edb`.
- Actual public `https://media.map7e.com/health`: HTTP 200, `{"ok":true,"version":"0.2.12"}`.
- Actual public no-ticket `/v1/media`: HTTP 401, `{"ok":false,"error":"media_ticket_invalid"}`.
- Release comparisons confirmed existing bindings, runtime and non-version settings were preserved. Four Secret names were listed before/after unchanged: `KV_REST_API_TOKEN`, `KV_REST_API_URL`, `MEDIA_GATEWAY_SIGNING_SECRET`, `STORAGE_ENCRYPTION_KEY`. Secret values were not read, rotated or rewritten. DNS, nameservers, domain binding and Vercel environment variables were not changed.

## Error behavior

Only `/open/v1/file/get_download_url` plus HTTP 400 plus numeric errno 23018 plus an exact positive `download file size limit[...]` message becomes HTTP 422 `quark_file_size_limit`. The response includes only a fixed friendly message and a numeric limit. Other 23018 responses are not presumed to be size policies.

The Worker and Node Gateway provide safe headers for HEAD. The Vercel Range-check handler turns those headers into the same business error. The UI displays:

> 当前夸克接口限制单文件下载大小为 50 MiB，此文件暂不支持站内播放或下载。

It avoids a failing playback and download retry in the video dialog; large/unknown-size Quark original downloads first obtain the actual upstream result. Metadata size alone never blocks a file: a successful large-file Range result still enables playback. Small JPG and PikPak downloads retain their existing path. Listings, capacity, categories and search remain available.

Regression coverage includes strict policy classification, safe GET/HEAD errors, no retry/token rotation/CDN read after a policy refusal, bodyless HEAD propagation, unknown errors, UI handling and unchanged small-file/PikPak behavior.

**Production activation is incomplete:** GitHub's Vercel commit status reports deployment success, but the Vercel connector returns scope HTTP 403 for `qaz492888660s-projects`, including the new deployment `dpl_4vUGRQ39B2H7WJ647z4RWfZ1T1v8`. There is no available Vercel CLI authorization or `VERCEL_TOKEN`. Its target/Ready state and Production promotion cannot be read or performed with current credentials. Do not claim the new Cloud API/UI business-error handling is live on `cloud.map7e.com`.

## Actual Production media acceptance

The browser inspection occurred on Worker 0.2.11 before this release; no authenticated post-release media test has completed.

| Item | Actual evidence | Status |
| --- | --- | --- |
| Quark list, capacity and indexing | Browser loaded the existing account; 631 GB / 6 TB displayed, accessible index completed | Verified for this visit |
| JPG thumbnail | `壁纸_8.jpg` decoded in the browser, `complete=true`, natural dimensions 100 × 178 | Render verified; HTTP/MIME not captured |
| JPG Preview | Image dialog subsequently showed `图片暂时无法加载。` | Failed on this visit; HTTP/MIME and failure layer unconfirmed |
| JPG original download | Browser download tool timed out; the following tab recovery was explicitly blocked by browser URL-protocol policy | BLOCKED; no complete authenticated file response |
| Original JPG size/type | Previous actual Quark metadata: 2,245,317 bytes, JPG; this is not an actual complete CDN download measurement | CDN Content-Type and byte count unverified |
| Real video ≤50 MiB | Current accessible index contained one video, `07(1).mp4` at 848,086,961 bytes; no qualifying real sample found there | No test sample; not verified |
| Small-video first/middle Range, 206, headers | No qualifying real sample was available | Not verified |
| Small-video playback/seek | No qualifying real sample was available; browser session also became blocked | Not verified |
| 809 MiB MP4 | Previous actual CI returned HTTP 400 / 23018 at `quark_download_url`, explicit limit 52,428,800 bytes, before CDN | Current authorized channel cannot supply this file |
| MP4 206/playback/seek | No supported large-file URL and no completed post-release media test | Not passed |
| New 422 friendly-error Production flow | Code/tests pass; Worker deployed; Cloud API/UI Production activation blocked | Not runtime-verified |

An anonymous ordinary curl check used the actual UI's JPG ID/parent. Thumbnail and original routes returned HTTP 401 `authentication_required`; the Preview route returned HTTP 502 `quark_unreachable`. These are Vercel route results without the browser's app session, not authenticated CDN verification. No ticket, session, Quark credential or download URL was printed.

Worker real-time tail was successfully connected using the official `trace-v1` protocol; its observation window contained no new media request. The temporary subscription was deleted successfully. A separate dry, bounded historical Workers Observability query returned HTTP 403 / Cloudflare code 10000; it was not retried or bypassed. Browser-policy blocking was not bypassed with another browser, session extraction or alternate file download path.

The previous [actual curl CI probe](https://github.com/qaz492888660/map7e-cloud/actions/runs/37705552040), job `113156013161`, established JPG download-URL HTTP 200 and MP4 HTTP 400 / 23018 / explicit 50 MiB limit using the same account. It is preserved evidence, not a new 0.2.12 media acceptance. Download-URL HTTP 200 does not establish CDN delivery.

## A: Official Quark large-file media capability

The current public [official repository](https://github.com/quark-clouddrive/quarkclouddrive_offical) still has revision `509e3ada82c1ac4a251e13bac8ca9b858d125cfb`; its [Skill](https://github.com/quark-clouddrive/quarkclouddrive_offical/blob/main/skills/quarkclouddrive/SKILL.md) declares 1.0.20. Its [file-reading reference](https://github.com/quark-clouddrive/quarkclouddrive_offical/blob/main/skills/quarkclouddrive/references/file-read.md) describes `getDownloadUrlById`, file-reading tasks and resume, not a separate video-playback/HLS contract. The previously obtained official runtime package 1.0.22 declares that version; inspection of its documentation found the same getter reference and no documented HLS/m3u8/large-video playback interface. No old API parameter comparison or runtime source analysis was repeated.

This establishes only that **no supported large-video path for this authorized channel has been verified in these published materials**. It does not establish that Quark has no other official media capability. The 50 MiB result is specific to the current download API/authorization; membership capacity does not prove a different API entitlement.

Before developing A, Quark must document/confirm a supported application capability or scope, whether this cloud-agent download cap can be raised, or a separate authorized video stream/Range/HLS API. Required evidence: endpoint contract, application entitlement, server-side authorization, allowed website use and a real >50 MiB response. Pricing is unknown; buying a membership cannot be recommended as a verified fix.

## B: HLS from a lawfully accessible original

[FFmpeg's HLS muxer](https://ffmpeg.org/ffmpeg-formats.html#hls-2) can produce a VOD playlist and segments. If the source codecs are compatible, stream-copy remuxing avoids re-encoding; incompatible video/audio or unsuitable keyframes require transcoding. Source codecs, duration and measured speed are unknown, so CPU time and transcode cost cannot be priced from an 848 MB file size.

This needs legal access to **all original bytes**. A fast-start/seekable source may be processed progressively, but a reliable offline job should stage the full source and output. Budget roughly 2–3 GB temporary space for one single-quality copy of this file; multiple renditions need more. The current Quark channel refuses the URL before reads begin, so it cannot feed this job. Segmenting HTTP requests does not override the policy; owned-file segmentation occurs only after a permitted acquisition.

Use approximately 6-second keyframe-aligned segments as an initial design, then measure actual segment sizes. Duration is not a hard byte-size bound. Prefer private object storage rather than depending on undocumented Quark playlist semantics. [Apple HLS](https://developer.apple.com/streaming/hls-authoring-specification-for-apple-devices.html) supports Safari; [HLS.js](https://github.com/video-dev/hls.js) supplies playback on compatible desktop MSE browsers. The current player has no playlist/segment integration, so these are feasibility findings, not deployed support.

The existing `requireItemRead` permission check and signed grants can be reused in a future design, but each manifest, init object, segment and encryption key must be authorized against the same asset. Use private storage and relative Gateway routes, constrain path resolution, and scope session renewal to the original file. Buffering, seek and saved playback position still require actual Safari/desktop testing. No public CDN credential or private playlist should be exposed.

A one-off remux can run on an existing controlled machine, with no permanent transcoding server and no software fee. Repeated uploads or re-encoding need a controlled job runner; its cost requires a measured benchmark. Within unused [R2 Standard free allowances](https://developers.cloudflare.com/r2/pricing/) a ~0.85 GB output can have $0/month storage and egress cost. Keeping both source and one same-quality output is roughly 1.7 GB plus packaging overhead. Standard storage beyond free allowance is $0.015/GB-month, with billing-unit rounding; request charges and [Worker execution pricing](https://developers.cloudflare.com/workers/platform/pricing/) also apply. Workers Free allows 100,000 daily requests/10 ms CPU per invocation; Paid starts at $5/account/month. The free allowance is account-wide, not guaranteed spare capacity. FFmpeg processing belongs outside the serving Worker.

Conclusion: technically feasible after legal source access, but not an immediate fix for the current missing source URL. No Quark rules exception for arbitrary republishing/transcoding was established. Use owned/licensed content and a permitted source-access channel; HLS does not itself grant either right.

## C: Existing Provider or website object storage

| Path | Feasibility | Estimated incremental cost and constraints |
| --- | --- | --- |
| Existing PikPak | Existing account/provider avoids a new media system; observed 42 MB used of 6 GB leaves room for this one file. Real API/CDN Range and codec behavior remain untested for it. | Potentially $0 using available Free storage. [Official feature comparison](https://mypikpak.com/drive/app-extension/premium-features/) lists Free 720p playback and Premium original quality. [Connected Apps quota](https://mypikpak.com/en-US/faq) is 5 GB/day for Free, also subject to a monthly cap; not unlimited streaming. Exact paid checkout price not read. |
| Private R2 original MP4 | Official website object storage with a Worker can serve owned MP4 byte ranges, avoiding initial HLS/transcoding if codecs are browser-compatible. Needs a future R2 binding/provider route plus the existing permissions; not implemented now. | Potentially $0 inside unused free storage/request/Worker quotas. Otherwise R2 Standard $0.015/GB-month plus operations and any Worker plan charges; Internet egress is free. No permanent video server needed. |

PikPak's current [User Agreement](https://mypikpak.com/en-US/policy/user-agreement) prohibits account sharing, unauthorized infrastructure access/derivative services and unconsented commercialization. Existing authorized credentials alone do not prove permission to operate a public video-hosting service. Use its permitted connected-app/personal flow and confirm the intended website use; never disguise traffic or evade quotas. A private owner trial and public long-term hosting have different acceptance conditions.

Next implementation priority: finish the current Cloud API/UI Production release and JPG acceptance; acquire a small real video for the Quark acceptance boundary. For a single private large-video trial, the already authorized PikPak path is the smallest technical change if its permitted use is confirmed. For stable public website delivery, an owned MP4 in private R2 with authorized Range serving is more appropriate than adding HLS before source access and codec requirements are known. First prove one file's 206/Content-Range/Safari seek; add HLS only if compatibility or adaptive bitrate justifies it. No A/B/C path was implemented or declared passed in this phase.

## Merge conditions

PR #25 stays Open. The current first-stage boundary is small authorized media plus clear large-file policy errors, not a promise of large Quark playback. Merging still requires actual Production Cloud API/UI activation, JPG thumbnail/Preview/original HTTP/MIME/size evidence, a real supported video's first/middle 206 and playback/seek, a verified business-error flow for the rejected MP4, an agreed acceptance boundary and a latest review with no blocking issues. None of the missing runtime checks is replaced by unit tests or deployment status.
