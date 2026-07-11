# Production deployment

A real, hardened setup: **Chronicle behind [Caddy](https://caddyserver.com)
(automatic HTTPS) with [Authelia](https://www.authelia.com) forward-auth and
[Nextcloud](https://nextcloud.com) hybrid storage.** This is the same shape as a
working single-VPS install; adjust names to taste.

```
                internet
                   │  :80 / :443
              ┌────▼─────┐   forward_auth (/api/verify)   ┌───────────┐
              │  Caddy   │ ───────────────────────────────▶│ Authelia  │
              │ (TLS/LE) │◀── Remote-User / Remote-Email ──│  (IdP)    │
              └────┬─────┘                                 └───────────┘
                   │ reverse_proxy chronicle:3000
              ┌────▼──────┐   background mirror   ┌─────────────────────┐
              │ Chronicle │ ─────────────────────▶│ Nextcloud (WebDAV)  │
              │  :3000    │      LanguageTool      └─────────────────────┘
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

## 6. Nextcloud hybrid storage

`docker-compose.prod.yml` sets `STORAGE_PROVIDER=hybrid`, so Chronicle keeps the
fast local SQLite copy **and** mirrors manuscripts (plus large blobs like covers)
to Nextcloud under `NC_DIR`. Nothing to install on the Nextcloud side beyond the
app password from step 3 — first write creates `Chronicle_Storage/`.

Prefer everything local? Set `STORAGE_PROVIDER=sqlite` and drop the `NC_*` vars.

## 7. Launch

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f chronicle   # watch first boot
```

Open `https://chronicle.example.com` — you'll be bounced to Authelia to log in,
then land in your Library. On boot Chronicle probes any configured AI keys and
logs OK/INVALID for each.

## 8. Updates & backups

```bash
# update to the latest published image
docker compose -f docker-compose.prod.yml pull && \
docker compose -f docker-compose.prod.yml up -d

# hot backup of the SQLite DB (WAL-safe)
docker compose -f docker-compose.prod.yml exec chronicle \
  sqlite3 /data/chronicle.db ".backup /data/chronicle.db.bak"
```

With hybrid storage your manuscripts are also continuously mirrored to Nextcloud,
so the SQLite DB isn't your only copy.

## Notes

- **Pin image tags** for reproducibility (e.g. a release tag instead of
  `:latest`) once you settle on a version.
- Authelia's `access_control` default is `deny`; the shipped rule allows the two
  Chronicle hostnames with `one_factor`. Add 2FA by raising it to `two_factor`.
- See [BACKEND.md](./BACKEND.md) for the auth-mode matrix, sync protocol, and
  endpoint reference.
