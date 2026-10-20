CREATE TABLE "oauth_refresh_token_families" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_refresh_token_families_scopes_check" CHECK (jsonb_typeof("oauth_refresh_token_families"."scopes") = 'array')
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"family_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN "refresh_family_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token_families" ADD CONSTRAINT "oauth_refresh_token_families_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token_families" ADD CONSTRAINT "oauth_refresh_token_families_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_family_id_oauth_refresh_token_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."oauth_refresh_token_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_families_user_id_idx" ON "oauth_refresh_token_families" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_families_expires_at_idx" ON "oauth_refresh_token_families" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_family_id_idx" ON "oauth_refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_refresh_tokens_one_active_per_family_idx" ON "oauth_refresh_tokens" USING btree ("family_id") WHERE "oauth_refresh_tokens"."rotated_at" IS NULL;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_refresh_family_id_oauth_refresh_token_families_id_fk" FOREIGN KEY ("refresh_family_id") REFERENCES "public"."oauth_refresh_token_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_refresh_family_id_idx" ON "oauth_access_tokens" USING btree ("refresh_family_id");