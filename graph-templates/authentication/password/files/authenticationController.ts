import { Request, Response } from 'express';
import { AuthenticationService } from '../services/authenticationService';
import { sendSuccess } from '../utils/apiResponse';
import { HttpStatusCodes, SECRETS } from '../utils/helpers';

const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ACCESS_COOKIE_MAX_AGE_MS = 15 * 60 * 1000;

export class AuthenticationController {
  private readonly service = new AuthenticationService();

  register = async (req: Request, res: Response): Promise<Response> => {
    const { user, verificationToken } = await this.service.register(req.body);
    return sendSuccess(
      res,
      { user, verificationLink: `${req.protocol}://${req.get('host')}/api/auth/verify-email/${verificationToken}` },
      'User registered successfully. Please check your email to verify your account.',
      HttpStatusCodes.CREATED,
    );
  };

  login = async (req: Request, res: Response): Promise<Response> => {
    const { user, accessToken, refreshToken } = await this.service.login(req.body.email, req.body.password);

    res.cookie('access_token', accessToken, {
      httpOnly: true,
      secure: SECRETS.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: ACCESS_COOKIE_MAX_AGE_MS,
    });
    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: SECRETS.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    }); // maxAge approximates refreshTokenExpiresAt from the service; both are driven by authentication.jwt's refreshTokenTtlDays input.

    return sendSuccess(res, { user }, 'Login successful');
  };

  me = async (req: Request, res: Response): Promise<Response> => {
    const user = await this.service.getCurrentUser(req.user!.id);
    return sendSuccess(res, { user });
  };

  forgotPassword = async (req: Request, res: Response): Promise<Response> => {
    await this.service.forgotPassword(req.body?.email);
    return sendSuccess(res, null, 'If an account exists with this email, a password reset link has been sent.');
  };

  resetPassword = async (req: Request, res: Response): Promise<Response> => {
    await this.service.resetPassword(req.params.resetToken, req.body.password, req.body.confirmPassword);
    return sendSuccess(res, null, 'Password has been reset successfully');
  };

  verifyEmail = async (req: Request, res: Response): Promise<Response> => {
    await this.service.verifyEmail(req.params.verifyToken);
    return sendSuccess(res, null, 'Email verified successfully');
  };

  logout = async (req: Request, res: Response): Promise<Response> => {
    await this.service.logout(req.cookies?.refresh_token);
    res.clearCookie('access_token', { httpOnly: true });
    res.clearCookie('refresh_token', { httpOnly: true });
    return sendSuccess(res, null, 'Successfully logged out');
  };
}
