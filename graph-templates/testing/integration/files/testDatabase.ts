import { neonConfig, Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

let cachedDatabase: ReturnType<typeof drizzle> | undefined;

export function getTestDatabase() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to create a test database connection when NODE_ENV=production. ' +
      'testing.integration is destructive (truncateAllTables) and must never run against production.',
    );
  }

  if (!cachedDatabase) {
    const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('Set TEST_DATABASE_URL (or DATABASE_URL) before running integration tests.');
    }
    if (!process.env.TEST_DATABASE_URL) {
      console.warn(
        'TEST_DATABASE_URL is not set — integration tests are falling back to DATABASE_URL. ' +
        'This will TRUNCATE every table in that database between tests. Set TEST_DATABASE_URL ' +
        'to a disposable database to avoid this warning and the associated risk.',
      );
    }
    cachedDatabase = drizzle(new Pool({ connectionString }));
  }

  return cachedDatabase;
}

// Table names are read at call time from the schema module the target project
// generates (database.neon-postgres.connection + backend.repository entries),
// not hard-coded here — a generated project passes its own table list.
export async function truncateAllTables(tableNames: string[]): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to truncate tables when NODE_ENV=production.');
  }
  const database = getTestDatabase();
  for (const table of tableNames) {
    await database.execute(sql.raw(`TRUNCATE TABLE "${table}" CASCADE`));
  }
}
