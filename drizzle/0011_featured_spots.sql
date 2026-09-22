CREATE TABLE "featured_bids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"spot_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"subscription_id" uuid,
	"amount_cents" integer NOT NULL,
	"pending_amount_cents" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"position" integer,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "featured_bids_amount_check" CHECK ("featured_bids"."amount_cents" > 0),
	CONSTRAINT "featured_bids_status_check" CHECK ("featured_bids"."status" in ('pending', 'active', 'outbid', 'cancelled')),
	CONSTRAINT "featured_bids_position_check" CHECK ("featured_bids"."position" is null or "featured_bids"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "featured_spots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"area_kind" text NOT NULL,
	"area_id" text NOT NULL,
	"category_id" uuid,
	"positions" integer DEFAULT 3 NOT NULL,
	"floor_cents" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	CONSTRAINT "featured_spots_area_kind_check" CHECK ("featured_spots"."area_kind" in ('city', 'region')),
	CONSTRAINT "featured_spots_status_check" CHECK ("featured_spots"."status" in ('open', 'closed')),
	CONSTRAINT "featured_spots_positions_check" CHECK ("featured_spots"."positions" >= 1),
	CONSTRAINT "featured_spots_floor_check" CHECK ("featured_spots"."floor_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "featured_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"listing_id" uuid NOT NULL,
	"user_id" uuid,
	"provider" text DEFAULT 'paypal' NOT NULL,
	"provider_subscription_id" text,
	"provider_plan_id" text,
	"status" text NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"requested_quantity" integer DEFAULT 0 NOT NULL,
	"revise_requested_at" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	CONSTRAINT "featured_subscriptions_status_check" CHECK ("featured_subscriptions"."status" in ('approval_pending', 'active', 'past_due', 'cancelled', 'suspended', 'expired')),
	CONSTRAINT "featured_subscriptions_quantity_check" CHECK ("featured_subscriptions"."quantity" >= 0),
	CONSTRAINT "featured_subscriptions_requested_check" CHECK ("featured_subscriptions"."requested_quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "featured_bids" ADD CONSTRAINT "featured_bids_spot_id_featured_spots_id_fk" FOREIGN KEY ("spot_id") REFERENCES "public"."featured_spots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "featured_bids" ADD CONSTRAINT "featured_bids_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "featured_bids" ADD CONSTRAINT "featured_bids_subscription_id_featured_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."featured_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "featured_spots" ADD CONSTRAINT "featured_spots_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "featured_subscriptions" ADD CONSTRAINT "featured_subscriptions_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "featured_bids_spot_idx" ON "featured_bids" USING btree ("spot_id","status");--> statement-breakpoint
CREATE INDEX "featured_bids_listing_idx" ON "featured_bids" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "featured_bids_live_key" ON "featured_bids" USING btree ("spot_id","listing_id") WHERE "featured_bids"."status" <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "featured_spots_key" ON "featured_spots" USING btree ("area_kind","area_id",coalesce("category_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "featured_subscriptions_listing_idx" ON "featured_subscriptions" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "featured_subscriptions_provider_sub_key" ON "featured_subscriptions" USING btree ("provider_subscription_id");