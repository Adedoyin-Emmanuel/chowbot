-- Chowdeck is the source of truth for orders; only authentication data stays.
-- The recovery audit references the other two tables, so it goes first. Its
-- append-only triggers block UPDATE, DELETE and TRUNCATE, not DROP.
DROP TABLE "order_submission_recoveries" CASCADE;--> statement-breakpoint
DROP TABLE "order_submissions" CASCADE;--> statement-breakpoint
DROP TABLE "admin_operators" CASCADE;--> statement-breakpoint
DROP FUNCTION "order_submission_recoveries_append_only"();
