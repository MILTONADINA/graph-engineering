import { config } from 'dotenv';
config({ path: '.env.local' });
config();

interface EnvironmentVariables {
  ACCESS_TOKEN_SECRET: string;
  SALT_ROUNDS: number;
  PORT: number;
  NODE_ENV: "development" | "production";
  CORS_ORIGIN: string;
  NEON_DATABASE_URL: string,
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_REGION: string;
  AWS_BUCKET_NAME: string;
}

export enum HttpStatusCodes {
  // Success
  OK = 200,
  // Created Resource
  CREATED = 201,
  // Client Error
  BAD_REQUEST = 400,
  // Unauthorized
  UNAUTHORIZED = 401,
  // Forbidden
  FORBIDDEN = 403,
  // Not Found
  NOT_FOUND = 404,
  // Server Error
  INTERNAL_SERVER_ERROR = 500,
  // Bad Gateway
  BAD_GATEWAY = 502,
}

const requiredEnvironmentVariables = [
  'ACCESS_TOKEN_SECRET',
] as const;

const databaseUrl = process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Missing required environment variable: DATABASE_URL');
}

const missingEnvironmentVariables = requiredEnvironmentVariables.filter(
  (name) => !process.env[name],
);

if (missingEnvironmentVariables.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingEnvironmentVariables.join(', ')}`,
  );
}

const saltRounds = Number.parseInt(process.env.SALT_ROUNDS ?? '12', 10);
if (!Number.isInteger(saltRounds) || saltRounds < 10) {
  throw new Error('SALT_ROUNDS must be an integer greater than or equal to 10');
}

export const SECRETS: EnvironmentVariables = {
  PORT: process.env.PORT ? parseInt(process.env.PORT) : 3000,
  NODE_ENV: process.env.NODE_ENV as "development" | "production",
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  NEON_DATABASE_URL: databaseUrl,
  ACCESS_TOKEN_SECRET: process.env.ACCESS_TOKEN_SECRET!,
  SALT_ROUNDS: saltRounds,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID!,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  AWS_REGION: process.env.AWS_REGION!,
  AWS_BUCKET_NAME: process.env.AWS_BUCKET_NAME!,
}


