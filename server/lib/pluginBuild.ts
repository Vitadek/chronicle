import fs from 'fs';
import path from 'path';
import * as esbuild from 'esbuild';
import { z } from 'zod';
import { PLUGIN_ID_RE, pluginDir, readMeta, currentCommit } from './pluginRepo';

/**
 * Compiles a plugin's TypeScript/TSX source into something the browser can run.
 *
 * Plugin authors write plain TS/TSX and push it — no build tooling of their own.
 * The server is the single, consistent build environment.
 *
 * The output format is deliberate: **CommonJS with the app's own libraries left
 * external**. The client then evaluates it with a `require` shim bound to the
 * running app's React/TipTap instances (see src/plugins/host/loader.ts). If we
 * bundled React into the plugin instead, the app would have two Reacts and
 * hooks would crash on the first render.
 */

/** Everything the host provides at runtime — must match HOST_MODULES in loader.ts. */
export const SHARED_EXTERNALS = [
  'react',
  // With jsx:'automatic', esbuild emits require("react/jsx-runtime") for EVERY
  // JSX file — so this must be external and host-provided too, or no plugin
  // that renders anything can load.
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  '@tiptap/core',
  '@tiptap/react',
  '@tiptap/react/menus',
  '@tiptap/pm/state',
  '@tiptap/pm/view',
  '@tiptap/pm/model',
  'motion/react',
  'lucide-react',
  '@chronicle/plugin-api',
];

export const ManifestSchema = z.object({
  id: z.string().regex(PLUGIN_ID_RE, 'id must be alphanumeric with . _ -'),
  name: z.string().min(1).max(80),
  description: z.string().max(400).default(''),
  version: z.string().max(40).default('0.0.0'),
  /** Entry source file, relative to the plugin root. */
  entry: z.string().min(1).max(200),
  /** Minimum Chronicle version this plugin supports. */
  minAppVersion: z.string().max(40).optional(),
});
export type PluginManifest = z.infer<typeof ManifestSchema>;

export const MANIFEST_FILE = 'chronicle-plugin.json';
const OUT_FILE = path.join('.chronicle-build', 'plugin.js');
const ERR_FILE = path.join('.chronicle-build', 'error.txt');

export function readManifest(dir: string): PluginManifest {
  const file = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${MANIFEST_FILE} in the plugin repo root.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${MANIFEST_FILE} is not valid JSON.`);
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${MANIFEST_FILE}: ${issue.path.join('.')} — ${issue.message}`);
  }
  return parsed.data;
}

export const builtModulePath = (id: string) => path.join(pluginDir(id), OUT_FILE);
export const buildErrorPath = (id: string) => path.join(pluginDir(id), ERR_FILE);

export function readBuildError(id: string): string | null {
  try {
    return fs.readFileSync(buildErrorPath(id), 'utf8') || null;
  } catch {
    return null;
  }
}

/**
 * Build one plugin. Errors are captured to disk (and returned) rather than
 * thrown at boot, so one broken plugin can't stop the server from starting —
 * Settings shows the compile error instead.
 */
export async function buildPlugin(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const dir = pluginDir(id);
  const outfile = path.join(dir, OUT_FILE);
  const errfile = path.join(dir, ERR_FILE);
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  fs.rmSync(errfile, { force: true });

  try {
    const manifest = readManifest(dir);

    // The entry must resolve inside the plugin dir — a manifest can't reach out
    // with "../../../etc/passwd".
    const entry = path.resolve(dir, manifest.entry);
    if (!entry.startsWith(path.resolve(dir) + path.sep)) {
      throw new Error(`entry "${manifest.entry}" escapes the plugin directory.`);
    }
    if (!fs.existsSync(entry)) {
      throw new Error(`entry "${manifest.entry}" does not exist in the repo.`);
    }

    await esbuild.build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'cjs',
      platform: 'browser',
      target: 'es2020',
      jsx: 'automatic',
      minify: true,
      sourcemap: false,
      external: SHARED_EXTERNALS,
      logLevel: 'silent',
      absWorkingDir: dir,
      // Plugin repos have no node_modules (there is no install step — the whole
      // point). Let them resolve against Chronicle's own dependencies, which
      // become the plugin "standard library": anything the app already ships
      // (compromise, jszip, docx, …) can simply be imported and is BUNDLED into
      // the plugin. Libraries the app shares at runtime stay external (above);
      // everything else is inlined, so the plugin remains self-contained.
      nodePaths: [path.join(process.cwd(), 'node_modules')],
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fs.rmSync(outfile, { force: true }); // never serve a stale bundle after a failed build
    try {
      fs.writeFileSync(errfile, message);
    } catch {
      /* best effort */
    }
    return { ok: false, error: message };
  }
}

export interface DiskPlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  source: 'seed' | 'git' | 'local';
  gitUrl?: string;
  commit?: string;
  pinnedRef?: string | null;
  buildError: string | null;
}

/** Read one installed plugin's manifest + git/build status. */
export async function describePlugin(id: string): Promise<DiskPlugin | null> {
  const dir = pluginDir(id);
  if (!fs.existsSync(dir)) return null;
  const meta = readMeta(dir);
  let manifest: PluginManifest | null = null;
  let manifestError: string | null = null;
  try {
    manifest = readManifest(dir);
  } catch (err) {
    manifestError = err instanceof Error ? err.message : String(err);
  }
  return {
    id,
    name: manifest?.name ?? id,
    description: manifest?.description ?? '',
    version: manifest?.version ?? '0.0.0',
    source: meta.source,
    gitUrl: meta.gitUrl,
    commit: await currentCommit(dir),
    pinnedRef: meta.pinnedRef ?? null,
    buildError: manifestError ?? readBuildError(id),
  };
}
