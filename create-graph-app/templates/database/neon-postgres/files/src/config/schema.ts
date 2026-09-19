import { pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

// Starter table — replace or extend with your own domain model.
export const exampleTable = pgTable('examples', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
