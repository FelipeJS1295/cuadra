CREATE TABLE "retail_product_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"provider" varchar(20) NOT NULL,
	"seller_sku" varchar(120) NOT NULL,
	"changes" jsonb NOT NULL,
	"before" jsonb,
	"status" varchar(20) NOT NULL,
	"message" text,
	"reference" varchar(120),
	"created_by" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retail_api_products" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "retail_product_changes" ADD CONSTRAINT "retail_product_changes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retail_product_changes_sku_idx" ON "retail_product_changes" USING btree ("tenant_id","provider","seller_sku","created_at");--> statement-breakpoint
-- Aislamiento por empresa también para la tabla nueva
SELECT cuadra_enable_rls();
