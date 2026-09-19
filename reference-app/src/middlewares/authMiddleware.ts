import { NextFunction, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { AuthenticationRepository } from '../repository/User';
import { HttpStatusCodes, SECRETS } from '../utils/helpers';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: 'customer' | 'admin';
        emailVerifiedAt: Date | null;
      };
    }
  }
}

type AccessTokenPayload = JwtPayload & {
  sub: string;
  role: 'customer' | 'admin';
  type: 'access';
};

const repository = new AuthenticationRepository();

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : req.cookies.access_token;

  if (!token) {
    return res.status(HttpStatusCodes.UNAUTHORIZED).json({ message: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, SECRETS.ACCESS_TOKEN_SECRET) as Partial<AccessTokenPayload>;
    if (payload.type !== 'access' || typeof payload.sub !== 'string') {
      return res.status(HttpStatusCodes.UNAUTHORIZED).json({ message: 'Invalid token' });
    }

    const user = await repository.findUserById(payload.sub);
    if (!user || user.status !== 'active') {
      return res.status(HttpStatusCodes.UNAUTHORIZED).json({ message: 'Invalid token' });
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      emailVerifiedAt: user.emailVerifiedAt,
    };
    return next();
  } catch {
    return res.status(HttpStatusCodes.UNAUTHORIZED).json({ message: 'Invalid token' });
  }
};
