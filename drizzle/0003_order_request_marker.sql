ALTER TABLE "order_submissions" DROP CONSTRAINT "order_submissions_failure_reason_check";--> statement-breakpoint
ALTER TABLE "order_submissions" DROP CONSTRAINT "order_submissions_resolution_check";--> statement-breakpoint
ALTER TABLE "order_submissions" ADD COLUMN "order_request_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_submissions" ADD COLUMN "evidence_order_status" text;--> statement-breakpoint
ALTER TABLE "order_submissions" ADD COLUMN "evidence_payment_status" text;--> statement-breakpoint
ALTER TABLE "order_submissions" ADD COLUMN "evidence_checked_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "order_submissions_chowdeck_order_id_idx" ON "order_submissions" USING btree ("chowdeck_order_id") WHERE "order_submissions"."chowdeck_order_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "order_submissions" ADD CONSTRAINT "order_submissions_marker_check" CHECK (("order_submissions"."state" NOT IN ('quoted', 'confirmation_pending') OR "order_submissions"."order_request_started_at" IS NULL)
        AND ("order_submissions"."state" NOT IN ('created', 'unknown', 'paid') OR "order_submissions"."order_request_started_at" IS NOT NULL)
        AND ("order_submissions"."failure_reason" IS NULL OR "order_submissions"."failure_reason" NOT IN ('gate_rejected', 'gate_uncertain', 'not_sent') OR "order_submissions"."order_request_started_at" IS NULL)
        AND ("order_submissions"."failure_reason" IS NULL OR "order_submissions"."failure_reason" <> 'order_rejected' OR "order_submissions"."order_request_started_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "order_submissions" ADD CONSTRAINT "order_submissions_failure_reason_check" CHECK (("order_submissions"."state" = 'failed') = ("order_submissions"."failure_reason" IS NOT NULL) AND ("order_submissions"."failure_reason" IS NULL OR "order_submissions"."failure_reason" IN ('gate_rejected', 'gate_uncertain', 'order_rejected', 'not_sent')));--> statement-breakpoint
ALTER TABLE "order_submissions" ADD CONSTRAINT "order_submissions_resolution_check" CHECK ("order_submissions"."resolution" IS NULL OR "order_submissions"."resolution" IN ('paid_verified', 'linked_user_supplied_order'));