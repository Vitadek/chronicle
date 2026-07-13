# Production deployment

A real, hardened setup: **Chronicle behind [Caddy](https://caddyserver.com)
(automatic HTTPS) with [Authelia](https://www.authelia.com) forward-auth and
[Nextcloud](https://nextcloud.com) asynchronous recovery replica.** SQLite
remains Chronicle's authoritative store. This is the same shape as a
working single-VPS install; adjust names to taste.

```
                internet
                   │  :80 / :443
              ┌────▼─────┐   forward_auth (/api/verify)   ┌───────────┐
              │  Caddy   │ ───────────────────────────────▶│ Authelia  │
              │ (TLS/LE) │◀── Remote-User / Remote-Email ──│  (IdP)    │
              └────┬─────┘                                 └───────────┘
                   │ reverse_proxy chronicle:3000
              ┌────▼──────┐   durable async copy  ┌─────────────────────┐
              │ Chronicle │ ─────────────────────▶│ Nextcloud (WebDAV)  │
              │ SQLite    │      LanguageTool      └─────────────────────┘
              └───────────┘  (internal grammar)
```

Only Caddy is published to the host. Chronicle, Authelia, and LanguageTool talk
over the internal Docker network. Files used: `docker-compose.prod.yml`,
`.env.prod.example`, `Caddyfile`, `authelia/`.

## 1. Prerequisites

- A host with Docker + the Compose plugin, ports **80** and **443** reachable
  from the internet (Caddy needs them for the ACME/Let's Encrypt challenge).
- A domain and two subdomains — one for the app, one for the login page:
  - `chronicle.example.com`
  - `auth.example.com`

## 2. DNS

Point both names at the host's public IP:

```
chronicle.example.com   A   203.0.113.10
auth.example.com        A   203.0.113.10
```

## 3. Secrets

```bash
cp .env.prod.example .env
$EDITOR .env      # domains, Nextcloud app password, AI keys
```

`.env` holds every secret — **add it to `.gitignore` and never commit it.** For
the Nextcloud password use a **Nextcloud App Password** (Nextcloud → Settings →
Security → *Create new app password*), not your login password.

## 4. Caddy (`Caddyfile`)

The shipped `Caddyfile` has a commented production block. Replace the
`*.localhost` dev block with the production one below — no cert paths needed;
Caddy fetches and renews Let's Encrypt certificates automatically:

```caddy
{
    admin off
}

chronicle.example.com {
    forward_auth authelia:9091 {
        uri /api/verify?rd=https://auth.example.com/
        copy_headers Remote-User Remote-Email Remote-Groups
    }
    reverse_proxy chronicle:3000
}

auth.example.com {
    reverse_proxy authelia:9091
}
```

> Prefer to manage certs yourself with certbot? Add a
> `tls /etc/letsencrypt/live/<domain>/fullchain.pem /etc/letsencrypt/live/<domain>/privkey.pem`
> line to each block and mount `/etc/letsencrypt:/etc/letsencrypt:ro` into the
> caddy service. Caddy's built-in ACME is simpler and needs neither.

## 5. Authelia (`authelia/`)

**a. Domains** — in `authelia/configuration.yml`, set your real hostnames in
`session.cookies[].domain` + `authelia_url`, and in the `access_control` rule.

**b. Generate three secrets** and replace the placeholder strings
(`a_very_long_random_*`) in `configuration.yml`:

```bash
openssl rand -hex 64   # session.secret
openssl rand -hex 64   # storage.encryption_key
openssl rand -hex 64   # identity_validation.reset_password.jwt_secret
```

**c. Create your user** in `authelia/users_database.yml`. Hash the password with
Authelia's own tool (don't store plaintext):

```bash
docker run --rm authelia/authelia:4.38 \
  authelia crypto hash generate argon2 --password 'your-strong-password'
```

Paste the resulting `$argon2id$...` string into the user's `password:` field and
set `displayname` / `email`.

## 6. Choose one asynchronous replica

`docker-compose.prod.yml` sets `STORAGE_REPLICA=nextcloud`. Chronicle commits
every change to local SQLite first, then processes a durable background outbox
to copy portable records and covers beneath `NC_DIR`. Nothing to install on the
Nextcloud side beyond the app password from step 3 — the first write creates
`Chronicle_Storage/`.

Normal reads always use SQLite. If Nextcloud is unavailable, editing continues
and `/readyz` reports the replica as degraded until queued work succeeds. The
remote layout is versioned beneath `v1/users/<user-id>/`: JSON manuscript
metadata, human-readable chapter HTML, profile/settings JSON, and covers.

Deleting a manuscript or chapter replaces its live portable payload at the
same key with a revisioned tombstone; chapter tombstones contain no prose.
Restore applies these tombstones so older remote content cannot resurrect
deleted work. Opaque blobs such as covers are deleted physically.

Prefer everything local? Set `STORAGE_REPLICA=none` and drop the `NC_*` vars.

### S3 instead of Nextcloud

Chronicle also supports AWS S3, MinIO, Cloudflare R2, Backblaze B2, and other
Signature V4-compatible services. Set `STORAGE_REPLICA=s3` in `.env` and use an
existing bucket. The supplied Compose file already passes these variables:

```yaml
environment:
  STORAGE_REPLICA: s3
  S3_BUCKET: ${S3_BUCKET}
  S3_REGION: ${S3_REGION:-us-east-1}
  S3_ENDPOINT: ${S3_ENDPOINT:-}       # omit/empty for AWS
  S3_PREFIX: ${S3_PREFIX:-chronicle}
  S3_FORCE_PATH_STYLE: ${S3_FORCE_PATH_STYLE:-false}
  S3_ALLOW_INSECURE_HTTP: ${S3_ALLOW_INSECURE_HTTP:-false}
  S3_SERVER_SIDE_ENCRYPTION: ${S3_SERVER_SIDE_ENCRYPTION:-}
  S3_KMS_KEY_ID: ${S3_KMS_KEY_ID:-}
  AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}
  AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}
  AWS_SESSION_TOKEN: ${AWS_SESSION_TOKEN:-}
```

The AWS SDK standard credential chain is used, so mounted profiles, web
identity, and ECS/EC2 roles can replace static keys. Custom endpoints must be
HTTPS unless `S3_ALLOW_INSECURE_HTTP=true` is deliberately set on a trusted
LAN. Optional server-side encryption is configured with
`S3_SERVER_SIDE_ENCRYPTION=AES256|aws:kms` and `S3_KMS_KEY_ID` for KMS.

`STORAGE_REPLICA` accepts exactly `none`, `nextcloud`, or `s3`; configure only
one remote. The deprecated `STORAGE_PROVIDER=sqlite|hybrid` compatibility
mapping exists for upgrades, but should not be used in new deployments.

## 7. Launch

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f chronicle   # watch first boot
```

Open `https://chronicle.example.com` — you'll be bounced to Authelia to log in,
then land in your Library. On boot Chronicle probes any configured AI keys and
logs OK/INVALID for each.

Check readiness and replica state from the host network:

```bash
docker compose -f docker-compose.prod.yml exec chronicle \
  wget -qO- http://127.0.0.1:3000/readyz
```

## 8. Updates & backups

```bash
# update to the latest published image
docker compose -f docker-compose.prod.yml pull && \
docker compose -f docker-compose.prod.yml up -d

# hot backup of the SQLite DB (WAL-safe; prints the created path)
docker compose -f docker-compose.prod.yml exec chronicle \
  npm run storage -- backup

# inspect and verify the configured async replica
docker compose -f docker-compose.prod.yml exec chronicle \
  npm run storage -- status
docker compose -f docker-compose.prod.yml exec chronicle \
  npm run storage -- verify
```

Use `npm run storage -- retry` to requeue failed jobs and
`npm run storage -- seed` to requeue the complete desired-state manifest.
`verify` exits 2 for missing, unexpected, mismatched, or unverifiable objects;
S3 exposes full Chronicle metadata, while some WebDAV servers cannot make every
object fully verifiable.

`npm run storage -- restore` requires the configured remote and performs a dry
run. Repeat with `--apply` only after reviewing it; existing records require an
additional `--force`. Apply creates a hot SQLite backup first and merges remote
records rather than replacing every local row. Restore is never automatic and
never participates in normal reads; test both SQLite backups and remote
recovery before relying on them. Restore stamps applied records with an
effective restore time, ensuring legacy sync clients whose cursors postdate the
portable backup still receive the recovered manuscript, chapter, and profile
state.

Apply only while Chronicle is stopped. Keep the replica dependency available
and use a one-off container against the same named `/data` volume:

```bash
docker compose -f docker-compose.prod.yml stop chronicle
docker compose -f docker-compose.prod.yml run --rm --no-deps chronicle \
  node dist/cli.cjs restore
docker compose -f docker-compose.prod.yml run --rm --no-deps chronicle \
  node dist/cli.cjs restore --apply --force
docker compose -f docker-compose.prod.yml up -d chronicle
```

Do not substitute `exec` for the apply command; that would run alongside the
server's live SQLite connection. Preserve the reported automatic
`/data/chronicle-before-restore-*.db` backup and run `verify` after restart.

### Container release channels

`:edge` follows tested pushes to `main`; `:latest` is the newest stable release.
A signed, annotated source tag `vX.Y.Z` publishes container tags `X.Y.Z`, `X.Y`,
and `latest` without the source tag's leading `v`. Forgejo is the canonical
registry; the GitHub mirror performs validation only.

## Notes

- **Pin an OCI digest** (`image@sha256:...`) for reproducible deployment.
  Semver and `latest` tags remain mutable registry references.
- A production deployment using `AUTH_MODE=none` on a non-loopback bind fails
  closed unless `ALLOW_INSECURE_NO_AUTH=true` is explicit. This stack uses
  `AUTH_MODE=forward`, so that exception is neither needed nor recommended.
- Authelia's `access_control` default is `deny`; the shipped rule allows the two
  Chronicle hostnames with `one_factor`. Add 2FA by raising it to `two_factor`.
- See [BACKEND.md](./BACKEND.md) for the auth-mode matrix, sync protocol, and
  endpoint reference.
