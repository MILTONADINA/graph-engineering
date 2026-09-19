import { eq } from 'drizzle-orm';
import { generateAccessToken, generateRefreshToken, hashToken } from '../utils/tokens';
import { database } from '../config/database';
import { refreshTokenTable } from '../config/schema';
import { APIError } from '../middlewares/errorMiddleware';
import { HttpStatusCodes } from '../utils/helpers';
import { AuthenticationRepository, PublicUser, RegisterInput } from '../repository/Authentication';

export interface LoginResult {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export class AuthenticationService {
  private readonly repository = new AuthenticationRepository();

  async register(data: RegisterInput): Promise<{ user: PublicUser; verificationToken: string }> {
    await this.repository.validateRegistration(data);
    const user = await this.repository.createUser(data);
    const verificationToken = await this.repository.generateEmailVerificationToken(user.id);
    return {
      user: this.repository.toPublicUser(user, {
        userId: user.id,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone ?? null,
        avatarUrl: null,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      }),
      verificationToken,
    };
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.repository.findUserByEmail(email);
    if (!user || !(await this.repository.comparePasswords(password, user.passwordHash))) {
      throw new APIError('Invalid credentials', HttpStatusCodes.UNAUTHORIZED);
    }
    if (user.status !== 'active') {
      throw new APIError('Account is suspended', HttpStatusCodes.FORBIDDEN);
    }

    const refresh = generateRefreshToken();
    await database.insert(refreshTokenTable).values({
      userId: user.id,
      tokenHash: refresh.tokenHash,
      expiresAt: refresh.expiresAt,
    });

    return {
      user: this.repository.toPublicUser(user, user.profile),
      accessToken: generateAccessToken(user.id, user.role),
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt,
    };
  }

  async getCurrentUser(userId: string): Promise<PublicUser> {
    const user = await this.repository.findUserById(userId);
    if (!user) {
      throw new APIError('User not found', HttpStatusCodes.NOT_FOUND);
    }
    return this.repository.toPublicUser(user, user.profile);
  }

  async forgotPassword(email?: string): Promise<void> {
    const user = email ? await this.repository.findUserByEmail(email) : undefined;
    if (user) {
      await this.repository.generatePasswordResetToken(user.id);
    }
    // Always resolves the same way regardless of whether the account exists — no user enumeration.
  }

  async resetPassword(resetToken: string, password: string, confirmPassword: string): Promise<void> {
    if (password !== confirmPassword) {
      throw new APIError('Passwords do not match', HttpStatusCodes.BAD_REQUEST);
    }
    const userId = await this.repository.verifyActionToken(resetToken, 'password_reset');
    if (!userId) {
      throw new APIError('Invalid or expired reset token', HttpStatusCodes.BAD_REQUEST);
    }
    await this.repository.updateUserPassword(userId, await this.repository.hashPassword(password));
  }

  async verifyEmail(verifyToken: string): Promise<void> {
    const userId = await this.repository.verifyActionToken(verifyToken, 'email_verification');
    if (!userId) {
      throw new APIError('Invalid or expired verification token', HttpStatusCodes.BAD_REQUEST);
    }
    const user = await this.repository.findUserById(userId);
    if (!user) {
      throw new APIError('User not found', HttpStatusCodes.NOT_FOUND);
    }
    if (user.emailVerifiedAt) {
      throw new APIError('This email is already verified', HttpStatusCodes.BAD_REQUEST);
    }
    await this.repository.markEmailAsVerified(userId);
  }
}
