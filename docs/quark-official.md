# Quark official integration evidence

Checked 2026-10-02 against Quark's official Agent Skill 1.0.20 source and release:

- Repository: <https://github.com/quark-clouddrive/quarkclouddrive_offical>
- Inspected runtime revision: `509e3ada82c1ac4a251e13bac8ca9b858d125cfb`
- Authentication guide: <https://github.com/quark-clouddrive/quarkclouddrive_offical/blob/main/skills/quarkclouddrive/references/auth.md>
- File operations guide: <https://github.com/quark-clouddrive/quarkclouddrive_offical/blob/main/skills/quarkclouddrive/references/file-ops.md>
- Official Skill configuration endpoint: `https://open-api-drive.quark.cn/agent/v1/skill_config`
- Runtime release: Quark Drive Skill 1.0.20
- Official release listing: <https://github.com/quark-clouddrive/quarkclouddrive_offical/releases>
- Official Quark Help download link: <https://www.quark.cn/documents/help/quark-drive-skill>

## What the sources establish

The Skill describes a user-consented Agent authorization flow. Its official
runtime has signed calls for authorization, token rotation, account/member
information, file listing/details, download-link lookup and folder creation. The
user-facing Skill includes upload, move and rename workflows. It does not expose
file deletion.

The published Skill uses a local CLI and runtime configuration. The public
repository does not document a general-purpose web-app integration contract,
third-party web app registration, or browser redirect URI. Map7e Cloud uses only
the official Agent Skill endpoints and does not fall back to community Cookie
interfaces. Its `complete` action polls the official page code because this flow
does not redirect to a Map7e callback URL.

## Capability policy

- **Implemented behind owner authorization:** account/member probe, file listing,
  item details, token rotation, direct-download-link validation and folder
  creation.
- **Disabled:** upload, rename, move and trash. The official CLI supports some
  operations, but the site has no published general web contract to rely on.
  These remain disabled until Quark documents or confirms a supported web
  integration path.
- **Not verified with a personal account:** consent completion, real account,
  member and quota response shape, real listing, thumbnails and direct download.
  Preview authorization is required for those checks.

The signing constants in `lib/storage/providers/quark-client.js` are application
constants distributed in the official runtime, not user credentials. OAuth
access and refresh tokens are encrypted at rest in Upstash and are never
returned to the browser. The provider does not claim that Quark accepts
arbitrary ordinary web-app clients.

## Media authentication confirmed in Skill 1.0.20

The release archive's `DownloadManager` constructs a Cookie containing the
required `x_pan_client_id` and `x_pan_access_token` fields. It appends
`x_pan_client_token` only when a client token exists in the local account
configuration. The client ID comes from the official runtime configuration;
the access token comes from the authorized account. Map7e uses the official
client ID (or its matching `QUARK_CLIENT_ID` override) and the OAuth access
token stored for the selected Quark storage. A stored `clientToken` is included
if present; Map7e's current OAuth exchange does not populate that optional field.

The CLI obtains a media URL with POST
`/open/v1/file/get_download_url`, reading `data.download_url`. Its download
manager sends GET requests directly to that returned CDN URL with the Cookie;
chunk requests also send `Range`. When the URL expiry embedded in the URL is
detected, the CLI obtains a replacement URL and retries the chunk. The official
runtime's direct file reader does not establish the authentication behavior of
thumbnail CDN requests; Map7e sends the same credential Cookie to the Quark
thumbnail host server-side, but that path remains unverified against the real
Production sample.

The new `services/media-gateway/` uses that server-side media flow. It does not
put a Quark token or CDN URL in its ticket. It streams the CDN response and its
single Range, checks Quark-host allowlists and public DNS results, retries a
fresh download URL only once after a CDN `401` or `403`, and writes only safe
response headers to the browser. Quark reauthentication, capacity, root and
nested listing, indexing and JPG/MP4 classification have already been proven
in Production per the project acceptance record. Production media delivery is
still incomplete until a persistent Gateway host is deployed and JPG/video
Range playback is verified on the real account.
