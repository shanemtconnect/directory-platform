CREATE TYPE "public"."badge_style" AS ENUM('dark', 'light', 'compact', 'rating');--> statement-breakpoint
CREATE TYPE "public"."billing_interval" AS ENUM('monthly', 'annual');--> statement-breakpoint
CREATE TYPE "public"."campaign_channel" AS ENUM('email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."city_created_by" AS ENUM('seed', 'admin', 'auto');--> statement-breakpoint
CREATE TYPE "public"."claim_request_status" AS ENUM('pending', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('unclaimed', 'claimed', 'verified');--> statement-breakpoint
CREATE TYPE "public"."discount_type" AS ENUM('percent', 'fixed');--> statement-breakpoint
CREATE TYPE "public"."evidence_type" AS ENUM('domain_email', 'phone_otp', 'document', 'id_document');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'published', 'expired', 'removed');--> statement-breakpoint
CREATE TYPE "public"."listing_source" AS ENUM('seed', 'admin', 'public', 'import', 'scraped');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('draft', 'pending', 'published', 'rejected', 'archived', 'removed');--> statement-breakpoint
CREATE TYPE "public"."listing_tier" AS ENUM('free', 'essential', 'premium');--> statement-breakpoint
CREATE TYPE "public"."removal_status" AS ENUM('open', 'actioned', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."report_reason" AS ENUM('incorrect', 'closed', 'duplicate', 'offensive', 'other');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'actioned', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('pending', 'published', 'rejected', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."slug_kind" AS ENUM('static', 'city', 'vertical', 'area', 'category', 'listing');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'owner', 'admin');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('open', 'docs_pending', 'call_scheduled', 'passed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"intro_html" text,
	"faq" jsonb,
	"meta_title" text,
	"meta_description" text,
	"is_published" boolean DEFAULT true NOT NULL,
	"is_indexable" boolean DEFAULT false NOT NULL,
	"listing_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"vertical_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"singular" text NOT NULL,
	"plural" text NOT NULL,
	"description" text,
	"icon" text,
	"schema_type_override" text,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"region" text,
	"country" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"population" integer,
	"intro_html" text,
	"faq" jsonb,
	"meta_title" text,
	"meta_description" text,
	"hero_image_url" text,
	"is_published" boolean DEFAULT true NOT NULL,
	"is_indexable" boolean DEFAULT false NOT NULL,
	"listing_count" integer DEFAULT 0 NOT NULL,
	"created_by" "city_created_by" DEFAULT 'seed' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slugs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parent_scope" text NOT NULL,
	"slug" text NOT NULL,
	"kind" "slug_kind" NOT NULL,
	"entity_id" uuid
);
--> statement-breakpoint
CREATE TABLE "verticals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"singular" text NOT NULL,
	"plural" text NOT NULL,
	"owner_noun" text NOT NULL,
	"schema_type" text NOT NULL,
	"icon" text,
	"intro_html" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"listing_id" uuid NOT NULL,
	"category_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"listing_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"derivatives" jsonb,
	"alt" text,
	"width" integer,
	"height" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"city_id" uuid NOT NULL,
	"area_id" uuid,
	"vertical_id" uuid NOT NULL,
	"primary_category_id" uuid NOT NULL,
	"status" "listing_status" DEFAULT 'draft' NOT NULL,
	"tier" "listing_tier" DEFAULT 'free' NOT NULL,
	"claim_status" "claim_status" DEFAULT 'unclaimed' NOT NULL,
	"owner_id" uuid,
	"address_line1" text,
	"address_line2" text,
	"postcode" text,
	"lat" double precision,
	"lng" double precision,
	"phone" text,
	"email" text,
	"website" text,
	"socials" jsonb,
	"short_description" text,
	"description" text,
	"offers" text,
	"opening_hours" jsonb,
	"timezone" text,
	"custom_fields" jsonb,
	"price_range" text,
	"rank_boost" integer DEFAULT 0 NOT NULL,
	"rating_avg" numeric(2, 1),
	"rating_count" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_expires_at" timestamp with time zone,
	"verified_by" uuid,
	"verification_checks" jsonb,
	"view_count" integer DEFAULT 0 NOT NULL,
	"enquiry_count" integer DEFAULT 0 NOT NULL,
	"source" "listing_source" DEFAULT 'seed' NOT NULL,
	"source_url" text,
	"imported_at" timestamp with time zone,
	"submitted_by_email" text,
	"published_at" timestamp with time zone,
	"rejected_reason" text
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"listing_id" uuid NOT NULL,
	"user_id" uuid,
	"status" "claim_request_status" DEFAULT 'pending' NOT NULL,
	"claimant_name" text,
	"role_at_business" text,
	"business_email" text,
	"business_phone" text,
	"evidence_type" "evidence_type",
	"evidence_notes" text,
	"id_document_path" text,
	"proof_document_path" text,
	"email_verified_at" timestamp with time zone,
	"phone_verified_at" timestamp with time zone,
	"magic_token" text,
	"magic_token_expires_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"admin_notes" text,
	"rejection_reason" text,
	"documents_purged_at" timestamp with time zone,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"name" text,
	"phone" text,
	"billing_customer_id" text,
	"marketing_opt_in" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"listing_id" uuid NOT NULL,
	"subscription_id" uuid,
	"user_id" uuid,
	"status" "verification_status" DEFAULT 'open' NOT NULL,
	"evidence_type" "evidence_type",
	"checklist" jsonb,
	"call_scheduled_at" timestamp with time zone,
	"signed_off_by" uuid,
	"signed_off_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "coupon_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"coupon_id" uuid NOT NULL,
	"user_id" uuid,
	"listing_id" uuid,
	"subscription_id" uuid,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"description" text,
	"discount_type" "discount_type" NOT NULL,
	"value" numeric(10, 2) NOT NULL,
	"applies_to_tiers" text[],
	"applies_to_intervals" text[],
	"max_redemptions" integer,
	"redemption_count" integer DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"batch_id" uuid
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"listing_id" uuid NOT NULL,
	"user_id" uuid,
	"provider" text DEFAULT 'paypal' NOT NULL,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"provider_plan_id" text,
	"tier" "listing_tier" NOT NULL,
	"interval" "billing_interval" NOT NULL,
	"status" text NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"listing_id" uuid NOT NULL,
	"name" text,
	"email" text,
	"phone" text,
	"message" text,
	"is_spam" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"responded_in_minutes" integer,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "removal_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"listing_id" uuid NOT NULL,
	"requester_name" text,
	"requester_email" text,
	"relationship" text,
	"reason" text,
	"status" "removal_status" DEFAULT 'open' NOT NULL,
	"due_at" timestamp with time zone,
	"actioned_by" uuid,
	"actioned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"listing_id" uuid NOT NULL,
	"reason" "report_reason" NOT NULL,
	"detail" text,
	"reporter_email" text,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name_normalised" text NOT NULL,
	"postcode_normalised" text,
	"email" text,
	"phone" text,
	"reason" text,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"meta" jsonb,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "badges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"listing_id" uuid NOT NULL,
	"style" "badge_style" DEFAULT 'dark' NOT NULL,
	"snippet_html" text,
	"backlink_url" text,
	"backlink_verified" boolean DEFAULT false NOT NULL,
	"last_checked_at" timestamp with time zone,
	"impression_count" integer DEFAULT 0 NOT NULL,
	"click_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"job_name" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"error" text,
	"lock_key" text
);
--> statement-breakpoint
CREATE TABLE "listing_stats_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"listing_id" uuid NOT NULL,
	"day" date NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"enquiries" integer DEFAULT 0 NOT NULL,
	"shortlist_adds" integer DEFAULT 0 NOT NULL,
	"badge_clicks" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redirects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_path" text NOT NULL,
	"to_path" text NOT NULL,
	"status_code" integer DEFAULT 301 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"code" text NOT NULL,
	"commission_pct" numeric(5, 2),
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"year" integer NOT NULL,
	"city_id" uuid,
	"category_id" uuid,
	"listing_id" uuid NOT NULL,
	"rank" integer,
	"methodology_version" text,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "campaign_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"to_address" text NOT NULL,
	"magic_token" text,
	"sent_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"clicked_at" timestamp with time zone,
	"bounced_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"segment" jsonb,
	"channel" "campaign_channel" DEFAULT 'email' NOT NULL,
	"template_key" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"opened_count" integer DEFAULT 0 NOT NULL,
	"claimed_count" integer DEFAULT 0 NOT NULL,
	"converted_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"job_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"message" text
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"city_id" uuid,
	"category_id" uuid,
	"budget_min" numeric(10, 2),
	"budget_max" numeric(10, 2),
	"poster_email" text,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "price_data" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"service" text NOT NULL,
	"city_id" uuid,
	"low" numeric(10, 2),
	"median" numeric(10, 2),
	"high" numeric(10, 2),
	"sample_size" integer DEFAULT 0 NOT NULL,
	"currency" text,
	"methodology_note" text,
	"source_name" text,
	"source_url" text
);
--> statement-breakpoint
CREATE TABLE "quote_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"quote_request_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"contact_masked" boolean DEFAULT true NOT NULL,
	"opened_at" timestamp with time zone,
	"replied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "quote_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text,
	"email" text,
	"phone" text,
	"message" text,
	"city_id" uuid,
	"category_id" uuid,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"affiliate_id" uuid NOT NULL,
	"subscription_id" uuid,
	"amount" numeric(10, 2),
	"status" text DEFAULT 'pending' NOT NULL,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "review_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"listing_id" uuid NOT NULL,
	"token" text NOT NULL,
	"sent_to" text,
	"sent_at" timestamp with time zone,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "review_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"review_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"derivatives" jsonb,
	"alt" text
);
--> statement-breakpoint
CREATE TABLE "review_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"review_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"status" "review_status" DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"listing_id" uuid NOT NULL,
	"author_email" text NOT NULL,
	"author_display_name" text,
	"rating" integer NOT NULL,
	"sub_ratings" jsonb,
	"title" text,
	"body" text,
	"status" "review_status" DEFAULT 'pending' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"flagged_reason" text,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "shortlist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"shortlist_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"note" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shortlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"cookie_id" text,
	"name" text,
	"share_id" text NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unsubscribes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"address_normalised" text NOT NULL,
	"reason" text
);
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_vertical_id_verticals_id_fk" FOREIGN KEY ("vertical_id") REFERENCES "public"."verticals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_categories" ADD CONSTRAINT "listing_categories_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_categories" ADD CONSTRAINT "listing_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_images" ADD CONSTRAINT "listing_images_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_vertical_id_verticals_id_fk" FOREIGN KEY ("vertical_id") REFERENCES "public"."verticals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_primary_category_id_categories_id_fk" FOREIGN KEY ("primary_category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_checks" ADD CONSTRAINT "verification_checks_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "removal_requests" ADD CONSTRAINT "removal_requests_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badges" ADD CONSTRAINT "badges_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_stats_daily" ADD CONSTRAINT "listing_stats_daily_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_messages" ADD CONSTRAINT "campaign_messages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_messages" ADD CONSTRAINT "campaign_messages_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_data" ADD CONSTRAINT "price_data_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_recipients" ADD CONSTRAINT "quote_recipients_quote_request_id_quote_requests_id_fk" FOREIGN KEY ("quote_request_id") REFERENCES "public"."quote_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_recipients" ADD CONSTRAINT "quote_recipients_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_affiliate_id_affiliates_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_invites" ADD CONSTRAINT "review_invites_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_photos" ADD CONSTRAINT "review_photos_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlist_items" ADD CONSTRAINT "shortlist_items_shortlist_id_shortlists_id_fk" FOREIGN KEY ("shortlist_id") REFERENCES "public"."shortlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlist_items" ADD CONSTRAINT "shortlist_items_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "areas_slug_key" ON "areas" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_key" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "categories_vertical_idx" ON "categories" USING btree ("vertical_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cities_slug_key" ON "cities" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "cities_geo_idx" ON "cities" USING btree ("lat","lng");--> statement-breakpoint
CREATE INDEX "cities_indexable_idx" ON "cities" USING btree ("is_indexable");--> statement-breakpoint
CREATE UNIQUE INDEX "slugs_scope_slug_key" ON "slugs" USING btree ("parent_scope","slug");--> statement-breakpoint
CREATE INDEX "slugs_entity_idx" ON "slugs" USING btree ("kind","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verticals_slug_key" ON "verticals" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_categories_key" ON "listing_categories" USING btree ("listing_id","category_id");--> statement-breakpoint
CREATE INDEX "listing_images_listing_idx" ON "listing_images" USING btree ("listing_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "listings_city_slug_key" ON "listings" USING btree ("city_id","slug");--> statement-breakpoint
CREATE INDEX "listings_status_idx" ON "listings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "listings_city_status_idx" ON "listings" USING btree ("city_id","status");--> statement-breakpoint
CREATE INDEX "listings_vertical_status_idx" ON "listings" USING btree ("vertical_id","status");--> statement-breakpoint
CREATE INDEX "listings_category_status_idx" ON "listings" USING btree ("primary_category_id","status");--> statement-breakpoint
CREATE INDEX "listings_owner_idx" ON "listings" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "listings_geo_idx" ON "listings" USING btree ("lat","lng");--> statement-breakpoint
CREATE INDEX "claims_listing_idx" ON "claims" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "claims_status_idx" ON "claims" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_magic_token_key" ON "claims" USING btree ("magic_token");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_user_key" ON "profiles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_checks_listing_idx" ON "verification_checks" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "verification_checks_status_idx" ON "verification_checks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "coupon_redemptions_coupon_idx" ON "coupon_redemptions" USING btree ("coupon_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons" USING btree ("code");--> statement-breakpoint
CREATE INDEX "coupons_batch_idx" ON "coupons" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "processed_events_event_key" ON "processed_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "subscriptions_listing_idx" ON "subscriptions" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_sub_key" ON "subscriptions" USING btree ("provider_subscription_id");--> statement-breakpoint
CREATE INDEX "enquiries_listing_idx" ON "enquiries" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "removal_requests_status_idx" ON "removal_requests" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "reports_status_idx" ON "reports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "suppressions_name_postcode_idx" ON "suppressions" USING btree ("name_normalised","postcode_normalised");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "badges_listing_idx" ON "badges" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "job_runs_name_idx" ON "job_runs" USING btree ("job_name","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_stats_daily_key" ON "listing_stats_daily" USING btree ("listing_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "redirects_from_key" ON "redirects" USING btree ("from_path");--> statement-breakpoint
CREATE UNIQUE INDEX "affiliates_code_key" ON "affiliates" USING btree ("code");--> statement-breakpoint
CREATE INDEX "awards_year_idx" ON "awards" USING btree ("year","city_id","category_id");--> statement-breakpoint
CREATE INDEX "campaign_messages_campaign_idx" ON "campaign_messages" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_applications_key" ON "job_applications" USING btree ("job_id","listing_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "price_data_service_city_key" ON "price_data" USING btree ("service","city_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_recipients_key" ON "quote_recipients" USING btree ("quote_request_id","listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_invites_token_key" ON "review_invites" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "review_replies_review_key" ON "review_replies" USING btree ("review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_listing_author_key" ON "reviews" USING btree ("listing_id","author_email");--> statement-breakpoint
CREATE INDEX "reviews_status_idx" ON "reviews" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "shortlist_items_key" ON "shortlist_items" USING btree ("shortlist_id","listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shortlists_share_key" ON "shortlists" USING btree ("share_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unsubscribes_address_key" ON "unsubscribes" USING btree ("address_normalised");