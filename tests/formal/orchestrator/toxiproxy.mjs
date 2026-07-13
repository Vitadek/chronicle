const base = process.env.TOXIPROXY_URL || 'http://toxiproxy:8474';
const action = process.argv[2] || 'status';

async function eventually(work, timeoutMs = 20_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      return await work();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw last || new Error('Toxiproxy timed out');
}

async function json(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const body = await response.text();
  if (!response.ok) throw new Error(`Toxiproxy ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

if (action === 'create') {
  await eventually(async () => {
    const response = await fetch(`${base}/version`);
    if (!response.ok) throw new Error('Toxiproxy is not ready');
  });
  const existing = await json('/proxies');
  if (!existing['minio-s3']) {
    await json('/proxies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'minio-s3',
        listen: '0.0.0.0:8666',
        upstream: 'minio:9000',
        enabled: true,
      }),
    });
  }
  console.log('Toxiproxy MinIO proxy ready');
} else if (action === 'enable' || action === 'disable') {
  const enabled = action === 'enable';
  const proxy = await json('/proxies/minio-s3', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (proxy.enabled !== enabled) throw new Error(`Failed to ${action} MinIO proxy`);
  console.log(`Toxiproxy MinIO proxy ${action}d`);
} else if (action === 'status') {
  console.log(JSON.stringify(await json('/proxies/minio-s3'), null, 2));
} else {
  throw new Error(`Unknown action: ${action}`);
}
