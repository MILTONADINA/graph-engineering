import { NextFunction, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { HttpStatusCodes, SECRETS } from '../utils/helpers';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: string;
      };
    }
  }
}

type AccessTokenPayload = JwtPayload & {
  sub: string;
  role: string;
  type: 'access';
};

export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : req.cookies?.access_token;

  if (!token) {
    return res.status(HttpStatusCodes.UNAUTHORIZED).json({ message: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, SECRETS.ACCESS_TOKEN_SECRET) as Partial<AccessTokenPayload>;
    if (payload.type !== 'access' || typeof payload.sub !== 'string' || typeof payload.role !== 'string') {
      return res.status(HttpStatusCodes.UNAUTHORIZED).json({ message: 'Invalid token' });
    }

    req.user = { id: payload.sub, role: payload.role, email: '' };
    return next();
  } catch {
    return res.status(HttpStatusCodes.UNAUTHORIZED).json({ message: 'Invalid token' });
  }
};
