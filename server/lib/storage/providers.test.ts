import assert from 'node:assert/strict';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { config } from '../../config';
import { NextcloudProvider } from './NextcloudProvider';
import { S3Provider } from './S3Provider';

async function testS3(): Promise<void> {
  config.s3.bucket = 'books';
  config.s3.prefix = 'chronicle';
  config.s3.endpoint = '';
  const provider = new S3Provider();
  const commands: unknown[] = [];
  let listPage = 0;
  const client = {
    send: async (command: unknown) => {
      commands.push(command);
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: 3,
          ContentType: 'text/plain',
          Metadata: {
            'chronicle-checksum': 'abc',
            'chronicle-generation': '7',
          },
        };
      }
      if (command instanceof GetObjectCommand) {
        return {
          Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
        };
      }
      if (command instanceof ListObjectsV2Command) {
        listPage += 1;
        return listPage === 1
          ? {
              Contents: [{ Key: 'chronicle/v1/a', Size: 1 }],
              IsTruncated: true,
              NextContinuationToken: 'next',
            }
          : { Contents: [{ Key: 'chronicle/v1/b', Size: 2 }] };
      }
      return {};
    },
    destroy: () => undefined,
  };
  (provider as unknown as { client: typeof client }).client = client;

  await provider.initialize();
  await provider.put('v1/a', Buffer.from('abc'), {
    contentType: 'text/plain',
    checksum: 'abc',
    generation: 7,
  });
  const metadata = await provider.head('v1/a');
  assert.deepEqual(await provider.get('v1/a'), Buffer.from([1, 2, 3]));
  await provider.delete('v1/a');
  assert.deepEqual((await provider.list('v1/')).map((item) => item.key), ['v1/a', 'v1/b']);

  assert.ok(commands[0] instanceof HeadBucketCommand);
  const put = commands.find((command) => command instanceof PutObjectCommand) as PutObjectCommand;
  assert.equal(put.input.Bucket, 'books');
  assert.equal(put.input.Key, 'chronicle/v1/a');
  assert.equal(put.input.Metadata?.['chronicle-checksum'], 'abc');
  assert.equal(put.input.Metadata?.['chronicle-generation'], '7');
  assert.equal(metadata?.checksum, 'abc');
  assert.equal(metadata?.generation, 7);
  assert.ok(commands.some((command) => command instanceof DeleteObjectCommand));
  provider.close();
}

async function testNextcloud(): Promise<void> {
  config.nextcloud.url = 'https://cloud.example.test';
  config.nextcloud.user = 'writer';
  config.nextcloud.pass = 'app-password';
  config.nextcloud.storageDir = 'Replica/Chronicle';
  const provider = new NextcloudProvider();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const options = init || {};
    const url = String(input);
    requests.push({ url, init: options });
    if (options.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: {
          'content-length': '4',
          'content-type': 'application/json',
          'oc-checksum': 'SHA256:abc',
          'x-chronicle-generation': '3',
        },
      });
    }
    if (options.method === 'GET') return new Response('data', { status: 200 });
    return new Response(null, { status: options.method === 'MKCOL' ? 201 : 204 });
  };

  try {
    await provider.initialize();
    const key = 'v1/users/local/settings.json';
    await provider.put(key, Buffer.from('data'), {
      contentType: 'application/json',
      checksum: 'abc',
      generation: 3,
    });
    const metadata = await provider.head(key);
    assert.deepEqual(await provider.get(key), Buffer.from('data'));
    await provider.delete(key);

    const put = requests.find((request) => request.init.method === 'PUT');
    assert.ok(put);
    assert.equal(
      put.url,
      'https://cloud.example.test/remote.php/dav/files/writer/Replica/Chronicle/' + key,
    );
    const headers = put.init.headers as Record<string, string>;
    assert.equal(headers['OC-Checksum'], 'SHA256:abc');
    assert.equal(metadata?.checksum, 'abc');
    assert.equal(metadata?.generation, 3);
    assert.ok(requests.some((request) => request.url.endsWith('/Replica/Chronicle')));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await testS3();
await testNextcloud();
console.log('storage provider tests passed');
