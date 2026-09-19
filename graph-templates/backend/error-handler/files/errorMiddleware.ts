import { Request, Response, NextFunction } from 'express';

interface ErrorWithStatus extends Error {
  status?: number;
}

export const errorHandler = (
  err: ErrorWithStatus,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  console.error(err.stack);

  const status = err.status || 500;
  const message = err.message || 'Something went wrong';

  res.status(status).json({
    error: {
      message,
      status,
    },
  });
};

export class APIError extends Error {
  status: number;

  constructor(message: string, status: number = 400) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    Error.captureStackTrace(this, this.constructor);
  }
}
