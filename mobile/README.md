# Chronicle — Android app

A native-feeling Android client for Chronicle. The shell (library, chapters,
toolbar, settings) is native Flutter for a tactile feel; the actual editing
surface is the **slim TipTap bundle** (`../editor-host/`) hosted in a WebView and
driven over a JS bridge. The app talks to the existing Chronicle server as a
plain REST API — it is not a wrapper around the bulky web client.

## Architecture

```
Native Flutter UI ──http (Bearer token)──► Chronicle API (/api/manuscripts, …)
        │
        └─JS bridge (window.chronicleEditor)─► WebView ◄─ slim editor bundle
                                                          (assets/editor/, served
                                                           locally, no network)
```

- **Auth:** the server's built-in `AUTH_MODE=token` (static bearer). The app
  stores a server URL + token in the platform keystore (`flutter_secure_storage`)
  — no login flow. Point it at an `/api` endpoint that isn't behind an
  interactive Authelia redirect; HTTPS via Caddy is the transport security.
- **Editor bundle:** built from the repo root with `npm run build:editor` into
  `assets/editor/` and served by `InAppLocalhostServer`. It reuses
  `src/lib/editorExtensions.ts`, so it shares the web editor's smart-quote /
  keyboard behavior exactly.

## Build (Docker — no host SDK needed)

From the repo root:

```bash
./scripts/build-apk.sh
# → build-apk/app-arm64-v8a-release.apk  (sideload this on a modern phone)
```

This runs `apk.Dockerfile`: stage 1 (Node) builds the editor bundle, stage 2
(Flutter + Android SDK) builds the APK. CI (`.github/workflows/android.yml`) uses
the same Dockerfile on a `v*` tag and attaches the APKs to the GitHub Release.

> M0 ships a **debug-signed release** APK (installable for personal sideload).
> Real release signing with a keystore is a later pass (`build.gradle.kts`
> `signingConfigs` + GitHub secrets).

## Local dev (optional, needs the Flutter SDK)

```bash
npm run build:editor          # from repo root, regenerates mobile/assets/editor/
cd mobile && flutter run       # against an emulator/device
```

In the app's setup screen, enter the server URL and the `AUTH_TOKEN`. For an
emulator hitting a server on the host machine, use `http://10.0.2.2:3000`.

## Bridge contract (`window.chronicleEditor`)

`setContent(html)` · `getContent()` · `focus()` · `setTheme('light'|'dark')` ·
`command(name, payload?)` where `name` ∈ `toggleBold`, `toggleItalic`,
`toggleUnderline`, `setHeading({level})`, `insertSceneBreak`, `setEpigraph`,
`toggleComment({comment})`, `undo`, `redo`. Events back to Flutter: `onReady`,
`onUpdate({html, words})`, `onSelection({marks, blockType})`.

## Status

**M0 (walking skeleton):** setup → library → chapters → editor → save, with a
native formatting toolbar + haptics. Next: live word count + toolbar active
states (`onUpdate`/`onSelection`), offline `/api/sync` cache, comments/AI sheets,
and release signing. See `../.claude/plans/` for the full plan.
