import { config } from 'dotenv';
config({ path: '.env.local' });
config();

interface EnvironmentVariables {
  PORT: number;
  NODE_ENV: 'development' | 'production';
  CORS_ORIGIN: string;
}

export const SECRETS: EnvironmentVariables = {
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  NODE_ENV: (process.env.NODE_ENV as 'development' | 'production') ?? 'development',
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? 'http://localhost:3001',
};
