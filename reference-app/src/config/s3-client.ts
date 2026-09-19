import { S3Client } from '@aws-sdk/client-s3';
import { config } from 'dotenv';

config({ path: '.env.local' });
config();

const endpoint = process.env.AWS_ENDPOINT_URL_S3;
const region = process.env.AWS_REGION;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

if (!endpoint || !region || !accessKeyId || !secretAccessKey) {
  throw new Error(
    'Missing required object storage variables: AWS_ENDPOINT_URL_S3, AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY',
  );
}

export const storageBucket = process.env.AWS_BUCKET_NAME ?? 'media';

export const s3Client = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: true,
});
