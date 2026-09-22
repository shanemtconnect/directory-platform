ALTER TABLE "jobs" ADD COLUMN "listing_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "poster_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "poster_name" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "company_name" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "apply_method" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "apply_email" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "apply_url" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "apply_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "payment_status" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "provider_order_id" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "provider_capture_id" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "rejected_reason" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "ip" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_listing_idx" ON "jobs" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_provider_order_key" ON "jobs" USING btree ("provider_order_id");