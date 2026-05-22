# Chronicle

A minimal, distraction-free writing app for novelists. TipTap-based editor,
multi-manuscript library, optional AI assistance, and a small sync backend
so your work travels between devices.

## Quick start (local dev)

```bash
npm install
cp .env.example .env
npm run dev
```

Open <http://localhost:3000>. Data is written to `./data/chronicle.db`.

## Quick start (Docker)

```bash
docker compose up -d
```

Persists to a named volume (`chronicle-data`). Add the env vars you want
from `.env.example` to `docker-compose.yml`.

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
