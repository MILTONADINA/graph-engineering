import { NextFunction, Request, Response } from 'express';
import { APIError } from './errorMiddleware';
import { HttpStatusCodes } from '../utils/helpers';

declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
    }
  }
}

export const requireTenant = (req: Request, res: Response, next: NextFunction): void => {
  const tenantId = (req.user as (Request['user'] & { tenantId?: string }) | undefined)?.tenantId;
  if (!tenantId) {
    next(new APIError('Tenant context required', HttpStatusCodes.UNAUTHORIZED));
    return;
  }
  req.tenantId = tenantId;
  next();
};
