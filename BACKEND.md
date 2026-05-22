# Chronicle Backend

Small, container-friendly sync backend for the Chronicle writing app.
Designed to be self-hostable on a single VPS or a Raspberry Pi.

## Stack

- **Express** — supports Vite middleware in dev.
- **better-sqlite3** — single file, WAL mode, plenty fast for one writer.
- **openid-client** — OIDC discovery + auth code + PKCE done properly.
- **ipaddr.js** — CIDR matching for trusted-proxy verification.
- **zod** — request validation on the sync endpoint.
- **jszip** — EPUB3 file assembly.

## Layout

```
server/
├── index.ts              -- entry, mounts routes, dev/prod static serving
├── config.ts             -- env-driven config + validation
├── db.ts                 -- SQLite, schema, migrations, tombstone GC
├── auth.ts               -- mode dispatcher + session/user helpers
├── oidc.ts               -- openid-client wrapper (lazy discovery)
├── trust.ts              -- CIDR matching for forward-auth peer verification
├── nextcloud/
│   └── webdav.ts         -- write-behind WebDAV mirror
├── routes/
│   ├── auth.ts           -- /api/auth/* (oidc, nextcloud, /me, /logout, /config)
│   ├── sync.ts           -- /api/sync (LWW per record, tombstones)
│   ├── manuscripts.ts    -- legacy CRUD (kept for the in-tree UI)
│   ├── ai.ts             -- /api/ai/respond + /api/ai/speak proxy
│   └── covers.ts         -- cover-art upload/serve/delete
└── scripts/
    └── migrate.ts        -- one-shot legacy file-store importer
```

## Auth modes

Pick exactly one via `AUTH_MODE`. Each is independent.

| Mode | What it does | When to use |
| --- | --- | --- |
| `none` | No auth. Single local user. | Trusted networks, single-user self-hosting on Tailscale, etc. |
| `token` | Static bearer token (`AUTH_TOKEN`). Same token from every device. | Personal use behind a public URL without setting up an IdP. |
| `forward` | Trust identity headers from a reverse proxy. | Already running Authelia/Authentik/oauth2-proxy with Traefik/Caddy/Nginx. |
| `oidc` | Standard OIDC discovery flow. | You have an IdP (Keycloak, Authentik, Authelia, Auth0, Google, …). |

## AI configuration

AI is **server-side**. Set `OPENAI_API_KEY` (and optionally `ANTHROPIC_API_KEY`)
in the server env; users never paste keys into the browser. The client
chooses the model — suggested defaults plus user-added IDs — and sends
just the model + prompt to the server, which forwards to the configured
provider.

If neither key is set, the AI Agent toggle in Settings is disabled with
an explanation.

## Sync protocol

Unchanged: one round trip per call, last-write-wins per record
(per-manuscript metadata, per-chapter, per-profile, per-character,
per-plot-node, per-plot-edge), tombstones for deletes. See `sync.ts`.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/healthz` | none | liveness probe |
| GET | `/api/auth/config` | none | tells client which mode + login URL + AI availability |
| GET | `/api/auth/oidc/start` | none | begin OIDC flow |
| GET | `/api/auth/oidc/callback` | none | OIDC callback |
| GET | `/api/auth/nextcloud/start` | none | begin Nextcloud OAuth (for WebDAV mirror) |
| GET | `/api/auth/nextcloud/callback` | none | Nextcloud callback |
| GET | `/api/auth/me` | yes | current user info |
| POST | `/api/auth/logout` | yes | clear session |
| POST | `/api/sync` | yes | bulk push+pull |
| GET, POST, PUT, DELETE | `/api/manuscripts[/:id]` | yes | manuscript CRUD |
| POST | `/api/ai/respond` | yes | OpenAI/Anthropic text proxy |
| POST | `/api/ai/speak` | yes | TTS (OpenAI audio/speech) |
| GET | `/api/ai/models` | yes | suggested models + availability |
| POST, GET, DELETE | `/api/covers/:id` | yes | cover art upload/serve/delete |

## Deployment

```bash
docker compose up -d
```

That's it for `AUTH_MODE=none`. For other modes, add the relevant env vars
to `docker-compose.yml`.

## Backups

```bash
docker compose exec chronicle sqlite3 /data/chronicle.db ".backup /data/chronicle.db.bak"
```

WAL means hot copies need either the `.backup` SQL command (preferred) or
stopping the container.
