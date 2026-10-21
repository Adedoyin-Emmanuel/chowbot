ALTER TABLE "order_submissions" ADD COLUMN "payment_start_state" text;--> statement-breakpoint
ALTER TABLE "order_submissions" ADD CONSTRAINT "order_submissions_payment_start_check" CHECK (("order_submissions"."payment_started_at" IS NULL OR "order_submissions"."chowdeck_order_id" IS NOT NULL)
        AND ("order_submissions"."payment_start_state" IS NULL OR "order_submissions"."payment_started_at" IS NOT NULL)
        AND ("order_submissions"."payment_start_state" IS NULL OR "order_submissions"."payment_start_state" IN ('started', 'rejected', 'unknown')));