import { database } from '../config/database';

type Transaction = Parameters<Parameters<typeof database.transaction>[0]>[0];

export async function withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return database.transaction(fn);
}
