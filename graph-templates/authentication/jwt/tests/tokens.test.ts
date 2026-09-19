import { describe, expect, it } from 'vitest';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '../../../../src/utils/tokens';

describe('authentication.jwt', () => {
  it('round-trips an access token', () => {
    const token = generateAccessToken('user-1', 'admin');
    const payload = verifyAccessToken(token);
    expect(payload?.sub).toBe('user-1');
    expect(payload?.role).toBe('admin');
  });

  it('rejects an access token passed to verifyRefreshToken', () => {
    const token = generateAccessToken('user-1', 'admin');
    expect(verifyRefreshToken(token)).toBeNull();
  });

  it('rejects a refresh token passed to verifyAccessToken', () => {
    const token = generateRefreshToken('user-1');
    expect(verifyAccessToken(token)).toBeNull();
  });

  it('returns null for a garbage token instead of throwing', () => {
    expect(verifyAccessToken('not-a-jwt')).toBeNull();
  });
});
