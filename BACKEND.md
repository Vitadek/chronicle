# Chronicle Backend

Small, container-friendly sync backend for the Chronicle writing app.
Designed to be self-hostable on a single VPS or a Raspberry Pi.

## Stack

- **Express** — supports Vite middleware in dev.
- **better-sqlite3** — single file, WAL mode, plenty fast for one writer.
- **AWS SDK for JavaScript** — generic Signature V4 S3 replication (AWS,
  MinIO, R2, B2, and compatible services).
- **openid-client** — OIDC discovery + auth code + PKCE done properly.
- **ipaddr.js** — CIDR matching for trusted-proxy verification.
- **zod** — request validation on the sync endpoint.
- **jszip** — EPUB3 file assembly.

## Layout

```
server/
├── index.ts              -- entry, mounts routes, dev/prod static serving
├── config.ts             -- env-driven config + validation
├── db.ts                 -- authoritative SQLite schema + migrations
├── auth.ts               -- mode dispatcher + session/user helpers
├── oidc.ts               -- openid-client wrapper (lazy discovery)
├── trust.ts              -- CIDR matching for forward-auth peer verification
├── lib/
│   ├── portableReplica.ts -- versioned provider-neutral recovery records
│   └── storage/           -- SQLite blobs + durable S3/Nextcloud outbox
├── routes/
│   ├── auth.ts           -- /api/auth/* (oidc, nextcloud, /me, /logout, /config)
│   ├── sync.ts           -- legacy sync + revision/cursor sync v2
│   ├── manuscripts.ts    -- legacy CRUD (kept for the in-tree UI)
│   ├── ai.ts             -- /api/ai/respond + /api/ai/speak proxy
│   └── covers.ts         -- cover-art upload/serve/delete
└── scripts/
    └── migrate.ts        -- one-shot legacy file-store importer
```

Production browser assets are emitted to `dist/client`; the server and
maintenance CLI are bundled as `dist/server.cjs` and `dist/cli.cjs`. Express
serves only `dist/client`, so the server and CLI bundles are not web-accessible.

## Auth modes

Pick exactly one via `AUTH_MODE`. Each is independent.

| Mode | What it does | When to use |
| --- | --- | --- |
| `none` | No auth. Single local user. | Trusted networks, single-user self-hosting on Tailscale, etc. |
| `token` | Static bearer token (`AUTH_TOKEN`). Same token from every device. | Personal use behind a public URL without setting up an IdP. |
| `forward` | Trust identity headers from a reverse proxy. | Already running Authelia/Authentik/oauth2-proxy with Traefik/Caddy/Nginx. |
| `oidc` | Standard OIDC discovery flow. | You have an IdP (Keycloak, Authentik, Authelia, Auth0, Google, …). |

An invalid `AUTH_MODE` is a startup error. In production, `AUTH_MODE=none`
also fails closed when Chronicle binds beyond loopback unless the operator sets
`ALLOW_INSECURE_NO_AUTH=true`. That opt-in is intended only for a deliberately
trusted/private network; use token, forward auth, or OIDC for public access.

## AI configuration

AI is **server-side**. Set `OPENAI_API_KEY` (and optionally `ANTHROPIC_API_KEY`)
in the server env; users never paste keys into the browser. The client
chooses the model — suggested defaults plus user-added IDs — and sends
just the model + prompt to the server, which forwards to the configured
provider.

If neither key is set, the AI Agent toggle in Settings is disabled with
an explanation.

## Authoritative storage and replicas

SQLite is always Chronicle's authoritative live store. `STORAGE_REPLICA` picks
zero or one asynchronous recovery target:

| Value | Remote target |
| --- | --- |
| `none` | SQLite only (default) |
| `nextcloud` | Nextcloud WebDAV using an App Password |
| `s3` | Generic S3 using AWS Signature V4 |

Every local mutation commits with its durable outbox record. A worker uploads
objects in the background with per-key generations, checksums, exponential
backoff, and a dead-letter state after `STORAGE_MAX_ATTEMPTS`. Normal reads
never fall through to the remote, so a replica outage degrades recovery
coverage without blocking editing or making a stale object live.

Portable replica keys are versioned and provider-neutral:

```text
v1/users/<user-id>/
├── profile.json
├── settings.json
├── covers/<cover-object>
└── manuscripts/<manuscript-id>/
    ├── metadata.json
    └── chapters/<chapter-id>.html
```

Path segments are URL-encoded. Metadata/profile/settings are JSON; chapters are
human-readable HTML with embedded Chronicle revision metadata. This layout is
used by both Nextcloud and S3 and can evolve under a new top-level version.

Deleting a manuscript or chapter replaces its live portable payload at the
same key with a revisioned tombstone; a chapter tombstone contains no prose.
Restore applies tombstones so an older replica object cannot resurrect deleted
work. Opaque blobs such as covers retain normal physical-delete semantics.

For S3, set `S3_BUCKET`; optionally set `S3_ENDPOINT` for MinIO, Cloudflare R2,
Backblaze B2, or another compatible endpoint. `S3_REGION`, `S3_PREFIX`,
`S3_FORCE_PATH_STYLE`, `S3_SERVER_SIDE_ENCRYPTION`, and `S3_KMS_KEY_ID` control
provider details. HTTP endpoints are rejected unless
`S3_ALLOW_INSECURE_HTTP=true` is explicitly set for a trusted LAN. Credentials
come from the AWS SDK's standard Node credential chain: environment keys,
shared profiles/process providers, web identity, ECS, or EC2 roles.

The old `STORAGE_PROVIDER` setting is deprecated but temporarily mapped for
upgrades: `sqlite` becomes `STORAGE_REPLICA=none`, and `hybrid` becomes
`STORAGE_REPLICA=nextcloud`.

The separate OAuth `NEXTCLOUD_MIRROR` write path is removed. A true
`NEXTCLOUD_MIRROR` or nonempty `NEXTCLOUD_MIRROR_ROOT` is a startup error;
remove both and select `STORAGE_REPLICA=nextcloud` when needed.

### Replica maintenance

The storage CLI exposes status, integrity verification, failed-job retry,
full-manifest seeding, and explicit recovery:

```bash
npm run storage -- status
npm run storage -- verify [--prefix <replica-prefix>]
npm run storage -- retry [--key <replica-key>]
npm run storage -- seed
npm run storage -- backup [--output <path>]
npm run storage -- restore [--user <id>] [--apply] [--force]
```

Inside Docker, `exec chronicle` is suitable for status, verify, retry, seed,
backup, and restore dry-runs only. Restore apply uses the stopped-service
one-off workflow below. Backups use SQLite's online backup API and default to
`DATA_DIR` (`/data` in the container).
`verify` exits 2 for missing, unexpected, mismatched, or unverifiable objects.
Unexpected objects include both retained desired deletes and remote orphan keys
that are absent from the local manifest. S3 exposes full Chronicle metadata,
while some WebDAV servers cannot make every object fully verifiable.

`restore` requires a configured remote and is a dry run unless `--apply` is
present. It refuses existing records unless `--force` is explicit, creates a
hot backup before applying, and merges replica records. Apply is mandatory
offline: stop Chronicle, then use `docker compose run --rm --no-deps chronicle
node dist/cli.cjs restore --apply [--force]` against the same `/data` volume.
Never use `docker compose exec` for apply because it leaves the server's SQLite
connection live. Chronicle never
restores from a remote during normal reads or startup. Applied records receive
an effective restore-time `last_modified` without moving a newer source/local
clock backward, so legacy `/api/sync` clients also pull restored state when
their `since` cursor is newer than the portable snapshot timestamps.

## Sync protocol

`POST /api/sync` remains the compatibility protocol: one round trip,
last-write-wins per record, and tombstones for deletes.

New clients should use `POST /api/sync/v2`. A request carries the last monotonic
server `cursor`, the last learned history `epoch`, and zero or more record
mutations. Each mutation names its `baseRevision`; the server accepts it only
when that revision matches the current manuscript, chapter, or profile record.
The response includes:

- the durable history epoch;
- a new server cursor;
- `accepted` or `conflict` plus the authoritative revision for every pushed
  record; and
- all authoritative changes after the request cursor, collapsed to the latest
  representation of each record.

An explicit restore rotates the durable epoch. The server validates an explicit
epoch before applying any mutation. On a mismatch it applies no pushed records,
returns each attempted mutation as `status: "conflict"` with
`reason: "history_epoch_mismatch"` and the authoritative current record, adds
`reset: true`, and replays the bounded change log from its beginning. The
response remains HTTP 200 so the client can retain/reconcile its local draft
while adopting the reset in the same round trip. This remains reliable even if
new writes have already advanced the numeric sequence beyond the old cursor.
A cursor above the current maximum remains a compatibility reset signal for
older clients; mutations accompanying that signal are likewise rejected before
application with `reason: "cursor_ahead_of_history"`. Clients persist cursor and
epoch per verified user, accept the returned lower cursor on reset, and continue
while `hasMore` is true; migration and restore paths ensure that replay
represents the complete current state.

This prevents a stale whole-manuscript save from overwriting a newer chapter,
while allowing two devices to edit different records independently. Deletes
are explicit revisioned mutations rather than inferred from an omitted chapter.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/healthz` | none | liveness probe |
| GET | `/readyz` | none | SQLite readiness plus replica status (`healthy`, `degraded`, or disabled) |
| GET | `/api/auth/config` | none | tells client which mode + login URL + AI availability |
| GET | `/api/auth/oidc/start` | none | begin OIDC flow |
| GET | `/api/auth/oidc/callback` | none | OIDC callback |
| GET | `/api/auth/nextcloud/start` | none | begin optional Nextcloud OAuth identity flow |
| GET | `/api/auth/nextcloud/callback` | none | Nextcloud callback |
| GET | `/api/auth/me` | yes | current user info |
| POST | `/api/auth/logout` | yes | clear session |
| POST | `/api/sync` | yes | bulk push+pull |
| POST | `/api/sync/v2` | yes | revision-aware push+cursor pull |
| GET, POST, PUT, DELETE | `/api/manuscripts[/:id]` | yes | manuscript CRUD |
| POST | `/api/ai/respond` | yes | OpenAI/Anthropic text proxy |
| POST | `/api/ai/speak` | yes | TTS (OpenAI audio/speech) |
| GET | `/api/ai/models` | yes | suggested models + availability |
| POST, GET, DELETE | `/api/covers/:id` | yes | cover art upload/serve/delete |

## Deployment

```bash
docker compose up -d
```

For local development, that is enough. A production container using
`AUTH_MODE=none` beyond loopback must also set
`ALLOW_INSECURE_NO_AUTH=true`; for other modes, add the relevant env vars to
`docker-compose.yml`.

## Backups

```bash
docker compose exec chronicle npm run storage -- backup
```

WAL means hot copies need Chronicle's backup command (which uses SQLite's
online backup API) or a stopped container. A remote replica improves recovery
options, but it does not replace SQLite backup testing. Use
`npm run storage -- verify` to check the configured replica and the explicit
`restore` command only during recovery.
