import { describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn((_client: unknown, _cmd: unknown, opts: { expiresIn: number }) =>
    Promise.resolve(`https://example.com/signed?expires=${opts.expiresIn}`)),
}));
vi.mock('../../../../src/config/s3-client', () => ({ s3Client: {}, storageBucket: 'media' }));

describe('storage.presigned-url', () => {
  it('clamps an over-long requested expiry to maxExpirySeconds', async () => {
    const { PresignedUrl } = await import('../../../../src/repository/PresignedUrl');
    const url = await PresignedUrl.getDownloadUrl('some-key', 999999999);
    expect(url).toContain('expires=86400');
  });
});
