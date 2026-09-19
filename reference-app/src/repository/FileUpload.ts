import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { basename } from 'path';
import { s3Client, storageBucket } from '../config/s3-client';

class FileUpload {
  async uploadFileToS3(file: Express.Multer.File): Promise<string | null> {
    if (!file) return null;

    const key = `uploads/${randomUUID()}-${basename(file.originalname)}`;
    try {
      await s3Client.send(new PutObjectCommand({
        Bucket: storageBucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }));
      return key;
    } catch (error) {
      console.error('Error uploading file to Neon Object Storage:', error);
      return null;
    }
  }

  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    return getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: storageBucket, Key: key }),
      { expiresIn },
    );
  }
}

export default new FileUpload();
