DO $$ BEGIN
	CREATE TYPE "public"."saved_search_kind" AS ENUM('listings', 'jobs');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."saved_search_frequency" AS ENUM('daily', 'weekly');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "saved_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "saved_search_kind" NOT NULL,
	"params" jsonb NOT NULL,
	"params_hash" text NOT NULL,
	"label" text NOT NULL,
	"frequency" "saved_search_frequency" DEFAULT 'weekly' NOT NULL,
	"last_sent_at" timestamp with time zone,
	"last_seen_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "saved_searches_user_kind_params_key" ON "saved_searches" USING btree ("user_id","kind","params_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_searches_active_idx" ON "saved_searches" USING btree ("last_sent_at") WHERE "saved_searches"."is_active";
