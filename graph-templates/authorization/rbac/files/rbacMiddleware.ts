import { NextFunction, Request, Response } from 'express';
import { APIError } from './errorMiddleware';
import { HttpStatusCodes } from '../utils/helpers';

export const requireRole = (...roles: Array<'customer' | 'admin'>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new APIError('Authentication required', HttpStatusCodes.UNAUTHORIZED));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new APIError('Forbidden', HttpStatusCodes.FORBIDDEN));
      return;
    }
    next();
  };
