import { describe, expect, it } from 'vitest';
import { s3Client, storageBucket } from '../../../../src/config/s3-client';

describe('storage.aws-s3', () => {
  it('constructs a client with forcePathStyle enabled', () => {
    expect(s3Client.config.forcePathStyle).toBe(true);
  });

  it('exposes the configured bucket name', () => {
    expect(typeof storageBucket).toBe('string');
    expect(storageBucket.length).toBeGreaterThan(0);
  });
});
