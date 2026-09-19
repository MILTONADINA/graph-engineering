import { compare, hash } from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { validate } from 'email-validator';
import { database } from '../config/database';
import { authTokenTable, userProfileTable, userTable } from '../config/schema';
import { SECRETS } from '../utils/helpers';
import { APIError } from '../middlewares/errorMiddleware';
import { HttpStatusCodes } from '../utils/helpers';

type UserRow = typeof userTable.$inferSelect;
type ProfileRow = typeof userProfileTable.$inferSelect;

export interface RegisterInput {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  phone?: string;
}

export interface PublicUser {
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

const MIN_PASSWORD_LENGTH = {{input.minPasswordLength}};

export class AuthenticationRepository {
  async validateRegistration(data: RegisterInput): Promise<void> {
    if (!validate(data.email.trim())) {
      throw new APIError('Invalid email format', HttpStatusCodes.BAD_REQUEST);
    }
    if (!data.firstName?.trim() || !data.lastName?.trim()) {
      throw new APIError('First name and last name are required', HttpStatusCodes.BAD_REQUEST);
    }
    if (data.password.length < MIN_PASSWORD_LENGTH) {
      throw new APIError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long`, HttpStatusCodes.BAD_REQUEST);
    }
  }

  async createUser(data: RegisterInput): Promise<UserRow> {
    const email = data.email.trim().toLowerCase();

    const existing = await database
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, email))
      .limit(1);
    if (existing.length > 0) {
      throw new APIError('User already exists', HttpStatusCodes.CONFLICT);
    }

    const passwordHash = await this.hashPassword(data.password);

    return database.transaction(async (tx) => {
      const [user] = await tx.insert(userTable).values({ email, passwordHash }).returning();
      await tx.insert(userProfileTable).values({
        userId: user.id,
        firstName: data.firstName.trim(),
        lastName: data.lastName.trim(),
        phone: data.phone?.trim() || null,
      });
      return user;
    });
  }

  async hashPassword(password: string): Promise<string> {
    return hash(password, SECRETS.SALT_ROUNDS);
  }

  async comparePasswords(password: string, passwordHash: string): Promise<boolean> {
    return compare(password, passwordHash);
  }

  async findUserByEmail(email: string): Promise<(UserRow & { profile: ProfileRow }) | undefined> {
    const [result] = await database
      .select()
      .from(userTable)
      .innerJoin(userProfileTable, eq(userProfileTable.userId, userTable.id))
      .where(eq(userTable.email, email.trim().toLowerCase()))
      .limit(1);
    return result ? { ...result.users, profile: result.user_profiles } : undefined;
  }

  async findUserById(userId: string): Promise<(UserRow & { profile: ProfileRow }) | undefined> {
    const [result] = await database
      .select()
      .from(userTable)
      .innerJoin(userProfileTable, eq(userProfileTable.userId, userTable.id))
      .where(eq(userTable.id, userId))
      .limit(1);
    return result ? { ...result.users, profile: result.user_profiles } : undefined;
  }

  async generateEmailVerificationToken(userId: string): Promise<string> {
    return this.createActionToken(userId, 'email_verification', 24 * 60 * 60 * 1000);
  }

  async generatePasswordResetToken(userId: string): Promise<string> {
    return this.createActionToken(userId, 'password_reset', 15 * 60 * 1000);
  }

  async verifyActionToken(token: string, type: 'email_verification' | 'password_reset'): Promise<string | null> {
    const tokenHash = this.hashToken(token);
    const [storedToken] = await database
      .select()
      .from(authTokenTable)
      .where(eq(authTokenTable.tokenHash, tokenHash))
      .limit(1);

    if (!storedToken || storedToken.type !== type || storedToken.consumedAt || storedToken.expiresAt <= new Date()) {
      return null;
    }

    await database
      .update(authTokenTable)
      .set({ consumedAt: new Date() })
      .where(eq(authTokenTable.id, storedToken.id));
    return storedToken.userId;
  }

  async updateUserPassword(userId: string, passwordHash: string): Promise<void> {
    await database
      .update(userTable)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(userTable.id, userId));
  }

  async markEmailAsVerified(userId: string): Promise<void> {
    await database
      .update(userTable)
      .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(userTable.id, userId));
  }

  toPublicUser(user: UserRow, profile: ProfileRow): PublicUser {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      emailVerifiedAt: user.emailVerifiedAt,
      firstName: profile.firstName,
      lastName: profile.lastName,
      phone: profile.phone,
      avatarUrl: profile.avatarUrl,
    };
  }

  private async createActionToken(
    userId: string,
    type: 'email_verification' | 'password_reset',
    lifetimeMs: number,
  ): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await database.insert(authTokenTable).values({
      userId,
      type,
      tokenHash: this.hashToken(token),
      expiresAt: new Date(Date.now() + lifetimeMs),
    });
    return token;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
