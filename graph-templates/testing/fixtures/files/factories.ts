export function buildFixture<T>(defaults: T, overrides: Partial<T> = {}): T {
  return { ...defaults, ...overrides };
}

// Matches the reference app's User shape (reference-app/src/utils/types.ts).
export interface UserFixture {
  id: string;
  email: string;
  role: 'customer' | 'admin';
  status: 'active' | 'suspended';
  emailVerifiedAt: Date | null;
  firstName: string;
  lastName: string;
  phone?: string | null;
  avatarUrl?: string | null;
}

const DEFAULT_USER_FIXTURE: UserFixture = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'test@example.com',
  role: 'customer',
  status: 'active',
  emailVerifiedAt: null,
  firstName: 'Test',
  lastName: 'User',
  phone: null,
  avatarUrl: null,
};

export function buildUserFixture(overrides: Partial<UserFixture> = {}): UserFixture {
  return buildFixture(DEFAULT_USER_FIXTURE, overrides);
}
