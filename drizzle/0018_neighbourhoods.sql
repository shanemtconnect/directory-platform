ALTER TABLE "areas" ADD COLUMN IF NOT EXISTS "city_id" uuid;--> statement-breakpoint
ALTER TABLE "areas" ADD COLUMN IF NOT EXISTS "radius_km" real;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "areas" ADD CONSTRAINT "areas_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "areas_city_published_idx" ON "areas" USING btree ("city_id","is_published");--> statement-breakpoint
DROP INDEX IF EXISTS "areas_slug_key";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "areas_city_slug_key" ON "areas" USING btree (coalesce("city_id", '00000000-0000-0000-0000-000000000000'::uuid),"slug");
