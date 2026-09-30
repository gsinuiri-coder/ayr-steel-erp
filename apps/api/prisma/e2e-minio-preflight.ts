import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

// Verifica lectura y escritura en MinIO local antes de reservar correlativos PSE.
async function main(): Promise<void> {
  const endpoint = process.env.R2_ENDPOINT;
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (
    endpoint !== 'http://127.0.0.1:9000' ||
    bucket !== 'ayr-e2e' ||
    !accessKeyId ||
    !secretAccessKey
  ) {
    throw new Error('El gate PSE exige MinIO local');
  }
  const client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
  const key = 'preflight/e2e-pse.txt';
  const body = Buffer.from('ayr-e2e-pse');
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'text/plain' }),
  );
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const actual = await result.Body?.transformToByteArray();
  if (!actual || !Buffer.from(actual).equals(body)) {
    throw new Error('MinIO local no devolvió el objeto escrito');
  }
  client.destroy();
}

main().catch(() => {
  console.error('MinIO local no pasó la prueba de lectura y escritura');
  process.exitCode = 1;
});
