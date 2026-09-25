DO $$ BEGIN
	CREATE TYPE "public"."standing_order_status" AS ENUM('active', 'paused');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."lead_refund_reason" AS ENUM('dead_phone', 'wrong_person', 'bounced', 'spam', 'never_asked', 'wrong_area');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."lead_refund_status" AS ENUM('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_standing_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"territories" jsonb NOT NULL,
	"category_ids" jsonb,
	"price_cents" integer NOT NULL,
	"status" "standing_order_status" DEFAULT 'active' NOT NULL,
	"paused_reason" text,
	"won_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lead_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"listing_id" uuid,
	"standing_order_id" uuid,
	"price_cents" integer NOT NULL,
	"ledger_id" uuid NOT NULL,
	"revealed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purchase_id" uuid NOT NULL,
	"reason" "lead_refund_reason" NOT NULL,
	"note" text,
	"status" "lead_refund_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "lead_digest_opt_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lead_standing_orders" ADD CONSTRAINT "lead_standing_orders_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lead_standing_orders" ADD CONSTRAINT "lead_standing_orders_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lead_purchases" ADD CONSTRAINT "lead_purchases_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lead_purchases" ADD CONSTRAINT "lead_purchases_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lead_purchases" ADD CONSTRAINT "lead_purchases_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lead_purchases" ADD CONSTRAINT "lead_purchases_standing_order_id_lead_standing_orders_id_fk" FOREIGN KEY ("standing_order_id") REFERENCES "public"."lead_standing_orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lead_refunds" ADD CONSTRAINT "lead_refunds_purchase_id_lead_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."lead_purchases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_standing_orders_status_idx" ON "lead_standing_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_standing_orders_listing_idx" ON "lead_standing_orders" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lead_purchases_lead_key" ON "lead_purchases" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_purchases_user_idx" ON "lead_purchases" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lead_refunds_purchase_key" ON "lead_refunds" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_refunds_status_idx" ON "lead_refunds" USING btree ("status");
