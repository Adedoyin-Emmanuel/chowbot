CREATE TABLE "admin_operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"credential_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "admin_operators_name_unique" UNIQUE("name"),
	CONSTRAINT "admin_operators_name_check" CHECK ("admin_operators"."name" ~ '^[a-z0-9][a-z0-9._-]{1,62}$')
);
--> statement-breakpoint
CREATE TABLE "order_submission_recoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"note" text NOT NULL,
	"attempt_snapshot" jsonb NOT NULL,
	"lookup_outcome" text NOT NULL,
	"lookup_order_status" text,
	"lookup_payment_status" text,
	"lookup_error" text,
	"duplicate_risk_acknowledged" boolean NOT NULL,
	"disclosure" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_submission_recoveries_reason_check" CHECK ("order_submission_recoveries"."reason_code" IN ('user_reported_no_order', 'user_accepts_duplicate_risk', 'order_not_retrievable', 'user_reported_abandoned', 'user_reported_cancelled_in_app')),
	CONSTRAINT "order_submission_recoveries_lookup_check" CHECK ("order_submission_recoveries"."lookup_outcome" IN ('unpaid', 'failed', 'not_applicable')
        AND ("order_submission_recoveries"."lookup_outcome" = 'failed') = ("order_submission_recoveries"."lookup_error" IS NOT NULL)
        AND ("order_submission_recoveries"."reason_code" <> 'order_not_retrievable' OR "order_submission_recoveries"."lookup_outcome" = 'failed')),
	CONSTRAINT "order_submission_recoveries_note_check" CHECK (char_length(btrim("order_submission_recoveries"."note")) BETWEEN 10 AND 2000),
	CONSTRAINT "order_submission_recoveries_acknowledged_check" CHECK ("order_submission_recoveries"."duplicate_risk_acknowledged" = true),
	CONSTRAINT "order_submission_recoveries_snapshot_check" CHECK (jsonb_typeof("order_submission_recoveries"."attempt_snapshot") = 'object'),
	CONSTRAINT "order_submission_recoveries_disclosure_check" CHECK (char_length("order_submission_recoveries"."disclosure") > 0)
);
--> statement-breakpoint
ALTER TABLE "order_submissions" DROP CONSTRAINT "order_submissions_lock_release_check";--> statement-breakpoint
ALTER TABLE "order_submission_recoveries" ADD CONSTRAINT "order_submission_recoveries_submission_id_order_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."order_submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_submission_recoveries" ADD CONSTRAINT "order_submission_recoveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_submission_recoveries" ADD CONSTRAINT "order_submission_recoveries_operator_id_admin_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."admin_operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_submission_recoveries_one_per_attempt_idx" ON "order_submission_recoveries" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "order_submission_recoveries_user_id_idx" ON "order_submission_recoveries" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "order_submissions" ADD CONSTRAINT "order_submissions_lock_release_check" CHECK (("order_submissions"."lock_released_at" IS NULL) = ("order_submissions"."lock_release_reason" IS NULL) AND ("order_submissions"."lock_release_reason" IS NULL OR "order_submissions"."lock_release_reason" IN ('cart_changed', 'operator_released')));--> statement-breakpoint
CREATE FUNCTION "order_submission_recoveries_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order_submission_recoveries is append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "order_submission_recoveries_no_update_or_delete" BEFORE UPDATE OR DELETE ON "order_submission_recoveries" FOR EACH ROW EXECUTE FUNCTION "order_submission_recoveries_append_only"();--> statement-breakpoint
CREATE TRIGGER "order_submission_recoveries_no_truncate" BEFORE TRUNCATE ON "order_submission_recoveries" FOR EACH STATEMENT EXECUTE FUNCTION "order_submission_recoveries_append_only"();
