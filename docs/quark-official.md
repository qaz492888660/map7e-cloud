# Quark official integration evidence

Checked 2026-09-30 against Quark's official Agent Skill source:

- Repository: <https://github.com/quark-clouddrive/quarkclouddrive_offical>
- Inspected runtime revision: `509e3ada82c1ac4a251e13bac8ca9b858d125cfb`
- Authentication guide: <https://github.com/quark-clouddrive/quarkclouddrive_offical/blob/main/skills/quarkclouddrive/references/auth.md>
- File operations guide: <https://github.com/quark-clouddrive/quarkclouddrive_offical/blob/main/skills/quarkclouddrive/references/file-ops.md>
- Official Skill configuration endpoint: `https://open-api-drive.quark.cn/agent/v1/skill_config`
- Runtime release: Quark Drive Skill 1.0.20

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
