# Lossless storage key migration

Status: implementation and synthetic tests are preparation, not evidence that
Production has been migrated. Do not update PIKPAK_PAT or add/replace a Production
Secret until the owner approves this procedure and the source-key checks pass.
Keep PR #25 open and the current Production deployment available.

## Existing dependencies

| Path | Dependency and required behavior |
| --- | --- |
| `lib/storage/store.js` | AES-256-GCM v1 auth and pending OAuth use SHA-256 of `map7e-storage-v1\0` plus the effective legacy seed. AAD is storageId. |
| `services/media-gateway/src/worker.js` | The deployed Worker derives the same key from its own unchanged effective seed. It reads and refreshes the same v1 auth records. |
| `lib/cloud-auth.js`, `cloud-login.js`, `pikpak-upload-ticket.js` | Visitor session signatures depend on PIKPAK_PAT; changing PAT invalidates existing visitor cookies. |
| `lib/admin-auth.js` | Admin signatures depend on PAT. The independent scrypt password hash and sessionVersion are retained; users can log in again. |
| `quark-oauth.js` / Quark Provider | Pending OAuth is encrypted and bound to the original admin cookie. A PAT change invalidates the cookie binding; do not revive expired or obsolete OAuth transactions. |
| `lib/storage/media-ticket.js` and Worker grants | MEDIA_GATEWAY_SIGNING_SECRET is independent and remains unchanged. |
| Primary PikPak | `readAuth('pikpak-main')` uses the environment PAT directly; there is no stored refresh token to invent. |

Production encrypted namespaces are `map7e-cloud:storage:auth:v1:*` and
`map7e-cloud:storage:oauth:v1:*`. Preview uses `map7e-cloud:preview:`. Inventory
scans both namespaces, including orphan instances absent from configuration.
OAuth has a 600-second lifetime. Config, file/folder access metadata, admin
password hashes and sessionVersion are not encrypted with this storage key.
These are code-audit findings; actual record counts must come from runtime
inventory, not from the public configured-provider list.

## Keep the data key, change how Cloud obtains it

Re-encrypting auth under a fresh data key would break the unchanged Worker and
could race its token refresh. Instead, encrypt the existing 32-byte derived data
key under a fresh, independent STORAGE_ENCRYPTION_KEY (the wrapping key). The
wrapping key has a separate derivation domain and AES-GCM AAD bound to environment
prefix and migration ID. Store only the encrypted data-key envelope in Redis.
Never export or log either seed, the derived key, or decrypted account auth.

Active auth/OAuth ciphertext stays byte-identical during migration. Cloud and
Worker continue using the same data key and v1 format for future refresh writes.
Cloud unwraps that key using the independent Secret after activation, so a later
PAT rotation no longer affects stored auth. This decouples Cloud from PAT; it
does not retire the data key retained by the existing Worker. Retiring that key
would require a separately approved Worker migration.

New metadata is scoped under `storage:key-migration:v1:*`, with an active pointer
at `storage:keyring:v1`. The manifest contains only IDs, state and an HMAC proof
of the source data key. Exact encrypted-record backups contain ciphertext,
checksum and original absolute expiry, never decrypted auth. Backups are created
with SET NX and verified by decrypting in memory. The immutable wrapped-key
backup is separately checked. Backups stay in the same Redis account; they
protect interrupted migration and damaged wrapper records, not total Redis loss.
Do not delete this metadata or either backup type during this operation.

## Read-only gate before preparing

1. Verify the exact PR SHA, team/project, existing Production ID and Worker
   version/traffic. Build and test before deploying migration-capable code.
2. Keep current project Secrets untouched. A new deployment cannot be assumed
   to have the old runtime's PAT: an environment-variable update timestamp does
   not reveal whether the value changed.
3. Prefer an authorized staged deployment inheriting the known-good original
   Production environment snapshot, with the reviewed migration SHA and domain
   auto-assignment disabled. Vercel documents inheritance when creating from a
   deploymentId; verify the resulting SHA/environment and actual decryption.
   Do not assume ordinary redeploy/Preview promotion preserves that snapshot.
4. With an existing administrator session on that deployment, GET
   `/api/admin-key-migration`. This is read-only and calls no provider/CDN API.
   It returns IDs, kind, TTL, readable flags and fixed error codes. Confirm every
   encrypted record is readable, unknownCount and unreadableCount are zero, and
   the namespace is Production. A visitor cookie is insufficient.
5. If the source key cannot decrypt even one record, STOP. Keep the old runtime
   and every ciphertext intact. Do not overwrite data, rotate PAT, extract a
   hidden Secret through a bypass, or claim that reauthorization is lossless.
   If a lawful old-snapshot deployment cannot be established, the operation
   remains blocked pending a platform-supported recovery path.

Vercel's [deployment API](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment)
describes deploymentId inheritance. [Secret variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables)
cannot be read back through normal Dashboard/CLI export. Neither capability
removes the runtime decryption gate.

## Approved execution sequence

The following are future operations, not authorization to perform them now.
All POST actions use existing administrator authorization, same-origin checks,
private/no-store responses, an ownership lock and atomic manifest/pointer CAS.
No API action accepts a Secret, database URL, credential or ciphertext.

| Step | Request / evidence |
| --- | --- |
| Prepare | POST `{"action":"prepare","confirm":"storage-key-migration:prepare"}`; record returned migration ID. Scan/decrypt all current auth/OAuth, create exact encrypted backups and verify them. |
| Validate | GET status: state prepared, all current records readable, backupVerified equals manifest coverage. Retry prepare after interruption or newly created records; existing backups are never replaced. |
| One owner Dashboard operation | Only after approval and verified prepare: in this project's Production environment create **STORAGE_ENCRYPTION_KEY**, type **Secret**, with a fresh cryptographically random value (e.g. 64 random hex characters). Keep a secure recovery copy; do not send it to chat or reuse PAT. Save only; do not change PIKPAK_PAT or the Worker's Secret. |
| Stage with new wrapping Secret | Build the reviewed SHA with the old source PAT plus the new Secret. The prepared manifest keeps Cloud on the proven old data key until activation. Verify read-only status and Quark auth first. |
| Activate | POST `{"action":"activate","id":"<returned ID>","confirm":"storage-key-migration:activate"}`. Read back and unwrap candidate and immutable backup; only then CAS the active pointer. No auth/OAuth keys are modified. |
| Verify | GET status: independentVerified true, no unreadable/unknown records, backups verified. Test real authorized Quark listing and a bounded existing media request through unchanged Worker; verify no access-policy changes and no unexpected auth loss. |
| Release | Confirm staged SHA, READY and Quark/Worker checks, then promote the tested migration-aware Production build. Read back the formal domain's deployment ID and source SHA. |
| PAT rotation later | Only after the above and separate owner approval, replace PAT with a valid PikPak credential, rebuild the same migration-aware source and validate TXT/PNG original downloads, isolation and Quark authorization. Re-login is expected; do not restart completed RAW/media tests. |

The status always returns `patRotationApproved: false`. It is encryption
evidence, not an automatic release/PAT authorization. A READY build alone does
not prove the formal domain switched or that Quark authorization survived.

## Failure and recovery

- Prepare interruption: retry the same action. The manifest ID and immutable
  backups are reused. A ciphertext changed before its first snapshot produces
  source_changed; retry snapshots the latest value, never a stale token.
- Wrong master, failed GCM authentication, corrupt backup or uncovered current
  records: refuse advancement; preserve originals. Prepare can extend backup
  coverage after activation without changing the active key. Inventory is
  bounded to 256 records and 100 SCAN pages per namespace; limit errors require
  inspection, not automatic retries or partial migration.
- Already-running Cloud without the wrapping Secret may use only the exact old
  PAT data key proven by the manifest during rollout. A configured but wrong
  wrapping Secret never falls back silently. A rotated PAT cannot substitute
  for that old key.
- Before PAT rotation, POST `rollback` with the migration ID and
  `confirm: storage-key-migration:rollback`. It verifies the old-key proof,
  current records and backups, then clears only the active pointer and marks
  the manifest prepared. It does not restore stale auth or revive expired OAuth.
- After PAT rotation, rollback to the PAT key is refused. Keep the new wrapping
  Secret and a migration-aware source. If the active wrapper/pointer is damaged,
  POST `recover` with the ID and `confirm: storage-key-migration:recover`.
  Verify the immutable wrapped backup and all current auth; back up any newly
  created records, copy the verified envelope to a new slot and CAS the pointer.
  Damaged slots and current credentials remain intact. Repeated healthy recovery
  is a no-op. If the wrapped backup or master is also lost/unreadable, stop.
- Never roll back to pre-migration application code after rotating PAT: it cannot
  resolve the wrapped data key. No migration action changes Secrets, Worker,
  DNS, permissions, existing admin hashes or active credential records.

## Local verification

```powershell
node --test tests/key-migration.test.js tests/storage-provider.test.js tests/access-api.test.js tests/permission-policy.test.js
npm run build
git diff --check
```

Tests cover orphan inventory, exact backups/expiry, interruption, idempotency,
wrong old key/master/AAD, corrupt ciphertext/backup, concurrent refresh and CAS,
PAT rotation, the actual unchanged Worker's decrypt/refresh path, rollback,
damaged or missing pointer recovery, Preview isolation, admin-only endpoints,
redaction and expected session invalidation. In-memory Redis fixtures exercise
command semantics; they do not claim live Upstash Lua or Production acceptance.
