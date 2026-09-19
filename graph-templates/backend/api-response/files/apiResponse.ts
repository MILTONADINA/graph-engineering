import { Response } from 'express';
import { HttpStatusCodes } from './helpers';

export function sendSuccess<T>(
  res: Response,
  data: T,
  message = 'Success',
  status: HttpStatusCodes = HttpStatusCodes.OK,
): Response {
  return res.status(status).json({ message, data });
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function sendPaginated<T>(
  res: Response,
  items: T[],
  meta: PaginationMeta,
  message = 'Success',
): Response {
  return res.status(HttpStatusCodes.OK).json({ message, data: items, pagination: meta });
}
