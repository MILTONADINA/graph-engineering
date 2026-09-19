import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';

config();
config({ path: '.env.local' });

export default defineConfig({
  schema: './src/config/schema.ts',
  out: './src/migrations',
  dbCredentials: {
    url: process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL!,
  },
  dialect: 'postgresql',
  verbose: true,
  strict: true,
});
