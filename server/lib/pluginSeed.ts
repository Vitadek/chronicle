import fs from 'fs';
import path from 'path';
import { PLUGINS_DIR, PLUGIN_ID_RE, writeMeta } from './pluginRepo';
import { buildPlugin, readManifest } from './pluginBuild';

/**
 * First-boot seeding.
 *
 * Any plugin whose source sits in `plugins-seed/` is copied into
 * DATA_DIR/plugins on boot and compiled, so an image can ship with plugins
 * already installed — no network, no git clone — while staying git-updatable
 * afterwards.
 *
 * The stock image seeds NOTHING: `plugins-seed/` is empty, every official
 * plugin lives in its own repo and is installed from the UI. This exists for
 * operators building a customised image (and for air-gapped installs), which
 * is why it survives even with no seeds to copy. See plugins-seed/README.md.
 *
 * Seeding never overwrites an existing install: once a plugin is on disk, the
 * user (and their git updates) own it.
 */

/** dist/ layout in the image; repo layout in dev. */
function seedDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'plugins-seed'),
    path.resolve(process.cwd(), 'dist', 'plugins-seed'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export async function seedPlugins(): Promise<void> {
  const seed = seedDir();
  if (!seed) return;

  fs.mkdirSync(PLUGINS_DIR, { recursive: true });

  for (const entry of fs.readdirSync(seed, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PLUGIN_ID_RE.test(entry.name)) continue;

    const src = path.join(seed, entry.name);
    let id: string;
    try {
      id = readManifest(src).id;
    } catch (err) {
      console.warn(`[plugins] skipping seed "${entry.name}": ${err instanceof Error ? err.message : err}`);
      continue;
    }

    const dest = path.join(PLUGINS_DIR, id);
    if (fs.existsSync(dest)) continue; // already installed — leave it alone

    try {
      fs.cpSync(src, dest, { recursive: true });
      writeMeta(dest, { source: 'seed', pinnedRef: null });
      const built = await buildPlugin(id);
      if (built.ok === false) {
        console.warn(`[plugins] seeded "${id}" but the build failed: ${built.error}`);
      } else {
        console.log(`[plugins] seeded "${id}"`);
      }
    } catch (err) {
      console.error(`[plugins] failed to seed "${id}":`, err);
    }
  }
}
