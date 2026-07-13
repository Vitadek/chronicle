# Chronicle

A minimal, distraction-free writing app for novelists. TipTap-based editor,
multi-manuscript library, optional AI assistance, and a small sync backend
so your work travels between devices.

## Screenshots

**The Library** — your manuscripts, in light and dark mode:

<p align="center">
  <img src="screenshots/landing_page.webp" alt="The Library in light mode" width="49%">
  <img src="screenshots/landing_page_dark_mode.webp" alt="The Library in dark mode" width="49%">
</p>

**The writing space** — distraction-free, with focus dimming on the current paragraph:

<p align="center">
  <img src="screenshots/writing_space.webp" alt="Distraction-free writing space" width="90%">
</p>

**Export** — Standard Manuscript Format `.docx`, Markdown, HTML, or EPUB3 (with cover & table of contents):

<p align="center">
  <img src="screenshots/export_page.webp" alt="Export panel with .docx, Markdown, HTML and EPUB3 options" width="300">
</p>

## Quick start (local dev)

```bash
npm install
cp .env.example .env
npm run dev
```

Open <http://localhost:3000>. Data is written to `./data/chronicle.db`.

## Android client

The Android application, its embedded editor bundle, APK build, and mobile
release workflows now live in the standalone
[Chronicle Android repository](https://forgejo.lan/protoman/chronicle-android).
This repository contains only Chronicle's web application and core server.

## Quick start (Docker)

The published OCI image is intended for container-first deployment. No clone
or local build is needed — just drop this into a `docker-compose.yml`:

```yaml
services:
  chronicle:
    image: forgejo.lan/protoman/chronicle:latest
    container_name: chronicle
    restart: unless-stopped
    ports:
      - "3000:3000"           # -> http://localhost:3000
    volumes:
      - chronicle-data:/data  # manuscripts + SQLite DB live here
    environment:
      - AUTH_MODE=none        # single user, no login. Others: token | forward | oidc
      # Production images fail closed for unauthenticated non-loopback binds.
      # Set this only on a trusted/private network or behind another access control.
      - ALLOW_INSECURE_NO_AUTH=true

volumes:
  chronicle-data:
```

Then:

```bash
docker compose up -d
```

Open <http://localhost:3000> and start writing. Your work persists in the
`chronicle-data` volume, independent of the container. Update to the latest
build any time with:

```bash
docker compose pull && docker compose up -d
```

### Container release channels

`:edge` follows tested pushes to `main`; `:latest` is the newest stable
release. A signed, annotated source tag `vX.Y.Z` publishes container tags
`X.Y.Z`, `X.Y`, and `latest` (without the source tag's leading `v`). Forgejo is
the canonical registry; the GitHub mirror performs validation only.

Everything beyond the above is optional — see the reference below and
[`.env.example`](./.env.example) for the full commented version, and add
whichever you want under `environment:`.

> **Deploying for real?** See **[DEPLOY.md](./DEPLOY.md)** for a full production
> stack — Caddy (automatic HTTPS) + Authelia forward-auth + an asynchronous
> Nextcloud recovery replica — with ready-to-edit [`docker-compose.prod.yml`](./docker-compose.prod.yml)
> and [`.env.prod.example`](./.env.prod.example).

## Configuration (environment variables)

Every knob the server reads. All are optional unless noted; defaults shown.
[`.env.example`](./.env.example) has the same list with longer explanations.

### Core

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | SQLite DB + uploads live here (mount a volume) |
| `NODE_ENV` | — | `production` in the published image |

### Auth (`AUTH_MODE` — pick one)

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_MODE` | `none` | `none` \| `token` \| `forward` \| `oidc` |
| `ALLOW_INSECURE_NO_AUTH` | `false` | mode `none`: required in production when Chronicle binds beyond loopback; explicit trusted-network opt-in |
| `AUTH_TOKEN` | — | mode `token`: shared bearer token every client sends |
| `AUTH_FORWARD_HEADER_USER` | `Remote-User` | mode `forward`: identity headers from your proxy |
| `AUTH_FORWARD_HEADER_EMAIL` | `Remote-Email` | 〃 |
| `AUTH_FORWARD_HEADER_NAME` | `Remote-Name` | 〃 |
| `AUTH_FORWARD_HEADER_GROUPS` | `Remote-Groups` | 〃 |
| `AUTH_FORWARD_TRUSTED_PROXIES` | `loopback,linklocal,uniquelocal` | peers allowed to set those headers (presets or CIDRs) |
| `AUTH_FORWARD_SECRET_HEADER` / `AUTH_FORWARD_SECRET` | — | optional shared-secret check on top of headers |
| `AUTH_FORWARD_ADMIN_GROUP` | — | group name that grants admin |
| `AUTH_OIDC_ISSUER_URL` | — | mode `oidc` (**required**): issuer with discovery |
| `AUTH_OIDC_CLIENT_ID` / `AUTH_OIDC_CLIENT_SECRET` | — | mode `oidc` (**required**) |
| `AUTH_OIDC_REDIRECT_URI` | — | e.g. `https://host/api/auth/oidc/callback` |
| `AUTH_OIDC_SCOPES` | `openid profile email` | |
| `AUTH_OIDC_POST_LOGOUT_REDIRECT_URI` | — | |
| `AUTH_OIDC_TOKEN_AUTH_METHOD` | `auto` | `auto` \| `none` \| `client_secret_basic` \| `client_secret_post` |

### Storage

| Variable | Default | Purpose |
|---|---|---|
| `STORAGE_REPLICA` | `none` | exactly one async replica: `none` \| `nextcloud` \| `s3`; SQLite is always authoritative |
| `STORAGE_RETRY_INTERVAL_MS` | `30000` | background outbox polling interval |
| `STORAGE_MAX_ATTEMPTS` | `10` | attempts before a failed replica job is held for manual retry |
| `NEXTCLOUD_URL` | — | `nextcloud` (**required**): your Nextcloud base URL |
| `NEXTCLOUD_ALLOW_INSECURE_HTTP` | `false` | explicit trusted-LAN override; HTTPS is required by default |
| `NC_USER` / `NC_PASS` | — | `nextcloud` (**required**): Nextcloud user + **App Password** |
| `NC_DIR` | `Chronicle_Storage` | `nextcloud`: remote root for the portable replica |
| `S3_BUCKET` | — | `s3` (**required**): existing bucket name |
| `S3_REGION` | `us-east-1` | signing region |
| `S3_ENDPOINT` | AWS default | custom endpoint for MinIO, Cloudflare R2, Backblaze B2, or another S3-compatible service |
| `S3_PREFIX` | `chronicle` | object-key prefix inside the bucket |
| `S3_FORCE_PATH_STYLE` | `false` | use path-style bucket addressing, commonly needed by MinIO |
| `S3_ALLOW_INSECURE_HTTP` | `false` | explicitly allow an HTTP endpoint on a trusted LAN |
| `S3_SERVER_SIDE_ENCRYPTION` | — | optional `AES256` or `aws:kms` |
| `S3_KMS_KEY_ID` | — | KMS key ID when encryption is `aws:kms` |

S3 credentials use the AWS SDK's standard credential chain. For a simple
self-hosted deployment set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
(plus `AWS_SESSION_TOKEN` for temporary credentials); profiles, web identity,
and ECS/EC2 task roles also work without Chronicle-specific credential fields.

Replica writes are durable and asynchronous: normal reads always come from
SQLite, so a remote outage cannot stall editing. Provider-neutral objects use a
versioned layout under `v1/users/<user-id>/`, including manuscript metadata,
human-readable chapter HTML, profile/settings JSON, and covers. The remote is a
recovery replica, not a second live database.

Deleting a manuscript or chapter replaces its live portable payload at the
same key with a revisioned tombstone; a chapter tombstone contains no prose.
Restore applies these tombstones so deleted work cannot reappear from an older
replica snapshot. Opaque blobs such as covers are deleted physically.

The deprecated `STORAGE_PROVIDER=sqlite|hybrid` mapping remains temporarily for
upgrades (`sqlite` maps to `none`, `hybrid` to `nextcloud`). New deployments
should use `STORAGE_REPLICA`. It selects exactly one target; variables belonging
to the unselected provider are ignored.

Replica operations are available from the maintenance CLI:

```bash
npm run storage -- status
npm run storage -- verify [--prefix <replica-prefix>]
npm run storage -- retry [--key <replica-key>]
npm run storage -- seed
npm run storage -- backup [--output <path>]
npm run storage -- restore [--user <id>] [--apply] [--force]
```

`backup` uses SQLite's online backup API and defaults to `DATA_DIR` (`/data` in
the container). `verify` exits with status 2 for missing, unexpected,
mismatched, or unverifiable objects; unexpected results include remote orphan
keys absent from local desired state. S3 exposes Chronicle's checksum and
generation metadata, while some WebDAV servers cannot make every object fully
verifiable.

`restore` requires a configured remote and is a dry run unless `--apply` is
present. It refuses to overwrite existing records unless `--force` is explicit,
creates a hot SQLite backup before applying changes, and merges replica records
rather than implicitly replacing every local row. It is never part of the
application read path.

Restore apply must run offline. Stop Chronicle and use a one-off container
against the same `/data` volume (`docker compose run --rm --no-deps chronicle
node dist/cli.cjs restore --apply --force`), then restart it. Do not use
`docker compose exec` for apply because that leaves the server's SQLite
connection live. Preserve the automatic `chronicle-before-restore-*.db` backup.

### Nextcloud OAuth identity (optional)

| Variable | Default | Purpose |
|---|---|---|
| `NEXTCLOUD_CLIENT_ID` / `NEXTCLOUD_CLIENT_SECRET` | — | OAuth app credentials |
| `NEXTCLOUD_REDIRECT_URI` | — | e.g. `https://host/api/auth/nextcloud/callback` |

OAuth may be used for identity without adding a second storage destination.
The legacy OAuth `NEXTCLOUD_MIRROR` write path is removed. Setting
`NEXTCLOUD_MIRROR=true` or a nonempty `NEXTCLOUD_MIRROR_ROOT` is a startup
error; remove both settings and use `STORAGE_REPLICA=nextcloud` with `NC_USER`
and `NC_PASS` when Nextcloud is the recovery replica.

### AI (optional — keys stay server-side, never in the browser)

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | — | set any subset; only configured providers are offered in the UI |
| `AI_MODEL` | `gpt-4o` | default text model when the client doesn't pick one |
| `AUDIO_MODEL` | `gpt-4o-mini-tts` | OpenAI TTS for `#!/ai_listen` |
| `AUDIO_VOICE` | `alloy` | TTS voice |
| `AI_UI` | `on` | **`off` (or `false`/`0`/`no`) removes every AI surface from the app** (settings panels, toggles, `#!/ai_*` commands, bubble menu) *and* the server refuses AI API calls with 403 — for purely manual writing setups. Anything else (or unset) keeps AI on |

### Grammar (optional LanguageTool sidecar)

| Variable | Default | Purpose |
|---|---|---|
| `LANGUAGETOOL_URL` | `http://languagetool:8010` | LanguageTool server for grammar checking |
| `LANGUAGETOOL_LANG` | `en-US` | check language |
| `GRAMMAR_AI_MODEL` | `gemini-2.5-flash` | model for AI-assisted grammar suggestions |

### Build from source instead

To build the image yourself (e.g. to hack on it), the repo's
`docker-compose.yml` uses `build: .`:

```bash
git clone https://forgejo.lan/protoman/chronicle.git
cd chronicle
docker compose up -d --build
```

## Validation

The fast source gate runs typechecking, core regressions, the production build,
and the production dependency audit:

```bash
npm run lint
npm run test:core
npm run build
npm audit --omit=dev --audit-level=high
```

The destructive formal gate treats an exact OCI image as the product boundary
and exercises the API, concurrency, collaboration, real MinIO replication,
forced S3 failure/recovery, hot backup, and restart durability:

```bash
CHRONICLE_IMAGE=forgejo.lan/protoman/chronicle:<candidate> npm run test:formal
```

It uses isolated Docker Compose volumes, cleans them after every run, and
captures TAP, JSON, logs, image inspection, CLI output, and the test backup.
See [tests/formal/README.md](./tests/formal/README.md) for the exact matrix.

## Features

- **Multi-manuscript library** — each book has its own metadata, chapter
  list, and cover art.
- **Revision-aware sync** — write on your laptop, pick up on your phone.
  Sync v2 uses per-record revisions plus a durable history epoch and monotonic
  server cursor, so devices editing different chapters do not step on each
  other, restored histories replay safely, and stale writes return an explicit
  conflict. A stale-history push is rejected before mutation while its local
  draft receives the authoritative reset replay. See [BACKEND.md](./BACKEND.md)
  for the protocol.
- **Standard Manuscript Format export** — Shunn-style .docx that agents
  expect. Per-chapter export too.
- **HTML and EPUB3 export** — single-file HTML for sharing, EPUB3 with
  cover image and copyright page for readers.
- **AI assistance (optional)** — review, outline, listen (TTS), and reader
  comments. Reviews never suggest changes — they describe.
- **Plot + Characters outline** — character sheets following the Local
  Script Man Character Map framework, and a simple drag-and-drop plot
  canvas with character lanes and events.
- **Optional remote recovery replica** — choose Nextcloud WebDAV or generic S3
  (AWS, MinIO, R2, B2, and compatible services). SQLite remains the fast,
  authoritative store.
- **Plugins** — install by pasting a git URL; the server compiles them for
  you. See below.
- **Container-first** — one image, one volume, no external services
  required.

## Plugins

Chronicle's bigger features are **plugins**: install what you want, skip what you
don't, and keep the app light. A plugin is just a git repo — paste its URL into
**Settings → Plugins → Install from git** and Chronicle clones and compiles it
server-side. Nothing to build or download by hand.

| Plugin | Install URL |
|---|---|
| **Proofreader** — guided spelling/grammar/AI-clarity pass | `https://github.com/Vitadek/chronicle-plugin-proofreader.git` |
| **Outliner** — plot canvas, character sheets, synopsis, pop-out window | `https://github.com/Vitadek/chronicle-plugin-outliner.git` |
| **Grammar Check** — LanguageTool squiggles + custom dictionary | `https://github.com/Vitadek/chronicle-plugin-grammar-check.git` |
| **Tense Check** — flags narrative tense drift | `https://github.com/Vitadek/chronicle-plugin-tense-check.git` |
| **Autocorrect** — deterministic fixes as you type | `https://github.com/Vitadek/chronicle-plugin-autocorrect.git` |
| **Issues Panel** — every checker finding in one list | `https://github.com/Vitadek/chronicle-plugin-issues-panel.git` |
| **Smart Thesaurus** — selection synonyms, offline-first | `https://github.com/Vitadek/chronicle-plugin-thesaurus.git` |

Plugins **declare what they need**, and Chronicle enforces it — so there's nothing
to set up first:

- Grammar Check, Tense Check and Autocorrect **replace** the built-in versions.
  The built-in stands down on its own (no doubled squiggles) and comes back the
  moment you disable the plugin.
- A plugin needing the LanguageTool sidecar won't enable while it's down — it
  tells you, instead of silently flagging nothing.
- The Issues Panel says *"Limited — no checker"* rather than showing a blank list.

Updates are explicit: **Check for updates** shows you the incoming commits before
you apply them, and you can **pin** a plugin to a commit so nothing shifts
mid-draft.

Writing your own is a `chronicle-plugin.json` and one `.tsx` file — no build
tooling. **[PLUGINS.md](./PLUGINS.md)** has the API, the contribution slots, the
dependency/capability system, and the trust model (plugins run with full
privileges — install only repos you trust).

See [BACKEND.md](./BACKEND.md) for architecture, the sync protocol, and
deployment notes.
