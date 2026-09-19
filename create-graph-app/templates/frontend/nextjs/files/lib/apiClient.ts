import { ENV } from './env';

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface ApiSuccess<T> {
  message: string;
  data: T;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ApiPaginated<T> {
  message: string;
  data: T[];
  pagination: PaginationMeta;
}

interface ApiErrorBody {
  error: { message: string; status: number };
}

/** Always sends credentials so the backend's httpOnly auth cookies (if you add authentication) are forwarded automatically — never store a token client-side on top of this. */
export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${ENV.API_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const errorBody = body as ApiErrorBody | null;
    throw new ApiError(errorBody?.error?.message ?? 'Request failed', errorBody?.error?.status ?? response.status);
  }

  return body as T;
}
