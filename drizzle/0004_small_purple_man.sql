ALTER TABLE "listing_images" ADD COLUMN "derivatives_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_images" ADD COLUMN "derivatives_error" text;--> statement-breakpoint
CREATE INDEX "cities_name_lower_idx" ON "cities" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "listings_area_status_idx" ON "listings" USING btree ("area_id","status");--> statement-breakpoint
CREATE INDEX "listings_premium_status_idx" ON "listings" USING btree ("status") WHERE "listings"."tier" = 'premium';--> statement-breakpoint
CREATE INDEX "listings_dupe_name_postcode_idx" ON "listings" USING btree (lower(trim("name")),lower(regexp_replace("postcode", '[\s-]+', '', 'g')));--> statement-breakpoint
CREATE INDEX "listings_dupe_phone_idx" ON "listings" USING btree (regexp_replace("phone", '[^0-9]', '', 'g'));