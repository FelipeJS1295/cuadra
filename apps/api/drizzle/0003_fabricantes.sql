CREATE TABLE "product_supplies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"supply_id" uuid NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supplies" ADD COLUMN "unit" varchar(20) DEFAULT 'unidad' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "business_mode" varchar(20) DEFAULT 'REVENDEDOR' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_supplies" ADD CONSTRAINT "product_supplies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_supplies" ADD CONSTRAINT "product_supplies_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_supplies" ADD CONSTRAINT "product_supplies_supply_id_supplies_id_fk" FOREIGN KEY ("supply_id") REFERENCES "public"."supplies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_supplies_uq" ON "product_supplies" USING btree ("product_id","supply_id");--> statement-breakpoint
CREATE INDEX "product_supplies_supply_idx" ON "product_supplies" USING btree ("supply_id");--> statement-breakpoint
-- Aislamiento por empresa también para la tabla nueva
SELECT cuadra_enable_rls();
