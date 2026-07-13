import crypto from 'node:crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { eventually } from './harness.mjs';

export const bucket = process.env.S3_BUCKET || 'chronicle-formal';
export const prefix = process.env.S3_PREFIX || 'formal';

export const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'chronicle-formal',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'chronicle-formal-secret',
  },
});

export function objectKey(logicalKey) {
  return prefix ? `${prefix}/${logicalKey}` : logicalKey;
}

export async function getObject(logicalKey) {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey(logicalKey) }));
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  return {
    bytes,
    contentType: response.ContentType,
    metadata: response.Metadata || {},
    checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function headObject(logicalKey) {
  try {
    const response = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey(logicalKey) }));
    return response;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') {
      return null;
    }
    throw error;
  }
}

export async function listObjects(logicalPrefix = '') {
  const objects = [];
  let ContinuationToken;
  do {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: objectKey(logicalPrefix),
      ContinuationToken,
    }));
    for (const item of response.Contents || []) {
      objects.push({ ...item, logicalKey: item.Key.slice(prefix.length + (prefix ? 1 : 0)) });
    }
    ContinuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return objects;
}

export async function waitObject(logicalKey, predicate = () => true, timeoutMs = 30_000) {
  return eventually(async () => {
    const head = await headObject(logicalKey);
    if (!head) return false;
    const object = await getObject(logicalKey);
    return predicate(object) ? object : false;
  }, { timeoutMs, intervalMs: 150, label: `S3 object ${logicalKey}` });
}

export async function waitObjectAbsent(logicalKey, timeoutMs = 30_000) {
  return eventually(async () => (await headObject(logicalKey)) === null, {
    timeoutMs,
    intervalMs: 150,
    label: `S3 deletion ${logicalKey}`,
  });
}

export function assertChronicleMetadata(assert, object) {
  assert.match(object.metadata['chronicle-checksum'] || '', /^[a-f0-9]{64}$/);
  assert.equal(object.metadata['chronicle-checksum'], object.checksum);
  assert.match(object.metadata['chronicle-generation'] || '', /^[1-9][0-9]*$/);
}
