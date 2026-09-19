import { describe, expect, it } from 'vitest';
import { buildFixture, buildUserFixture } from '../../../../tests/fixtures/factories';

describe('testing.fixtures', () => {
  it('buildFixture applies overrides on top of defaults', () => {
    expect(buildFixture({ a: 1, b: 2 }, { b: 5 })).toEqual({ a: 1, b: 5 });
  });

  it('buildUserFixture overrides only the requested field', () => {
    const admin = buildUserFixture({ role: 'admin' });
    expect(admin.role).toBe('admin');
    expect(admin.email).toBe('test@example.com');
  });
});
