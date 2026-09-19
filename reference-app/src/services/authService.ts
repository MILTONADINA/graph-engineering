import { Request, Response } from 'express';
import { HttpStatusCodes } from '../utils/helpers';
import {
  loginDataType,
  RegisterUserTypes,
  resetPasswordDataType,
  User,
} from '../utils/types';
import { AuthenticationRepository } from '../repository/User';

export class AuthenticationService {
  private readonly repository = new AuthenticationRepository();

  async register(req: Request, res: Response): Promise<Response> {
    const userData = req.body as RegisterUserTypes;

    try {
      const validation = await this.repository.validateUserData(userData);
      if (validation.status !== HttpStatusCodes.OK) {
        return res.status(validation.status).json(validation);
      }

      const existingUser = await this.repository.checkExistingUser(userData.email);
      if (existingUser.emailValidationStatus !== HttpStatusCodes.OK) {
        return res.status(existingUser.emailValidationStatus).json({
          status: existingUser.emailValidationStatus,
          message: existingUser.emailValidationMessage,
        });
      }

      const user = await this.repository.createUser(userData);
      const verificationToken = await this.repository.generateEmailVerificationToken(user.id);

      return res.status(HttpStatusCodes.CREATED).json({
        message: 'User registered successfully. Please check your email to verify your account.',
        user,
        verificationLink: `${req.protocol}://${req.get('host')}/api/auth/verify-email/${verificationToken}`,
      });
    } catch (error) {
      return this.repository.handleError(res, error);
    }
  }

  async login(req: Request, res: Response): Promise<Response> {
    const loginData = req.body as loginDataType;

    try {
      const user = await this.repository.findUserByEmail(loginData.email);
      if (!user || !(await this.repository.comparePasswords(loginData.password, user.passwordHash))) {
        return res.status(HttpStatusCodes.UNAUTHORIZED).json({ message: 'Invalid credentials' });
      }
      if (user.status !== 'active') {
        return res.status(HttpStatusCodes.FORBIDDEN).json({ message: 'Account is suspended' });
      }

      const publicUser: User = {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        emailVerifiedAt: user.emailVerifiedAt,
        firstName: user.profile.firstName,
        lastName: user.profile.lastName,
        phone: user.profile.phone,
        avatarUrl: user.profile.avatarUrl,
      };

      res.cookie('access_token', this.repository.generateAccessToken(user.id, user.role), {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 15 * 60 * 1000,
      });

      return res.status(HttpStatusCodes.OK).json({ message: 'Login successful', user: publicUser });
    } catch (error) {
      return this.repository.handleError(res, error);
    }
  }

  async forgotPassword(req: Request, res: Response): Promise<Response> {
    const { email } = req.body as { email?: string };

    try {
      const user = email ? await this.repository.findUserByEmail(email) : undefined;
      if (user) {
        await this.repository.generatePasswordResetToken(user.id);
      }

      return res.status(HttpStatusCodes.OK).json({
        message: 'If an account exists with this email, a password reset link has been sent.',
      });
    } catch (error) {
      return this.repository.handleError(res, error);
    }
  }

  async resetPassword(req: Request, res: Response): Promise<Response> {
    const { password, confirmPassword } = req.body as resetPasswordDataType;
    if (password !== confirmPassword) {
      return res.status(HttpStatusCodes.BAD_REQUEST).json({ message: 'Passwords do not match' });
    }

    const userId = await this.repository.verifyActionToken(req.params.resetToken, 'password_reset');
    if (!userId) {
      return res.status(HttpStatusCodes.BAD_REQUEST).json({ message: 'Invalid or expired reset token' });
    }

    try {
      await this.repository.updateUserPassword(userId, await this.repository.hashPassword(password));
      return res.status(HttpStatusCodes.OK).json({ message: 'Password has been reset successfully' });
    } catch (error) {
      return this.repository.handleError(res, error);
    }
  }

  async verifyEmail(req: Request, res: Response): Promise<Response> {
    const userId = await this.repository.verifyActionToken(req.params.verifyToken, 'email_verification');
    if (!userId) {
      return res.status(HttpStatusCodes.BAD_REQUEST).json({ message: 'Invalid or expired verification token' });
    }

    try {
      const user = await this.repository.findUserById(userId);
      if (!user) {
        return res.status(HttpStatusCodes.NOT_FOUND).json({ message: 'User not found' });
      }
      if (user.emailVerifiedAt) {
        return res.status(HttpStatusCodes.BAD_REQUEST).json({ message: 'This email is already verified' });
      }

      await this.repository.markEmailAsVerified(userId);
      return res.status(HttpStatusCodes.OK).json({ message: 'Email verified successfully' });
    } catch (error) {
      return this.repository.handleError(res, error);
    }
  }

  async logout(_req: Request, res: Response): Promise<Response> {
    res.clearCookie('access_token', { httpOnly: true });
    return res.status(HttpStatusCodes.OK).json({ message: 'Successfully logged out' });
  }
}
