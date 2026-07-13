import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const image = process.env.CHRONICLE_IMAGE;
const reportDir = process.env.REPORT_DIR || path.resolve('tests/formal/artifacts');
if (!image) throw new Error('CHRONICLE_IMAGE is required');

const cases = [
  {
    name: 'production no-auth on a public bind fails closed',
    environment: { NODE_ENV: 'production', AUTH_MODE: 'none', HOST: '0.0.0.0' },
    expected: /ALLOW_INSECURE_NO_AUTH/,
  },
  {
    name: 'token mode without a token fails closed',
    environment: { NODE_ENV: 'production', AUTH_MODE: 'token', HOST: '0.0.0.0' },
    expected: /requires AUTH_TOKEN/,
  },
  {
    name: 'OIDC mode without provider configuration fails closed',
    environment: { NODE_ENV: 'production', AUTH_MODE: 'oidc', HOST: '0.0.0.0' },
    expected: /AUTH_MODE=oidc requires/,
  },
  {
    name: 'an insecure S3 endpoint without the LAN override fails closed',
    environment: {
      NODE_ENV: 'production',
      AUTH_MODE: 'token',
      AUTH_TOKEN: 'formal-preflight-token',
      STORAGE_REPLICA: 's3',
      S3_BUCKET: 'formal',
      S3_ENDPOINT: 'http://minio:9000',
    },
    expected: /S3_ENDPOINT must use HTTPS/,
  },
  {
    name: 'the retired Nextcloud mirror path fails closed',
    environment: {
      NODE_ENV: 'production',
      AUTH_MODE: 'token',
      AUTH_TOKEN: 'formal-preflight-token',
      NEXTCLOUD_MIRROR: 'true',
    },
    expected: /NEXTCLOUD_MIRROR.*retired/i,
  },
];

fs.mkdirSync(reportDir, { recursive: true });
const results = [];
const runNonce = (process.env.COMPOSE_PROJECT_NAME || `pid-${process.pid}-${Date.now()}`)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40) || `pid-${process.pid}`;
console.log('TAP version 13\n# formal-fail-closed-preflight');

for (let index = 0; index < cases.length; index += 1) {
  const item = cases[index];
  const containerName = `chronicle-preflight-${runNonce}-${index + 1}`;
  const args = [
    'run',
    '--name', containerName,
    '--network', 'none',
    '--tmpfs', '/data:rw,noexec,nosuid,size=64m,mode=1777',
  ];
  for (const [key, value] of Object.entries(item.environment)) {
    args.push('--env', `${key}=${value}`);
  }
  args.push(image);
  const started = Date.now();
  let child = { stdout: '', stderr: '', status: null, signal: null, error: null };
  try {
    child = spawnSync('docker', args, {
      encoding: 'utf8',
      timeout: 15_000,
      killSignal: 'SIGKILL',
      maxBuffer: 2 * 1024 * 1024,
    });
  } finally {
    spawnSync('docker', ['rm', '--force', '--volumes', containerName], {
      encoding: 'utf8',
      timeout: 10_000,
    });
  }
  const output = `${child.stdout || ''}${child.stderr || ''}`;
  const passed = Number.isInteger(child.status) && child.status > 0 &&
    !child.signal && !child.error && item.expected.test(output);
  const result = {
    name: item.name,
    status: passed ? 'passed' : 'failed',
    durationMs: Date.now() - started,
    exitStatus: child.status,
    ...(passed ? {} : { error: child.error?.message || output.slice(-4_000) }),
  };
  results.push(result);
  fs.writeFileSync(
    path.join(reportDir, `preflight-${index + 1}.log`),
    output,
    { mode: 0o600 },
  );
  console.log(`${passed ? 'ok' : 'not ok'} ${index + 1} - ${item.name}`);
}

console.log(`1..${cases.length}`);
const failed = results.filter((item) => item.status === 'failed').length;
const report = {
  suite: 'formal-fail-closed-preflight',
  image,
  total: results.length,
  passed: results.length - failed,
  failed,
  results,
};
fs.writeFileSync(
  path.join(reportDir, 'report-formal-fail-closed-preflight.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(`# ${report.passed}/${report.total} passed`);
if (failed) process.exitCode = 1;
