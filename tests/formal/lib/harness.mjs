import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export { assert };

export async function eventually(check, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 100;
  const label = options.label ?? 'condition';
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${label}${suffix}`);
}

export async function runSuite(name, definitions) {
  const cases = [];
  const test = (title, fn) => cases.push({ title, fn });
  await definitions(test);
  const results = [];
  const started = Date.now();
  console.log(`TAP version 13\n# ${name}`);
  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    const caseStarted = Date.now();
    try {
      await item.fn();
      results.push({ name: item.title, status: 'passed', durationMs: Date.now() - caseStarted });
      console.log(`ok ${index + 1} - ${item.title}`);
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      results.push({
        name: item.title,
        status: 'failed',
        durationMs: Date.now() - caseStarted,
        error: message,
      });
      console.log(`not ok ${index + 1} - ${item.title}`);
      for (const line of message.split('\n')) console.log(`  # ${line}`);
    }
  }
  console.log(`1..${cases.length}`);
  const failed = results.filter((item) => item.status === 'failed').length;
  const report = {
    suite: name,
    image: process.env.CHRONICLE_IMAGE || 'compose-selected-image',
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    total: results.length,
    passed: results.length - failed,
    failed,
    results,
  };
  const reportDir = process.env.REPORT_DIR || path.resolve('artifacts');
  await fs.mkdir(reportDir, { recursive: true });
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  await fs.writeFile(path.join(reportDir, `report-${safeName}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`# ${report.passed}/${report.total} passed in ${report.durationMs}ms`);
  if (failed) process.exitCode = 1;
  return report;
}
