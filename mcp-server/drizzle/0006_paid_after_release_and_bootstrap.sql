ALTER TABLE "admin_operators" ADD COLUMN "bootstrap" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order_submissions" ADD COLUMN "paid_after_release_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_submissions" ADD COLUMN "paid_after_release_order_status" text;--> statement-breakpoint
ALTER TABLE "order_submissions" ADD COLUMN "paid_after_release_payment_status" text;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_operators_one_bootstrap_idx" ON "admin_operators" USING btree ("bootstrap") WHERE "admin_operators"."bootstrap";--> statement-breakpoint
ALTER TABLE "order_submissions" ADD CONSTRAINT "order_submissions_paid_after_release_check" CHECK ("order_submissions"."paid_after_release_at" IS NULL OR ("order_submissions"."state" = 'created' AND "order_submissions"."chowdeck_order_id" IS NOT NULL AND "order_submissions"."lock_release_reason" = 'operator_released'));