import fs from 'fs';
import path from 'path';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import { config } from '../config';

/**
 * Git operations for plugins.
 *
 * Uses isomorphic-git (pure JS) rather than shelling out to the `git` binary:
 * no git in the image, and — more importantly — no shell, so a hostile repo URL
 * can never become command injection.
 *
 * Every plugin lives at DATA_DIR/plugins/<id>, where <id> is validated against
 * PLUGIN_ID_RE before it ever reaches path.join (v1's DELETE took the id
 * straight from the URL and was traversal-capable).
 */

export const PLUGINS_DIR = path.join(config.dataDir, 'plugins');
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function pluginDir(id: string): string {
  if (!PLUGIN_ID_RE.test(id)) throw new Error(`Invalid plugin id: ${id}`);
  const dir = path.join(PLUGINS_DIR, id);
  // Belt and braces: the resolved path must stay inside PLUGINS_DIR.
  const resolved = path.resolve(dir);
  if (resolved !== path.resolve(PLUGINS_DIR, id) || !resolved.startsWith(path.resolve(PLUGINS_DIR) + path.sep)) {
    throw new Error(`Invalid plugin id: ${id}`);
  }
  return dir;
}

export interface RepoStatus {
  /** Short commit currently checked out. */
  commit?: string;
  gitUrl?: string;
  pinnedRef?: string | null;
}

/** Sidecar metadata we own (isomorphic-git doesn't track "pinned"). */
interface RepoMeta {
  gitUrl?: string;
  pinnedRef?: string | null;
  source: 'seed' | 'git' | 'local';
}

const metaPath = (dir: string) => path.join(dir, '.chronicle-meta.json');

export function readMeta(dir: string): RepoMeta {
  try {
    return JSON.parse(fs.readFileSync(metaPath(dir), 'utf8')) as RepoMeta;
  } catch {
    return { source: 'local' };
  }
}

export function writeMeta(dir: string, meta: RepoMeta): void {
  fs.writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2));
}

export async function currentCommit(dir: string): Promise<string | undefined> {
  const full = await currentCommitFull(dir);
  return full?.slice(0, 7);
}

export async function currentCommitFull(dir: string): Promise<string | undefined> {
  try {
    return await git.resolveRef({ fs, dir, ref: 'HEAD' });
  } catch {
    return undefined; // not a git repo (seed/local install)
  }
}

/** Clone a plugin repo. Rejects if the target already exists. */
export async function cloneRepo(id: string, url: string): Promise<void> {
  const dir = pluginDir(id);
  if (fs.existsSync(dir)) throw new Error(`Plugin "${id}" is already installed.`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    await git.clone({ fs, http, dir, url, singleBranch: true, depth: 50 });
    writeMeta(dir, { gitUrl: url, pinnedRef: null, source: 'git' });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true }); // don't leave a half-clone
    throw err;
  }
}

export interface IncomingCommit {
  oid: string;
  message: string;
}

/**
 * Fetch from the remote and report commits we don't have yet. Does NOT modify
 * the working tree — the user decides whether to pull.
 */
export async function checkForUpdates(id: string): Promise<{ updateAvailable: boolean; incoming: IncomingCommit[] }> {
  const dir = pluginDir(id);
  const meta = readMeta(dir);
  if (meta.source !== 'git') return { updateAvailable: false, incoming: [] };
  if (meta.pinnedRef) return { updateAvailable: false, incoming: [] }; // pinned: never offer

  await git.fetch({ fs, http, dir, singleBranch: true, depth: 50 });

  const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
  const branch = (await git.currentBranch({ fs, dir })) || 'main';
  let remote: string;
  try {
    remote = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${branch}` });
  } catch {
    return { updateAvailable: false, incoming: [] };
  }
  if (remote === head) return { updateAvailable: false, incoming: [] };

  // Commits on the remote we haven't got — newest first, capped for the UI.
  const log = await git.log({ fs, dir, ref: `refs/remotes/origin/${branch}`, depth: 20 });
  const incoming: IncomingCommit[] = [];
  for (const c of log) {
    if (c.oid === head) break;
    incoming.push({ oid: c.oid.slice(0, 7), message: c.commit.message.split('\n')[0] });
  }
  return { updateAvailable: incoming.length > 0, incoming };
}

/** Fast-forward the working tree to the remote head (or to the pinned ref). */
export async function pullRepo(id: string): Promise<void> {
  const dir = pluginDir(id);
  const meta = readMeta(dir);
  if (meta.source !== 'git') throw new Error('This plugin is not a git install.');

  // A pinned plugin is frozen at the commit it was pinned to — that is the
  // whole point of pinning, so there is nothing to pull.
  if (meta.pinnedRef) return;

  await git.fetch({ fs, http, dir, singleBranch: true, depth: 50 });

  // `fetch` only advances refs/remotes/origin/*; the LOCAL branch still points
  // at the old commit, so checking it out would be a no-op (this silently made
  // "Update" do nothing). Fast-forward the local branch to what we fetched,
  // then check it out.
  const branch = (await git.currentBranch({ fs, dir })) || 'main';
  const remoteOid = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${branch}` });
  await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: remoteOid, force: true });
  // A hard checkout, not a merge: plugin dirs are ours to manage, and a
  // conflicted merge in a plugin working tree would be unrecoverable from the UI.
  await git.checkout({ fs, dir, ref: branch, force: true });
}

/**
 * Pin to a commit or tag (updates stop being offered), or unpin with null.
 *
 * Pinning to the commit we're already on — what the Settings button does — must
 * not try to check anything out: isomorphic-git's `checkout` resolves `ref`
 * against branches/remotes, so handing it a bare SHA fails with
 * "Could not find origin/<sha>". We only check out when moving to a DIFFERENT
 * ref (e.g. a tag).
 */
export async function pinRepo(id: string, ref: string | null): Promise<void> {
  const dir = pluginDir(id);
  const meta = readMeta(dir);

  if (!ref) {
    writeMeta(dir, { ...meta, pinnedRef: null });
    return;
  }

  const headFull = await currentCommitFull(dir);
  const isCurrentCommit = !!headFull && (headFull === ref || headFull.startsWith(ref));

  if (isCurrentCommit) {
    // Already here: freeze in place, recording the full oid.
    writeMeta(dir, { ...meta, pinnedRef: headFull });
    return;
  }

  // A tag or branch: move to it, then freeze.
  await git.checkout({ fs, dir, ref, force: true }); // throws on an unknown ref
  writeMeta(dir, { ...meta, pinnedRef: ref });
}

export function removePlugin(id: string): void {
  fs.rmSync(pluginDir(id), { recursive: true, force: true });
}
