import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ENV, type Env } from '../config/env';

/** Storage de archivos en Cloudflare R2, API S3 (D-007). Usado por `imports` para el xlsx/csv original. */
@Injectable()
export class StorageService {
  private readonly client: S3Client | null;
  private readonly bucket: string;

  constructor(@Inject(ENV) env: Env) {
    this.bucket = env.R2_BUCKET;
    this.client =
      env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET
        ? new S3Client({
            region: 'auto',
            endpoint: env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials: {
              accessKeyId: env.R2_ACCESS_KEY_ID,
              secretAccessKey: env.R2_SECRET_ACCESS_KEY,
            },
          })
        : null;
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'El almacenamiento de archivos (R2) no está configurado',
      );
    }
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async getObject(key: string): Promise<Buffer> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'El almacenamiento de archivos (R2) no está configurado',
      );
    }
    const res: GetObjectCommandOutput = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new ServiceUnavailableException('No se pudo leer el archivo de R2');
    return Buffer.from(bytes);
  }
}
