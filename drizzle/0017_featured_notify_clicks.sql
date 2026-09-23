ALTER TABLE "featured_bids" ADD COLUMN IF NOT EXISTS "outbid_notified_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "featured_clicks_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"spot_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"day" date NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "featured_clicks_daily" ADD CONSTRAINT "featured_clicks_daily_spot_id_featured_spots_id_fk" FOREIGN KEY ("spot_id") REFERENCES "public"."featured_spots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "featured_clicks_daily" ADD CONSTRAINT "featured_clicks_daily_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "featured_clicks_daily_key" ON "featured_clicks_daily" USING btree ("spot_id","listing_id","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "featured_clicks_daily_listing_idx" ON "featured_clicks_daily" USING btree ("listing_id","day");
