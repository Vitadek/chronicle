# plugins-seed/

Plugins dropped in this directory are **copied into `DATA_DIR/plugins` and compiled on first
boot** — a fresh or air-gapped install comes up with them already present, no network and no
git clone required. They stay git-updatable afterwards, and seeding never overwrites a plugin
that is already installed: once it's on disk, the user owns it.

**It is empty on purpose.** Chronicle ships no plugins in the base image. Every official plugin
(including the Chibi Assistant, which used to be seeded from here) lives in its own git repo and
is installed from the UI — see `PLUGINS.md`.

This is the hook for building a *customised* image: fork the Dockerfile, copy a plugin's source
into `plugins-seed/<name>/`, and every container from that image starts with it installed.

    plugins-seed/
      my-plugin/
        chronicle-plugin.json
        src/index.tsx

The directory name only needs to match `[a-z0-9][a-z0-9._-]*`; the plugin's real id comes from
the manifest. Anything without a readable `chronicle-plugin.json` is skipped with a warning
(see `server/lib/pluginSeed.ts`).
