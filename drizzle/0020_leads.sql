DO $$ BEGIN
	CREATE TYPE "public"."quote_status" AS ENUM('pending', 'verified', 'expired', 'spam');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."lead_source" AS ENUM('quote', 'capture', 'enquiry');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."lead_status" AS ENUM('open', 'sold', 'expired', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."blocklist_kind" AS ENUM('phone', 'email');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD COLUMN IF NOT EXISTS "status" "quote_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD COLUMN IF NOT EXISTS "verify_token_hash" text;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD COLUMN IF NOT EXISTS "verify_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD COLUMN IF NOT EXISTS "source" "lead_source" DEFAULT 'quote' NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD COLUMN IF NOT EXISTS "listing_id" uuid;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- Every request written before verification existed was delivered on submit.
-- Marking them verified keeps them on owners' leads pages and out of the
-- expiry sweep; nothing already sent is gated again.
UPDATE "quote_requests" SET "status" = 'verified', "verified_at" = "created_at"
	WHERE "verified_at" IS NULL AND "verify_token_hash" IS NULL AND "status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "quote_requests_verify_token_key" ON "quote_requests" USING btree ("verify_token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quote_requests_status_idx" ON "quote_requests" USING btree ("status","verify_expires_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" "lead_source" NOT NULL,
	"quote_request_id" uuid,
	"listing_id" uuid,
	"city_id" uuid NOT NULL,
	"category_id" uuid,
	"first_name" text NOT NULL,
	"brief" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"phone_normalised" text,
	"email_normalised" text NOT NULL,
	"message" text NOT NULL,
	"status" "lead_status" DEFAULT 'open' NOT NULL,
	"price_cents" integer NOT NULL,
	"sold_at" timestamp with time zone,
	"sold_to_listing_id" uuid,
	"buyer_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"half_price_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_blocklist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "blocklist_kind" NOT NULL,
	"value" text NOT NULL,
	"reason" text NOT NULL,
	"lead_id" uuid,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "leads" ADD CONSTRAINT "leads_quote_request_id_quote_requests_id_fk" FOREIGN KEY ("quote_request_id") REFERENCES "public"."quote_requests"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "leads" ADD CONSTRAINT "leads_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "leads" ADD CONSTRAINT "leads_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "leads" ADD CONSTRAINT "leads_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "leads" ADD CONSTRAINT "leads_sold_to_listing_id_listings_id_fk" FOREIGN KEY ("sold_to_listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "leads" ADD CONSTRAINT "leads_buyer_user_id_user_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lead_blocklist" ADD CONSTRAINT "lead_blocklist_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_status_city_idx" ON "leads" USING btree ("status","city_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_phone_idx" ON "leads" USING btree ("phone_normalised");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_email_idx" ON "leads" USING btree ("email_normalised");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lead_blocklist_key" ON "lead_blocklist" USING btree ("kind","value");
