ALTER TABLE "customer_receipts" ADD COLUMN "retail_status" varchar(20);--> statement-breakpoint
ALTER TABLE "customer_receipts" ADD COLUMN "retail_message" text;--> statement-breakpoint
ALTER TABLE "customer_receipts" ADD COLUMN "retail_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_receipts" ADD COLUMN "retail_ref" varchar(80);