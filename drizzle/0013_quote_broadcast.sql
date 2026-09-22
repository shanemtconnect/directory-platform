CREATE TYPE "public"."quote_outcome" AS ENUM('open', 'won', 'lost');--> statement-breakpoint
ALTER TABLE "listing_stats_daily" ADD COLUMN "quote_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_recipients" ADD COLUMN "outcome" "quote_outcome" DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_recipients" ADD COLUMN "outcome_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD COLUMN "consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD COLUMN "is_spam" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "quote_recipients_listing_idx" ON "quote_recipients" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "quote_requests_created_idx" ON "quote_requests" USING btree ("created_at");