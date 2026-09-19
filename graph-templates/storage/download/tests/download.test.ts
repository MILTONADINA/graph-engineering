import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/config/s3-client', () => ({
  s3Client: { send: vi.fn().mockRejectedValue(new Error('not found')) },
  storageBucket: 'media',
}));

describe('storage.download', () => {
  it('throws APIError(404) when the object cannot be fetched', async () => {
    const { FileDownload } = await import('../../../../src/repository/FileDownload');
    const { APIError } = await import('../../../../src/middlewares/errorMiddleware');
    await expect(FileDownload.streamToResponse('missing-key', {} as any)).rejects.toBeInstanceOf(APIError);
  });
});
