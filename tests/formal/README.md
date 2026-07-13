# Chronicle formal black-box suite

This suite treats the Chronicle OCI image as the product boundary. The app
container receives only a named `/data` volume: Chronicle source is never bind
mounted into it. The default candidate is
`forgejo.lan/protoman/chronicle:core-candidate-20260713-r5`; select another exact
candidate with `CHRONICLE_IMAGE`.

Run the entire destructive, isolated suite from the repository root:

```sh
npm run test:formal
CHRONICLE_IMAGE=forgejo.lan/protoman/chronicle:ci-<commit> npm run test:formal
```

The harness creates and later removes its own Compose volumes. Do not point it
at a real Chronicle database or bucket. Docker Engine with Compose v2 is the
only host prerequisite. The first run may pull the digest-pinned Node 22,
MinIO, MinIO Client, and Toxiproxy images.

## What is exercised

- five isolated fail-closed production boot cases with explicit timeout
  cleanup against the exact candidate image;
- health, sanitized readiness, public static assets, forward-auth rejection,
  user isolation, and JSON API 404 behavior;
- deterministic LanguageTool proxy behavior;
- Unicode manuscript CRUD, optimistic revisions, same-record conflicts,
  different-chapter v2 concurrency, idempotent deletes, and scrubbed
  tombstones;
- legacy sync LWW/tombstone convergence, v2 conflicts, restored-cursor reset,
  and bounded pagination beyond 1,000 log entries;
- settings validation/privacy and cover magic, size, byte, cache, and ownership
  checks;
- collaboration handshake authorization, document scoping, two-client Yjs
  convergence, reconnect persistence, and process-restart persistence;
- real S3-compatible replication through Toxiproxy to MinIO, including exact
  portable keys, object content types, Chronicle checksum/generation metadata,
  human-readable chapter envelopes, tombstones, and cover deletion;
- a forced S3 outage proving SQLite writes and reads continue, degraded
  readiness remains sanitized, bounded work reaches dead letter, the admin CLI
  retries it, deep verification passes, and all missing objects recover;
- hot SQLite backup through `dist/cli.cjs`, backup artifact capture, container
  restart, identity/data/settings/tombstone/collaboration durability, and final
  replica verification;
- a real-MinIO recovery snapshot followed by seven dead-lettered local
  divergences: manuscript/chapter edits, profile/settings changes, cover loss,
  and an accidental live-manuscript delete;
- exact all-user and user-filtered restore dry runs, refusal without `--force`,
  offline forced apply from the same image and `/data` volume, and integrity
  inspection plus capture of the automatic pre-restore backup;
- recovery of snapshot data/settings/cover/live records, retained tombstones,
  advanced revisions, legacy visibility, v2 epoch reset with a nonempty
  rejected mutation, collaboration non-resurrection, and deep verification.

The gate contains 97 TAP cases: the original 72 cases, five boot preflights,
eight pre-restore cases, and twelve post-restore cases. Every phase emits TAP
plus a JSON report. `run.sh` always captures resolved
Compose configuration, full timestamped service logs, container status, exact
image inspection, CLI outputs, and the test-only hot backup in
`tests/formal/artifacts/`. The directory is ignored by Git.

## Mandatory offline restore workflow

Restore apply is a recovery operation. Chronicle must be stopped, while the
configured replica remains reachable. Review the dry run before applying:

```sh
docker compose stop chronicle
docker compose run --rm --no-deps chronicle node dist/cli.cjs restore
docker compose run --rm --no-deps chronicle node dist/cli.cjs restore --user '<user-id>'
docker compose run --rm --no-deps chronicle node dist/cli.cjs restore --apply --force
docker compose up --detach chronicle
docker compose exec chronicle node dist/cli.cjs verify
```

Never use `docker compose exec chronicle ... restore --apply`: `exec` requires
the application and its SQLite connection to remain live. Apply creates
`/data/chronicle-before-restore-*.db`; retain and verify that automatic backup
before resuming traffic. It also rotates the v2 history epoch, forcing clients
to replay authoritative state before attempting another mutation.

## Infrastructure pinning

Compose infrastructure is content-addressed:

- Node 22 runner: `sha256:16e22a…c3e2`
- MinIO: `sha256:a1ea29…015e`
- MinIO Client: `sha256:aead63…28e3`
- Toxiproxy: `sha256:9378ed…214e`

Only `CHRONICLE_IMAGE` is intentionally supplied by tag because release CI
builds that exact local candidate once, runs this suite against the same image
ID, and publishes tags only after the gate passes. `pull_policy: never` prevents
Compose from silently replacing the tested local image.

Release CI supplies a unique lowercase `COMPOSE_PROJECT_NAME`, so concurrent
jobs sharing a Docker daemon cannot reuse runner images, networks, or volumes.

## Browser tier

The API/storage/recovery suite is the mandatory release gate. A separately
callable Playwright tier is scaffolded under `browser/` for editor-focused
autosave/offline/stale-load checks; it is deliberately not part of this Docker
gate until its browser image and accessibility selectors are pinned.
