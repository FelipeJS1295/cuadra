CREATE TABLE "retail_sku_names" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"provider" varchar(20) NOT NULL,
	"seller_sku" varchar(120) NOT NULL,
	"parent_sku" varchar(80) NOT NULL,
	"name" varchar(300) NOT NULL,
	"updated_by" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retail_sku_names" ADD CONSTRAINT "retail_sku_names_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retail_sku_names_uq" ON "retail_sku_names" USING btree ("tenant_id","provider","seller_sku");--> statement-breakpoint
CREATE INDEX "retail_sku_names_parent_idx" ON "retail_sku_names" USING btree ("tenant_id","parent_sku");--> statement-breakpoint
-- Aislamiento por empresa también para la tabla nueva
SELECT cuadra_enable_rls();
