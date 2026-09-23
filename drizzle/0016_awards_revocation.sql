ALTER TABLE "awards" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "awards" ADD COLUMN IF NOT EXISTS "revoke_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "awards_year_city_category_key" ON "awards" USING btree ("year","city_id","category_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "awards_listing_idx" ON "awards" USING btree ("listing_id");
