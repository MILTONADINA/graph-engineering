import { Response } from 'express';
import { compare, hash } from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { validate } from 'email-validator';
import jwt from 'jsonwebtoken';
import { database } from '../config/database';
import { authTokenTable, userProfileTable, userTable } from '../config/schema';
import { HttpStatusCodes, SECRETS } from '../utils/helpers';
import { RegisterUserTypes, User, validateEmailType, validateUserType } from '../utils/types';

type UserRow = typeof userTable.$inferSelect;
type ProfileRow = typeof userProfileTable.$inferSelect;

export class AuthenticationRepository {
  private static readonly SALT_ROUNDS = SECRETS.SALT_ROUNDS || 12;

  async checkExistingUser(email: string): Promise<validateEmailType> {
    const existingUser = await database
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, email.trim().toLowerCase()))
      .limit(1);

    return existingUser.length > 0
      ? {
        emailValidationStatus: HttpStatusCodes.UNAUTHORIZED,
        emailValidationMessage: 'User already exists',
      }
      : {
        emailValidationStatus: HttpStatusCodes.OK,
        emailValidationMessage: 'Register user',
      };
  }

  async createUser(userData: RegisterUserTypes): Promise<User> {
    const email = userData.email.trim().toLowerCase();
    const passwordHash = await this.hashPassword(userData.password);

    const createdUser = await database.transaction(async (transaction) => {
      const [user] = await transaction
        .insert(userTable)
        .values({ email, passwordHash })
        .returning();

      await transaction.insert(userProfileTable).values({
        userId: user.id,
        firstName: userData.firstName.trim(),
        lastName: userData.lastName.trim(),
        phone: userData.phone?.trim() || null,
      });

      return user;
    });

    return this.toPublicUser(createdUser, {
      userId: createdUser.id,
      firstName: userData.firstName,
      lastName: userData.lastName,
      phone: userData.phone ?? null,
      avatarUrl: null,
      createdAt: createdUser.createdAt,
      updatedAt: createdUser.updatedAt,
    });
  }

  async validateUserData(userData: RegisterUserTypes): Promise<validateUserType> {
    if (!validate(userData.email.trim())) {
      return { message: 'Invalid email format', status: HttpStatusCodes.BAD_REQUEST };
    }
    if (!userData.firstName?.trim() || !userData.lastName?.trim()) {
      return { message: 'First name and last name are required', status: HttpStatusCodes.BAD_REQUEST };
    }
    if (userData.password.length < 12) {
      return { message: 'Password must be at least 12 characters long', status: HttpStatusCodes.BAD_REQUEST };
    }
    return { message: 'Valid user data', status: HttpStatusCodes.OK };
  }

  async hashPassword(password: string): Promise<string> {
    return hash(password, AuthenticationRepository.SALT_ROUNDS);
  }

  async findUserByEmail(email: string): Promise<UserRow & { profile: ProfileRow } | undefined> {
    const [result] = await database
      .select()
      .from(userTable)
      .innerJoin(userProfileTable, eq(userProfileTable.userId, userTable.id))
      .where(eq(userTable.email, email.trim().toLowerCase()))
      .limit(1);

    return result ? { ...result.users, profile: result.user_profiles } : undefined;
  }

  async findUserById(userId: string): Promise<UserRow & { profile: ProfileRow } | undefined> {
    const [result] = await database
      .select()
      .from(userTable)
      .innerJoin(userProfileTable, eq(userProfileTable.userId, userTable.id))
      .where(eq(userTable.id, userId))
      .limit(1);

    return result ? { ...result.users, profile: result.user_profiles } : undefined;
  }

  async comparePasswords(password: string, passwordHash: string): Promise<boolean> {
    return compare(password, passwordHash);
  }

  generateAccessToken(userId: string, role: User['role']): string {
    return jwt.sign(
      { sub: userId, role, type: 'access' },
      SECRETS.ACCESS_TOKEN_SECRET,
      { expiresIn: '15m' },
    );
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

  handleError(res: Response, error: unknown): Response {
    console.error('Error:', error);
    return res.status(HttpStatusCodes.INTERNAL_SERVER_ERROR).json({
      message: 'An unexpected error occurred',
    });
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

  private toPublicUser(user: UserRow, profile: ProfileRow): User {
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
}
