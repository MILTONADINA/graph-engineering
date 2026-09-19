import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/config/s3-client', () => ({
  s3Client: { send: vi.fn().mockRejectedValue(new Error('network error')) },
  storageBucket: 'media',
}));

describe('storage.delete', () => {
  it('throws APIError instead of swallowing a delete failure', async () => {
    const { default: FileUpload } = await import('../../../../src/repository/FileUpload');
    const { APIError } = await import('../../../../src/middlewares/errorMiddleware');
    await expect(FileUpload.deleteFile('some-key')).rejects.toBeInstanceOf(APIError);
  });
});
