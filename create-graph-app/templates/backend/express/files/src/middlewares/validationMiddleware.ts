import { NextFunction, Request, Response } from 'express';
import { ZodSchema } from 'zod';
import { APIError } from './errorMiddleware';
import { HttpStatusCodes } from '../utils/httpStatus';

function formatIssues(error: { issues: { message: string }[] }): string {
  return error.issues.map((issue) => issue.message).join(', ');
}

export const validateBody = (schema: ZodSchema) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new APIError(formatIssues(result.error), HttpStatusCodes.BAD_REQUEST));
      return;
    }
    req.body = result.data;
    next();
  };
