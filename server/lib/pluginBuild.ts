import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as esbuild from 'esbuild';
import { z } from 'zod';
import { PLUGIN_ID_RE, pluginDir, readMeta, currentCommit } from './pluginRepo';
import { CORE_CAPABILITIES, type PluginDeps } from './pluginResolve';

const execFileAsync = promisify(execFile);

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

/** A capability string: `host:x`, `core:x`, a plugin id, or a free tag. */
const Capability = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._:-]*$/i, 'invalid capability string');
const CapabilityList = z.array(Capability).max(20).default([]);

export const ManifestSchema = z.object({
  id: z.string().regex(PLUGIN_ID_RE, 'id must be alphanumeric with . _ -'),
  name: z.string().min(1).max(80),
  description: z.string().max(400).default(''),
  version: z.string().max(40).default('0.0.0'),
  /** Entry source file, relative to the plugin root. */
  entry: z.string().min(1).max(200),
  /** Minimum Chronicle version this plugin supports. */
  minAppVersion: z.string().max(40).optional(),

  // --- the dependency system (see lib/pluginResolve.ts) ---
  /** Capability tags this plugin offers. Its id is provided implicitly. */
  provides: CapabilityList,
  /** Hard: the plugin cannot be enabled unless every one of these is provided. */
  requires: CapabilityList,
  /** Soft: the plugin enables anyway, but is flagged "limited" in Settings. */
  wants: CapabilityList,
  /** Cannot be enabled alongside a provider of these (e.g. a 2nd grammar checker). */
  conflicts: CapabilityList,
  /**
   * Built-in features this plugin supersedes. While it is enabled the host stops
   * registering them — see the shadowing note in pluginResolve.ts. Restricted to
   * the known `core:*` set so a typo is an error here, not a silent no-shadow at
   * runtime.
   */
  replaces: z
    .array(z.enum(CORE_CAPABILITIES))
    .max(CORE_CAPABILITIES.length)
    .default([]),
  /**
   * npm packages to install at build time. Everything Chronicle itself ships is
   * already importable without declaring it (see nodePaths below); this is for
   * anything else.
   */
  dependencies: z
    .record(z.string().max(120), z.string().max(60))
    .default({})
    .refine((d) => Object.keys(d).length <= 30, 'at most 30 dependencies'),
});
export type PluginManifest = z.infer<typeof ManifestSchema>;

export const MANIFEST_FILE = 'chronicle-plugin.json';
const BUILD_DIR = '.chronicle-build';
const OUT_FILE = path.join(BUILD_DIR, 'plugin.js');
const ERR_FILE = path.join(BUILD_DIR, 'error.txt');
const DEPS_HASH_FILE = path.join(BUILD_DIR, 'deps.hash');

/** npm install can hang on a bad registry; don't wedge the request forever. */
const NPM_TIMEOUT_MS = 120_000;

/**
 * Install a plugin's declared npm dependencies.
 *
 * Everything lands in `.chronicle-build/` rather than the repo root, because
 * pullRepo() does a `git.checkout({ force: true })` — a package.json we
 * synthesized at the root would fight the repo's own tree on every update.
 * esbuild picks it up via nodePaths.
 *
 * `--ignore-scripts` keeps a package's postinstall from executing as the server
 * user. This is NOT a security boundary — plugin code already runs with full
 * privileges in the browser, that's the documented trust model — it just keeps
 * install-time code execution off the host, which is a strictly different (and
 * unnecessary) thing to hand out.
 */
async function installDependencies(
  dir: string,
  id: string,
  dependencies: Record<string, string>,
): Promise<void> {
  const buildDir = path.join(dir, BUILD_DIR);
  const hashFile = path.join(dir, DEPS_HASH_FILE);
  const modules = path.join(buildDir, 'node_modules');

  if (!Object.keys(dependencies).length) {
    // Declared none: make sure a previously-installed tree can't linger and
    // keep satisfying an import the manifest no longer asks for.
    fs.rmSync(modules, { recursive: true, force: true });
    fs.rmSync(hashFile, { force: true });
    return;
  }

  const hash = crypto.createHash('sha256').update(JSON.stringify(dependencies)).digest('hex');
  const cached = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, 'utf8') : '';
  if (cached === hash && fs.existsSync(modules)) return; // unchanged — don't reinstall on every rebuild/pin

  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(
    path.join(buildDir, 'package.json'),
    JSON.stringify({ name: `chronicle-plugin-${id}`, version: '0.0.0', private: true, dependencies }, null, 2),
  );

  try {
    await execFileAsync(
      'npm',
      ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
      { cwd: buildDir, timeout: NPM_TIMEOUT_MS },
    );
  } catch (err) {
    fs.rmSync(hashFile, { force: true }); // a failed install must not look cached
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr || e.message || 'npm install failed').trim();
    throw new Error(
      `Installing dependencies failed.\n${detail}\n\n` +
      `(Chronicle's own dependencies are importable without declaring them — ` +
      `only list packages the app doesn't already ship.)`,
    );
  }

  fs.writeFileSync(hashFile, hash);
}

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

    await installDependencies(dir, manifest.id, manifest.dependencies);

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
      // Resolution order matters:
      //  1. the plugin's own declared deps (manifest `dependencies`, installed
      //     above into .chronicle-build/node_modules) — these win;
      //  2. Chronicle's own dependencies, which act as the plugin STANDARD
      //     LIBRARY: anything the app already ships (compromise, jszip, docx, …)
      //     can just be imported, with nothing to declare and no install.
      // Either way the package is BUNDLED into the plugin. Only the libraries the
      // host shares at runtime stay external (SHARED_EXTERNALS, above), so a
      // plugin never gets a second React.
      nodePaths: [
        path.join(dir, BUILD_DIR, 'node_modules'),
        path.join(process.cwd(), 'node_modules'),
      ],
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

export interface DiskPlugin extends PluginDeps {
  id: string;
  name: string;
  description: string;
  version: string;
  source: 'seed' | 'git' | 'local';
  gitUrl?: string;
  commit?: string;
  pinnedRef?: string | null;
  buildError: string | null;
  /** npm packages this plugin declared (informational, for Settings). */
  dependencies: Record<string, string>;
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
    // A plugin whose manifest won't parse declares nothing — resolve() also
    // treats a buildError as "provides nothing", so it can't satisfy anyone.
    provides: manifest?.provides ?? [],
    requires: manifest?.requires ?? [],
    wants: manifest?.wants ?? [],
    conflicts: manifest?.conflicts ?? [],
    replaces: manifest?.replaces ?? [],
    dependencies: manifest?.dependencies ?? {},
  };
}
