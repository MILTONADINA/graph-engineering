import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';

config({ path: '.env.local' });
config();

export default defineConfig({
  schema: './src/config/schema.ts',
  out: './src/migrations',
  dbCredentials: { url: process.env.DATABASE_URL! },
  dialect: 'postgresql',
  verbose: true,
  strict: true,
});
