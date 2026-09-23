CREATE TYPE "public"."sponsor_campaign_status" AS ENUM('pending', 'active', 'paused', 'ended', 'rejected');--> statement-breakpoint
CREATE TABLE "sponsor_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"advertiser_id" uuid NOT NULL,
	"name" text NOT NULL,
	"logo_path" text,
	"title" text NOT NULL,
	"blurb" text NOT NULL,
	"target_url" text NOT NULL,
	"status" "sponsor_campaign_status" DEFAULT 'pending' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"subscription_id" text,
	"billing_status" text DEFAULT 'none' NOT NULL,
	"current_period_end" timestamp with time zone,
	"placements" text[] DEFAULT '{}'::text[] NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"rejection_reason" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "sponsor_campaigns_title_len" CHECK (char_length("sponsor_campaigns"."title") <= 60),
	CONSTRAINT "sponsor_campaigns_blurb_len" CHECK (char_length("sponsor_campaigns"."blurb") <= 120),
	CONSTRAINT "sponsor_campaigns_weight_check" CHECK ("sponsor_campaigns"."weight" >= 1),
	CONSTRAINT "sponsor_campaigns_billing_status_check" CHECK ("sponsor_campaigns"."billing_status" in ('none', 'approval_pending', 'active', 'past_due', 'cancelled', 'suspended', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "sponsor_stats_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"day" date NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sponsor_campaigns" ADD CONSTRAINT "sponsor_campaigns_advertiser_id_profiles_id_fk" FOREIGN KEY ("advertiser_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_stats_daily" ADD CONSTRAINT "sponsor_stats_daily_campaign_id_sponsor_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."sponsor_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sponsor_campaigns_status_idx" ON "sponsor_campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sponsor_campaigns_advertiser_idx" ON "sponsor_campaigns" USING btree ("advertiser_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sponsor_campaigns_subscription_key" ON "sponsor_campaigns" USING btree ("subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sponsor_stats_daily_key" ON "sponsor_stats_daily" USING btree ("campaign_id","day");