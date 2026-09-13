import {
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AudioStorageProvider } from "./types";

export class CloudflareR2StorageProvider implements AudioStorageProvider {
  readonly name = "cloudflare-r2";
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    endpoint: string,
    accessKeyId: string,
    secretAccessKey: string,
    private readonly defaultTtlSeconds: number,
  ) {
    this.client = new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async put(input: { key: string; bytes: Uint8Array; contentType: string }) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.bytes,
        ContentType: input.contentType,
      }),
    );
  }

  async checkBucket(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  getReadUrl(key: string, expiresInSeconds = this.defaultTtlSeconds) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      {
        expiresIn: expiresInSeconds,
      },
    );
  }
}
