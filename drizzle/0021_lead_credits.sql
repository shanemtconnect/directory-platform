DO $$ BEGIN
	CREATE TYPE "public"."credit_kind" AS ENUM('topup', 'purchase', 'refund', 'adjust');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."credit_order_status" AS ENUM('created', 'captured', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"delta_cents" integer NOT NULL,
	"kind" "credit_kind" NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"note" text,
	"order_id" text,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"pack_cents" integer NOT NULL,
	"provider_order_id" text,
	"status" "credit_order_status" DEFAULT 'created' NOT NULL,
	"captured_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "credit_orders" ADD CONSTRAINT "credit_orders_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_ledger_user_idx" ON "credit_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_order_key" ON "credit_ledger" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_refund_key" ON "credit_ledger" USING btree ("ref_type","ref_id") WHERE "credit_ledger"."kind" = 'refund';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_orders_provider_order_key" ON "credit_orders" USING btree ("provider_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_orders_user_idx" ON "credit_orders" USING btree ("user_id");
