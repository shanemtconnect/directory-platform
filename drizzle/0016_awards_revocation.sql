ALTER TABLE "awards" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "awards" ADD COLUMN "revoke_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "awards_year_city_category_key" ON "awards" USING btree ("year","city_id","category_id");--> statement-breakpoint
CREATE INDEX "awards_listing_idx" ON "awards" USING btree ("listing_id");