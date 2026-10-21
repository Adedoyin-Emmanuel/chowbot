CREATE TABLE "order_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"vendor_id" integer NOT NULL,
	"cart_id" bigint NOT NULL,
	"fee_id" bigint NOT NULL,
	"address_binding" text NOT NULL,
	"cart_fingerprint" text NOT NULL,
	"computed_total" bigint NOT NULL,
	"quote_expires_at" timestamp with time zone NOT NULL,
	"payment_method_id" bigint,
	"payment_channel_name" text,
	"confirmation_nonce_hash" text,
	"confirmation_expires_at" timestamp with time zone,
	"confirmation_consumed_at" timestamp with time zone,
	"state" text NOT NULL,
	"failure_reason" text,
	"resolution" text,
	"chowdeck_order_id" bigint,
	"lock_released_at" timestamp with time zone,
	"lock_release_reason" text,
	"payment_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "order_submissions_state_check" CHECK ("order_submissions"."state" IN ('quoted', 'confirmation_pending', 'submitting', 'created', 'unknown', 'failed', 'paid', 'released')),
	CONSTRAINT "order_submissions_ids_check" CHECK ("order_submissions"."vendor_id" > 0 AND "order_submissions"."cart_id" > 0 AND "order_submissions"."fee_id" > 0),
	CONSTRAINT "order_submissions_computed_total_check" CHECK ("order_submissions"."computed_total" > 0),
	CONSTRAINT "order_submissions_failure_reason_check" CHECK (("order_submissions"."state" = 'failed') = ("order_submissions"."failure_reason" IS NOT NULL) AND ("order_submissions"."failure_reason" IS NULL OR "order_submissions"."failure_reason" IN ('gate_rejected', 'gate_uncertain', 'order_rejected'))),
	CONSTRAINT "order_submissions_resolution_check" CHECK ("order_submissions"."resolution" IS NULL OR "order_submissions"."resolution" IN ('paid_verified')),
	CONSTRAINT "order_submissions_lock_release_check" CHECK (("order_submissions"."lock_released_at" IS NULL) = ("order_submissions"."lock_release_reason" IS NULL) AND ("order_submissions"."lock_release_reason" IS NULL OR "order_submissions"."lock_release_reason" IN ('cart_changed'))),
	CONSTRAINT "order_submissions_confirmation_pending_check" CHECK ("order_submissions"."state" <> 'confirmation_pending' OR ("order_submissions"."payment_method_id" IS NOT NULL AND "order_submissions"."confirmation_nonce_hash" IS NOT NULL AND "order_submissions"."confirmation_expires_at" IS NOT NULL)),
	CONSTRAINT "order_submissions_confirmation_expiry_check" CHECK ("order_submissions"."confirmation_expires_at" IS NULL OR "order_submissions"."confirmation_expires_at" <= "order_submissions"."quote_expires_at"),
	CONSTRAINT "order_submissions_consumed_check" CHECK ("order_submissions"."state" NOT IN ('submitting', 'created', 'unknown', 'paid') OR "order_submissions"."confirmation_consumed_at" IS NOT NULL),
	CONSTRAINT "order_submissions_order_id_check" CHECK ("order_submissions"."state" NOT IN ('created', 'paid') OR "order_submissions"."chowdeck_order_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "order_submissions" ADD CONSTRAINT "order_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_submissions_one_lock_per_cart_idx" ON "order_submissions" USING btree ("user_id","cart_id") WHERE "order_submissions"."lock_released_at" IS NULL AND "order_submissions"."state" IN ('submitting', 'created', 'unknown', 'paid');--> statement-breakpoint
CREATE INDEX "order_submissions_user_id_idx" ON "order_submissions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "order_submissions_quote_expires_at_idx" ON "order_submissions" USING btree ("quote_expires_at");