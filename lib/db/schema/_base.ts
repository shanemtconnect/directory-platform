import { uuid, timestamp } from "drizzle-orm/pg-core";

/** Every table carries these three. Spread into each pgTable definition. */
export const base = {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};
