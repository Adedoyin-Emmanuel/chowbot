ALTER TABLE "order_submissions" DROP CONSTRAINT "order_submissions_state_check";--> statement-breakpoint
ALTER TABLE "order_submissions" DROP CONSTRAINT "order_submissions_failure_reason_check";--> statement-breakpoint
ALTER TABLE "order_submissions" DROP CONSTRAINT "order_submissions_resolution_check";--> statement-breakpoint
ALTER TABLE "order_submissions" DROP CONSTRAINT "order_submissions_order_id_check";--> statement-breakpoint
ALTER TABLE "order_submissions" DROP CONSTRAINT "order_submissions_marker_check";--> statement-breakpoint
ALTER TABLE "order_submissions" ADD COLUMN "promo_code" text;--> statement-breakpoint
ALTER TABLE "order_submissions" ADD COLUMN "promo_discount" bigint;--> statement-breakpoint
ALTER TABLE "order_submissions" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_submissions" ADD COLUMN "cancel_request_state" text;--> statement-breakpoint
ALTER TABLE "order_submissions" ADD CONSTRAINT "order_submissions_promo_check" CHECK (("order_submissions"."promo_code" IS NULL) = ("order_submissions"."promo_discount" IS NULL) AND ("order_submissions"."promo_discount" IS NULL OR "order_submissions"."promo_discount" > 0));--> statement-breakpoint
ALTER TABLE "order_submissions" ADD CONSTRAINT "order_submissions_cancel_request_check" CHECK (("order_submissions"."cancel_requested_at" IS NULL OR "order_submissions"."chowdeck_order_id" IS NOT NULL)
        AND ("order_submissions"."cancel_request_state" IS NULL OR "order_submissions"."cancel_requested_at" IS NOT NULL)
        AND ("order_submissions"."cancel_request_state" IS NULL OR "order_submissions"."cancel_request_state" IN ('accepted', 'rejected', 'unknown')));--> statement-breakpoint
ALTER TABLE "order_submissions" ADD CONSTRAINT "order_submissions_state_check" CHECK ("order_submissions"."state" IN ('quoted', 'confirmation_pending', 'submitting', 'created', 'unknown', 'failed', 'paid', 'released', 'cancelled'));--> statement-breakpoint
ALTER TABLE "order_submissions" ADD CONSTRAINT "order_submissions_failure_reason_check" CHECK (("order_submissions"."state" = 'failed') = ("order_submissions"."failure_reason" IS NOT NULL) AND ("order_submissions"."failure_reason" IS NULL OR "order_submissions"."failure_reason" IN ('gate_rejected', 'gate_uncertain', 'order_rejected', 'not_sent', 'superseded')));--> statement-breakpoint
ALTER TABLE "order_submissions" ADD CONSTRAINT "order_submissions_resolution_check" CHECK ("order_submissions"."resolution" IS NULL OR "order_submissions"."resolution" IN ('paid_verified', 'linked_user_supplied_order', 'cancelled_verified'));--> statement-breakpoint
ALTER TABLE "order_submissions" ADD CONSTRAINT "order_submissions_order_id_check" CHECK ("order_submissions"."state" NOT IN ('created', 'paid', 'cancelled') OR "order_submissions"."chowdeck_order_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "order_submissions" ADD CONSTRAINT "order_submissions_marker_check" CHECK (("order_submissions"."state" NOT IN ('quoted', 'confirmation_pending') OR "order_submissions"."order_request_started_at" IS NULL)
        AND ("order_submissions"."state" NOT IN ('created', 'unknown', 'paid', 'cancelled') OR "order_submissions"."order_request_started_at" IS NOT NULL)
        AND ("order_submissions"."failure_reason" IS NULL OR "order_submissions"."failure_reason" NOT IN ('gate_rejected', 'gate_uncertain', 'not_sent', 'superseded') OR "order_submissions"."order_request_started_at" IS NULL)
        AND ("order_submissions"."failure_reason" IS NULL OR "order_submissions"."failure_reason" <> 'order_rejected' OR "order_submissions"."order_request_started_at" IS NOT NULL));