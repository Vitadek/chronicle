const phase = process.argv[2] || 'foundation';
const modules = {
  foundation: './foundation.mjs',
  outage: './outage.mjs',
  recovery: './recovery.mjs',
  durability: './durability.mjs',
  pre_restore: './pre-restore.mjs',
  post_restore: './post-restore.mjs',
};

if (!modules[phase]) throw new Error(`Unknown formal test phase: ${phase}`);
const { run } = await import(modules[phase]);
await run();

// WebSocket/AWS connection pools may retain idle keep-alive handles. Reports
// are already flushed at this point, so make each one-shot runner phase exit
// deterministically with its accumulated test status.
process.exit(process.exitCode || 0);
