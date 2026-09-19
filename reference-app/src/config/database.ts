import { neonConfig, Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import { SECRETS } from '../utils/helpers';

neonConfig.webSocketConstructor = ws;

export const pool = new Pool({ connectionString: SECRETS.NEON_DATABASE_URL });
export const database = drizzle(pool);


