import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { config } from '../../config';
import type {
  ReplicaObjectMetadata,
  ReplicaProvider,
  ReplicaPutOptions,
} from './types';

function cleanLogicalKey(key: string, allowEmpty = false): string {
  const clean = key.replace(/^\/+/, '');
  if ((!clean && !allowEmpty) || clean.includes('\\')) {
    throw new Error(`Invalid replica key: ${key}`);
  }
  const segments = clean.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`Invalid replica key: ${key}`);
  }
  return clean;
}

function isNotFound(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return candidate?.name === 'NotFound' ||
    candidate?.name === 'NoSuchKey' ||
    candidate?.$metadata?.httpStatusCode === 404;
}

/** Generic AWS Signature V4 S3 replica (AWS, MinIO, R2, B2, and compatibles). */
export class S3Provider implements ReplicaProvider {
  readonly name = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket = config.s3.bucket;
  private readonly prefix = config.s3.prefix;

  constructor() {
    // Omitting credentials intentionally activates the SDK's standard Node
    // credential chain (env, shared config, process, web identity, ECS, EC2).
    this.client = new S3Client({
      region: config.s3.region,
      ...(config.s3.endpoint ? { endpoint: config.s3.endpoint } : {}),
      forcePathStyle: config.s3.forcePathStyle,
    });
  }

  private objectKey(logicalKey: string): string {
    const key = cleanLogicalKey(logicalKey);
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  private logicalKey(objectKey: string): string | null {
    if (!this.prefix) return objectKey;
    const root = `${this.prefix}/`;
    return objectKey.startsWith(root) ? objectKey.slice(root.length) : null;
  }

  async initialize(): Promise<void> {
    if (config.s3.endpoint) {
      const endpoint = new URL(config.s3.endpoint);
      if (endpoint.protocol !== 'https:' && !config.s3.allowInsecureHttp) {
        throw new Error(
          'Refusing insecure S3 endpoint; set S3_ALLOW_INSECURE_HTTP=true only for a trusted LAN.',
        );
      }
    }
    // Chronicle never creates or mutates bucket configuration implicitly.
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  async put(key: string, content: Buffer, options: ReplicaPutOptions): Promise<void> {
    const encryption = config.s3.serverSideEncryption as ServerSideEncryption | '';
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.objectKey(key),
      Body: content,
      ContentType: options.contentType,
      Metadata: {
        'chronicle-checksum': options.checksum,
        'chronicle-generation': String(options.generation),
      },
      ...(encryption ? { ServerSideEncryption: encryption } : {}),
      ...(encryption === 'aws:kms' && config.s3.kmsKeyId
        ? { SSEKMSKeyId: config.s3.kmsKeyId }
        : {}),
    }));
  }

  async head(key: string): Promise<ReplicaObjectMetadata | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
      }));
      const rawGeneration = result.Metadata?.['chronicle-generation'];
      const generation = rawGeneration === undefined ? undefined : Number(rawGeneration);
      return {
        key: cleanLogicalKey(key),
        size: result.ContentLength,
        contentType: result.ContentType,
        checksum: result.Metadata?.['chronicle-checksum'],
        generation: Number.isSafeInteger(generation) ? generation : undefined,
        etag: result.ETag,
        updatedAt: result.LastModified,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
      }));
      if (!result.Body) return Buffer.alloc(0);
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: this.objectKey(key),
    }));
  }

  async list(prefix: string): Promise<ReplicaObjectMetadata[]> {
    const logicalPrefix = cleanLogicalKey(prefix, true);
    const objectPrefix = this.prefix
      ? `${this.prefix}/${logicalPrefix}`
      : logicalPrefix;
    const objects: ReplicaObjectMetadata[] = [];
    let continuationToken: string | undefined;

    do {
      const page = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: objectPrefix,
        ContinuationToken: continuationToken,
      }));
      for (const item of page.Contents || []) {
        if (!item.Key) continue;
        const key = this.logicalKey(item.Key);
        if (key === null) continue;
        objects.push({
          key,
          size: item.Size,
          etag: item.ETag,
          updatedAt: item.LastModified,
        });
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);

    return objects;
  }

  close(): void {
    this.client.destroy();
  }
}
