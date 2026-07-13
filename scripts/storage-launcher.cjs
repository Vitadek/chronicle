const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const builtCli = path.join(root, 'dist', 'cli.cjs');

if (fs.existsSync(builtCli)) {
  require(builtCli);
} else {
  const sourceCli = path.join(root, 'server', 'cli.ts');
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', sourceCli, ...process.argv.slice(2)],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
