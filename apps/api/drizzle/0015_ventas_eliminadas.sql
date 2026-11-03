CREATE TABLE "deleted_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"retailer_id" uuid NOT NULL,
	"order_number" varchar(80) NOT NULL,
	"other_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" jsonb,
	"deleted_by" uuid,
	"deleted_by_name" varchar(200),
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deleted_sales" ADD CONSTRAINT "deleted_sales_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deleted_sales" ADD CONSTRAINT "deleted_sales_retailer_id_retailers_id_fk" FOREIGN KEY ("retailer_id") REFERENCES "public"."retailers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deleted_sales_order_uq" ON "deleted_sales" USING btree ("tenant_id","retailer_id","order_number");--> statement-breakpoint
SELECT cuadra_enable_rls();
