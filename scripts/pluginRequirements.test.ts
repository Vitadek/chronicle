/**
 * Prerequisites must be DISCOVERABLE, not deducible.
 *
 * A plugin can clone, compile and install perfectly and still be unable to run:
 * the Proofreader needs the LanguageTool sidecar answering. Before this test,
 * the only signal was a terse "Needs the LanguageTool sidecar." on the card,
 * while the actionable half of the message — which URL was probed, which env
 * var to set — existed server-side and was UNREACHABLE, because it only rode on
 * the enable 409 and Settings (rightly) disables Enable on a blocked plugin.
 *
 * This drives the real routes, with LanguageTool deliberately down, and pins:
 *   · installing succeeds (a missing prereq is not an install failure)
 *   · the install response says it can't be enabled, and WHY, in the same
 *     breath — that's the "message-check at install" the UI renders
 *   · the plugin list carries the same reasons, for the card
 *   · a plugin with no requirements is left alone (no phantom warnings)
 *
 * Run: npx tsx scripts/pluginRequirements.test.ts
 */
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// Isolated data dir, and a LanguageTool that is definitively NOT there (port 9
// = discard; connection refused immediately, so the probe fails fast).
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-req-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.LANGUAGETOOL_URL = 'http://127.0.0.1:9';
process.env.AUTH_MODE = 'none';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A minimal plugin on disk, for installing by path. */
function makePlugin(id: string, requires: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `plugin-${id}-`));
  fs.writeFileSync(
    path.join(dir, 'chronicle-plugin.json'),
    JSON.stringify({
      id,
      name: id === 'test.needslt' ? 'Needs LanguageTool' : 'Needs Nothing',
      description: 'Fixture.',
      version: '1.0.0',
      entry: 'src/index.tsx',
      minAppVersion: '0.1.0',
      ...(requires.length ? { requires } : {}),
    }),
  );
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(
    path.join(dir, 'src', 'index.tsx'),
    `import { definePlugin, PLUGIN_API_VERSION } from '@chronicle/plugin-api';
     export default definePlugin({ apiVersion: PLUGIN_API_VERSION, id: '${id}', name: '${id}', description: 'Fixture.' });`,
  );
  return dir;
}

interface InstallResponse {
  plugin: { id: string; name: string };
  missing: string[];
  missingReasons: string[];
}

async function main() {
  const { default: pluginsRouter } = await import('../server/routes/plugins');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = 'local';
    next();
  });
  app.use('/api/plugins', pluginsRouter);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}/api/plugins`;

  const install = async (dir: string) => {
    const res = await fetch(`${base}/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
    return { status: res.status, body: (await res.json()) as InstallResponse & { error?: string } };
  };

  // ── A plugin that needs LanguageTool, installed while LanguageTool is down ──
  const needsLt = await install(makePlugin('test.needslt', ['host:languagetool']));

  check('installing succeeds — a missing prereq is not a build failure', needsLt.status === 200, JSON.stringify(needsLt.body).slice(0, 160));
  check('the install response says it cannot be enabled', needsLt.body.missing?.includes('host:languagetool'), JSON.stringify(needsLt.body.missing));
  check('…and says WHY, in the same response', (needsLt.body.missingReasons ?? []).length === 1);

  const reason = needsLt.body.missingReasons?.[0] ?? '';
  check('the reason names the URL that was probed', reason.includes('127.0.0.1:9'), reason);
  check('the reason says what to do about it', /sidecar|LANGUAGETOOL_URL/.test(reason), reason);

  // ── The same reasons must reach the plugin CARD, not just the install box ──
  const listed = (await (await fetch(base)).json()) as {
    plugins: { id: string; status: { missing: string[] }; missingReasons: string[] }[];
    hostCapabilities: string[];
  };
  const lt = listed.plugins.find((p) => p.id === 'test.needslt');

  check('LanguageTool is not reported as available', !listed.hostCapabilities.includes('host:languagetool'));
  check('the list marks the plugin blocked', lt?.status.missing.includes('host:languagetool') === true);
  check('the list carries the actionable reason for the card', (lt?.missingReasons?.[0] ?? '').includes('LANGUAGETOOL_URL'), lt?.missingReasons?.[0]);

  // ── Enabling it is refused, with the same wording (no second vocabulary) ────
  const enable = await fetch(`${base}/test.needslt/enabled`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  const enableBody = (await enable.json()) as { error?: string };
  check('enabling is refused with 409', enable.status === 409);
  check('the refusal carries the same explanation', (enableBody.error ?? '').includes('LANGUAGETOOL_URL'), enableBody.error);

  // ── A plugin with no requirements gets no phantom warnings ──────────────────
  const needsNothing = await install(makePlugin('test.needsnothing', []));
  check('an unencumbered plugin installs clean', needsNothing.status === 200);
  check('…with no missing requirements', (needsNothing.body.missing ?? []).length === 0);
  check('…and no reasons to show', (needsNothing.body.missingReasons ?? []).length === 0);

  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} plugin-requirement check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll plugin-requirement checks passed.');
}

void main();
