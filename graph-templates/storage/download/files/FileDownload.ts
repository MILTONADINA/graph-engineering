import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Response } from 'express';
import { Readable } from 'stream';
import { s3Client, storageBucket } from '../config/s3-client';
import { APIError } from '../middlewares/errorMiddleware';
import { HttpStatusCodes } from '../utils/helpers';

class FileDownloadRepository {
  async streamToResponse(key: string, res: Response, filename?: string): Promise<void> {
    let object;
    try {
      object = await s3Client.send(new GetObjectCommand({ Bucket: storageBucket, Key: key }));
    } catch (error) {
      throw new APIError('File not found', HttpStatusCodes.NOT_FOUND);
    }

    if (!(object.Body instanceof Readable)) {
      throw new APIError('Failed to read file', HttpStatusCodes.BAD_GATEWAY);
    }

    if (object.ContentType) {
      res.setHeader('Content-Type', object.ContentType);
    }
    if (filename) {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }

    object.Body.pipe(res);
  }
}

export const FileDownload = new FileDownloadRepository();
