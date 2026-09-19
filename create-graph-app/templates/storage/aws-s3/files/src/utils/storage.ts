import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { s3Client, storageBucket } from '../config/s3Client';

/** Uploads a buffered file under a collision-resistant key and returns the key. Throws on failure — never swallow a storage error. */
export async function uploadFile(file: { buffer: Buffer; originalname: string; mimetype: string }, keyPrefix = 'uploads'): Promise<string> {
  const key = `${keyPrefix}/${randomUUID()}-${basename(file.originalname)}`;
  await s3Client.send(
    new PutObjectCommand({ Bucket: storageBucket, Key: key, Body: file.buffer, ContentType: file.mimetype }),
  );
  return key;
}

/** A time-limited signed URL for reading a private object. Default 1 hour, clamped to a maximum of 24 hours. */
export async function getDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
  return getSignedUrl(s3Client, new GetObjectCommand({ Bucket: storageBucket, Key: key }), {
    expiresIn: Math.min(expiresIn, 86400),
  });
}

/** A time-limited signed URL a client can PUT directly to, bypassing your server for the upload body. */
export async function getUploadUrl(key: string, contentType: string, expiresIn = 3600): Promise<string> {
  return getSignedUrl(s3Client, new PutObjectCommand({ Bucket: storageBucket, Key: key, ContentType: contentType }), {
    expiresIn: Math.min(expiresIn, 86400),
  });
}

export async function deleteFile(key: string): Promise<void> {
  await s3Client.send(new DeleteObjectCommand({ Bucket: storageBucket, Key: key }));
}
