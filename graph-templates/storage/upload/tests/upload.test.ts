import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/config/s3-client', () => ({
  s3Client: { send: vi.fn().mockRejectedValue(new Error('network error')) },
  storageBucket: 'media',
}));

describe('storage.upload', () => {
  it('throws APIError instead of returning null on failure', async () => {
    const { default: FileUpload } = await import('../../../../src/repository/FileUpload');
    const { APIError } = await import('../../../../src/middlewares/errorMiddleware');
    const file = { originalname: 'a.png', mimetype: 'image/png', buffer: Buffer.from('x') } as Express.Multer.File;
    await expect(FileUpload.uploadFileToS3(file)).rejects.toBeInstanceOf(APIError);
  });
});
