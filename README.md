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

## Quick start (Docker)

The published image is multi-arch (`linux/amd64` + `linux/arm64`), so it runs
on a normal x86 VPS or a Raspberry Pi. No clone, no build — just drop this into
a `docker-compose.yml`:

```yaml
services:
  chronicle:
    image: ghcr.io/vitadek/chronicle:latest
    container_name: chronicle
    restart: unless-stopped
    ports:
      - "3000:3000"           # -> http://localhost:3000
    volumes:
      - chronicle-data:/data  # manuscripts + SQLite DB live here
    environment:
      - AUTH_MODE=none        # single user, no login. Others: token | forward | oidc

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

Everything beyond the above is optional — see [`.env.example`](./.env.example)
for the other auth modes (bearer token / reverse-proxy forward-auth / OIDC), AI
provider keys, and Nextcloud redundancy, and add whichever you want under
`environment:`.

> **Deploying for real?** See **[DEPLOY.md](./DEPLOY.md)** for a full production
> stack — Caddy (automatic HTTPS) + Authelia forward-auth + Nextcloud hybrid
> storage — with ready-to-edit [`docker-compose.prod.yml`](./docker-compose.prod.yml)
> and [`.env.prod.example`](./.env.prod.example).

### Build from source instead

To build the image yourself (e.g. to hack on it), the repo's
`docker-compose.yml` uses `build: .`:

```bash
git clone https://github.com/Vitadek/chronicle.git
cd chronicle
docker compose up -d --build
```

## Features

- **Multi-manuscript library** — each book has its own metadata, chapter
  list, and cover art.
- **Last-write-wins sync** — write on your laptop, pick up on your phone.
  Per-chapter granularity, so two devices editing different chapters never
  step on each other. See [BACKEND.md](./BACKEND.md) for the protocol.
- **Standard Manuscript Format export** — Shunn-style .docx that agents
  expect. Per-chapter export too.
- **HTML and EPUB3 export** — single-file HTML for sharing, EPUB3 with
  cover image and copyright page for readers.
- **AI assistance (optional)** — review, outline, listen (TTS), and reader
  comments. Reviews never suggest changes — they describe.
- **Plot + Characters outline** — character sheets following the Local
  Script Man Character Map framework, and a simple drag-and-drop plot
  canvas with character lanes and events.
- **Optional Nextcloud integration** — OAuth login plus a write-behind
  WebDAV mirror that puts readable copies of your manuscripts in your
  Nextcloud.
- **Container-first** — one image, one volume, no external services
  required.

See [BACKEND.md](./BACKEND.md) for architecture, the sync protocol, and
deployment notes.
