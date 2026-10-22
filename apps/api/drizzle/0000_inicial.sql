CREATE TYPE "public"."channel_type" AS ENUM('department_store', 'supermarket', 'marketplace', 'ecommerce', 'other');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('DUENO', 'ADMIN', 'OPERADOR', 'LECTURA');--> statement-breakpoint
CREATE TABLE "retailers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"code" varchar(30) NOT NULL,
	"name" varchar(120) NOT NULL,
	"legal_name" varchar(200),
	"tax_id" varchar(20),
	"channel_type" "channel_type" DEFAULT 'department_store' NOT NULL,
	"commission_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"payment_days" integer DEFAULT 30 NOT NULL,
	"payment_base" varchar(20) DEFAULT 'ORDEN' NOT NULL,
	"contact" text,
	"commercial_terms" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"retailer_id" uuid NOT NULL,
	"external_item_id" varchar(50) NOT NULL,
	"seller_sku" varchar(60),
	"product_name" text,
	"order_date" date,
	"order_number" varchar(50),
	"order_id" varchar(50),
	"document_type" varchar(20),
	"status" varchar(50),
	"customer_name" varchar(200),
	"customer_email" varchar(200),
	"customer_document" varchar(20),
	"shipping_name" varchar(200),
	"shipping_address" text,
	"shipping_commune" varchar(100),
	"shipping_region" varchar(100),
	"billing_legal_name" varchar(200),
	"billing_tax_id" varchar(20),
	"billing_activity" varchar(200),
	"billing_address" text,
	"paid_price" numeric(14, 2),
	"unit_price" numeric(14, 2),
	"shipping_cost" numeric(14, 2),
	"tax_amount" numeric(14, 2),
	"commission_amount" numeric(14, 2),
	"discount_amount" numeric(14, 2),
	"amounts_include_tax" boolean DEFAULT true NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"carrier" varchar(100),
	"fulfillment" varchar(50),
	"tracking_code" varchar(100),
	"dispatch_deadline" date,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlement_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"retailer_id" uuid NOT NULL,
	"line_key" varchar(300) NOT NULL,
	"channel" varchar(30),
	"order_number" varchar(50),
	"sale_item_id" varchar(50),
	"seller_sku" varchar(60),
	"product_name" text,
	"transaction_type" text,
	"transaction_category" varchar(100),
	"kind" varchar(30) DEFAULT 'OTHER' NOT NULL,
	"transaction_date" date,
	"amount_net" numeric(14, 2),
	"tax_amount" numeric(14, 2),
	"amount_gross" numeric(14, 2),
	"commission_pct" numeric(5, 2),
	"payment_status" varchar(50),
	"statement_number" varchar(100),
	"payment_reference" varchar(100),
	"tax_document_number" varchar(50),
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_channel_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"retailer_id" uuid NOT NULL,
	"commission_pct" numeric(5, 2),
	"logistics_cost" numeric(14, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"sku_master" varchar(60) NOT NULL,
	"name" varchar(200) NOT NULL,
	"provisional_cost" numeric(14, 2) DEFAULT '0' NOT NULL,
	"profit_pct" numeric(5, 2) DEFAULT '20' NOT NULL,
	"returns_pct" numeric(5, 2) DEFAULT '5' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"sku" varchar(60) NOT NULL,
	"name" varchar(200) NOT NULL,
	"net_cost" numeric(14, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retailer_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"retailer_id" uuid NOT NULL,
	"retailer_sku" varchar(80) NOT NULL,
	"seller_sku" varchar(80),
	"name" varchar(300) NOT NULL,
	"list_price" numeric(14, 2),
	"offer_price" numeric(14, 2),
	"offer_from" date,
	"offer_to" date,
	"status" varchar(40),
	"stock" integer,
	"image_url" varchar(500),
	"product_id" uuid,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role" "user_role" DEFAULT 'LECTURA' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(160) NOT NULL,
	"name" varchar(120) NOT NULL,
	"password_hash" varchar(200) NOT NULL,
	"is_superadmin" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "customer_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"retailer_id" uuid NOT NULL,
	"order_number" varchar(50) NOT NULL,
	"receipt_number" varchar(50) NOT NULL,
	"total_gross" numeric(14, 2) NOT NULL,
	"document_type" integer DEFAULT 39 NOT NULL,
	"status" varchar(20) DEFAULT 'REGISTRADA' NOT NULL,
	"issued_at" date,
	"draft_code" varchar(40),
	"mipyme_code" varchar(40),
	"receptor" jsonb,
	"pdf_data" text,
	"pdf_url" text,
	"sii_response" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_document_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"retailer_id" uuid NOT NULL,
	"item_key" varchar(80) NOT NULL,
	"order_number" varchar(50),
	"product_name" text,
	"amount_net" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_document_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"paid_at" date NOT NULL,
	"method" varchar(40),
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"document_number" varchar(50) NOT NULL,
	"issue_date" date,
	"document_type" integer DEFAULT 33 NOT NULL,
	"sii_exempt" numeric(14, 2),
	"sii_net" numeric(14, 2),
	"sii_vat" numeric(14, 2),
	"sii_total" numeric(14, 2),
	"sii_status" varchar(20),
	"sii_imported_at" timestamp with time zone,
	"sii_data" jsonb,
	"retailer_id" uuid,
	"mipyme_code" varchar(40),
	"sii_items" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"tax_id" varchar(12),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"retailer_id" uuid NOT NULL,
	"order_number" varchar(50) NOT NULL,
	"receipt_id" uuid,
	"receipt_number" varchar(50) NOT NULL,
	"receipt_type" integer DEFAULT 39 NOT NULL,
	"receipt_date" date,
	"ref_code" integer DEFAULT 1 NOT NULL,
	"reason" varchar(90) NOT NULL,
	"amount_gross" numeric(14, 2) NOT NULL,
	"status" varchar(20) DEFAULT 'BORRADOR' NOT NULL,
	"draft_code" varchar(40),
	"mipyme_code" varchar(40),
	"folio" varchar(30),
	"issued_at" date,
	"sii_response" jsonb,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatch_guides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"guide_date" date NOT NULL,
	"transfer_type" integer DEFAULT 5 NOT NULL,
	"receptor_rut" varchar(12) NOT NULL,
	"receptor_name" varchar(100) NOT NULL,
	"receptor_activity" varchar(40),
	"address" varchar(70),
	"commune" varchar(20),
	"items" jsonb NOT NULL,
	"total_gross" numeric(14, 2) DEFAULT '0' NOT NULL,
	"reference" varchar(80),
	"status" varchar(20) DEFAULT 'BORRADOR' NOT NULL,
	"draft_code" varchar(40),
	"folio" varchar(30),
	"issued_at" date,
	"mipyme_code" varchar(40),
	"sii_response" jsonb,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"retailer_id" uuid NOT NULL,
	"order_number" varchar(50) NOT NULL,
	"requested_at" date NOT NULL,
	"scope" varchar(10) DEFAULT 'TOTAL' NOT NULL,
	"reason" varchar(200) NOT NULL,
	"status" varchar(20) DEFAULT 'SOLICITADA' NOT NULL,
	"received_at" date,
	"product_condition" varchar(20),
	"refund_gross" numeric(14, 2),
	"reverse_logistics_cost" numeric(14, 2),
	"supplier_action" varchar(20) DEFAULT 'NINGUNA' NOT NULL,
	"supplier_credit_gross" numeric(14, 2),
	"tracking_code" varchar(80),
	"notes" text,
	"credit_note_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retail_api_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"provider" varchar(20) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" text,
	"status" varchar(20) DEFAULT 'SIN_PROBAR' NOT NULL,
	"last_error" text,
	"last_test_at" timestamp with time zone,
	"last_orders_sync_at" timestamp with time zone,
	"last_products_sync_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retail_api_order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"external_item_id" varchar(80) NOT NULL,
	"seller_sku" varchar(120),
	"retailer_sku" varchar(120),
	"name" varchar(300),
	"quantity" numeric(12, 2) DEFAULT '1' NOT NULL,
	"unit_price" numeric(14, 2),
	"paid_price" numeric(14, 2),
	"shipping_amount" numeric(14, 2),
	"status" varchar(60),
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "retail_api_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"provider" varchar(20) NOT NULL,
	"external_id" varchar(80) NOT NULL,
	"order_number" varchar(80),
	"customer_order_id" varchar(80),
	"order_date" timestamp with time zone,
	"status" varchar(60),
	"customer_name" varchar(200),
	"customer_rut" varchar(20),
	"customer_email" varchar(200),
	"address" varchar(300),
	"commune" varchar(120),
	"region" varchar(120),
	"total" numeric(14, 2),
	"shipping_total" numeric(14, 2),
	"items_count" integer DEFAULT 0 NOT NULL,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retail_api_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"provider" varchar(20) NOT NULL,
	"seller_sku" varchar(120) NOT NULL,
	"retailer_sku" varchar(120),
	"name" varchar(300),
	"brand" varchar(120),
	"price" numeric(14, 2),
	"sale_price" numeric(14, 2),
	"stock" integer,
	"status" varchar(60),
	"url" varchar(500),
	"image_url" varchar(500),
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"user_id" uuid,
	"action" varchar(80) NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_settings" (
	"tenant_id" uuid PRIMARY KEY DEFAULT (current_setting('app.tenant_id'))::uuid NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"legal_name" varchar(200),
	"tax_id" varchar(12),
	"plan" varchar(20) DEFAULT 'PRUEBA' NOT NULL,
	"status" varchar(20) DEFAULT 'ACTIVA' NOT NULL,
	"trial_ends_at" date,
	"onboarding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retailers" ADD CONSTRAINT "retailers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_records" ADD CONSTRAINT "sales_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_records" ADD CONSTRAINT "sales_records_retailer_id_retailers_id_fk" FOREIGN KEY ("retailer_id") REFERENCES "public"."retailers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_records" ADD CONSTRAINT "settlement_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_records" ADD CONSTRAINT "settlement_records_retailer_id_retailers_id_fk" FOREIGN KEY ("retailer_id") REFERENCES "public"."retailers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_channel_costs" ADD CONSTRAINT "product_channel_costs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_channel_costs" ADD CONSTRAINT "product_channel_costs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_channel_costs" ADD CONSTRAINT "product_channel_costs_retailer_id_retailers_id_fk" FOREIGN KEY ("retailer_id") REFERENCES "public"."retailers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplies" ADD CONSTRAINT "supplies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retailer_products" ADD CONSTRAINT "retailer_products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retailer_products" ADD CONSTRAINT "retailer_products_retailer_id_retailers_id_fk" FOREIGN KEY ("retailer_id") REFERENCES "public"."retailers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retailer_products" ADD CONSTRAINT "retailer_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_retailer_id_retailers_id_fk" FOREIGN KEY ("retailer_id") REFERENCES "public"."retailers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_document_lines" ADD CONSTRAINT "purchase_document_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_document_lines" ADD CONSTRAINT "purchase_document_lines_document_id_purchase_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."purchase_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_document_lines" ADD CONSTRAINT "purchase_document_lines_retailer_id_retailers_id_fk" FOREIGN KEY ("retailer_id") REFERENCES "public"."retailers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_document_payments" ADD CONSTRAINT "purchase_document_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_document_payments" ADD CONSTRAINT "purchase_document_payments_document_id_purchase_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."purchase_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_document_payments" ADD CONSTRAINT "purchase_document_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_documents" ADD CONSTRAINT "purchase_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_documents" ADD CONSTRAINT "purchase_documents_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_documents" ADD CONSTRAINT "purchase_documents_retailer_id_retailers_id_fk" FOREIGN KEY ("retailer_id") REFERENCES "public"."retailers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_documents" ADD CONSTRAINT "purchase_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_retailer_id_retailers_id_fk" FOREIGN KEY ("retailer_id") REFERENCES "public"."retailers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_receipt_id_customer_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."customer_receipts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_guides" ADD CONSTRAINT "dispatch_guides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_guides" ADD CONSTRAINT "dispatch_guides_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_returns" ADD CONSTRAINT "product_returns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_returns" ADD CONSTRAINT "product_returns_retailer_id_retailers_id_fk" FOREIGN KEY ("retailer_id") REFERENCES "public"."retailers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_returns" ADD CONSTRAINT "product_returns_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_returns" ADD CONSTRAINT "product_returns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_api_connections" ADD CONSTRAINT "retail_api_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_api_order_items" ADD CONSTRAINT "retail_api_order_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_api_order_items" ADD CONSTRAINT "retail_api_order_items_order_id_retail_api_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."retail_api_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_api_orders" ADD CONSTRAINT "retail_api_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_api_products" ADD CONSTRAINT "retail_api_products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retailers_tenant_code_uq" ON "retailers" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_records_retailer_item_uq" ON "sales_records" USING btree ("retailer_id","external_item_id");--> statement-breakpoint
CREATE INDEX "sales_records_order_date_idx" ON "sales_records" USING btree ("order_date");--> statement-breakpoint
CREATE INDEX "sales_records_order_number_idx" ON "sales_records" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "sales_records_seller_sku_idx" ON "sales_records" USING btree ("seller_sku");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_records_retailer_line_uq" ON "settlement_records" USING btree ("retailer_id","line_key");--> statement-breakpoint
CREATE INDEX "settlement_records_sale_item_idx" ON "settlement_records" USING btree ("retailer_id","sale_item_id");--> statement-breakpoint
CREATE INDEX "settlement_records_order_number_idx" ON "settlement_records" USING btree ("order_number");--> statement-breakpoint
CREATE UNIQUE INDEX "product_channel_costs_uq" ON "product_channel_costs" USING btree ("product_id","retailer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_sku_uq" ON "products" USING btree ("tenant_id","sku_master");--> statement-breakpoint
CREATE UNIQUE INDEX "supplies_tenant_sku_uq" ON "supplies" USING btree ("tenant_id","sku");--> statement-breakpoint
CREATE UNIQUE INDEX "retailer_products_retailer_sku_uq" ON "retailer_products" USING btree ("retailer_id","retailer_sku");--> statement-breakpoint
CREATE INDEX "retailer_products_seller_sku_idx" ON "retailer_products" USING btree ("seller_sku");--> statement-breakpoint
CREATE INDEX "retailer_products_product_idx" ON "retailer_products" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_tenant_uq" ON "memberships" USING btree ("user_id","tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_receipts_order_uq" ON "customer_receipts" USING btree ("retailer_id","order_number");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_document_lines_uq" ON "purchase_document_lines" USING btree ("document_id","retailer_id","item_key");--> statement-breakpoint
CREATE INDEX "purchase_document_lines_item_idx" ON "purchase_document_lines" USING btree ("retailer_id","item_key");--> statement-breakpoint
CREATE INDEX "purchase_document_payments_document_idx" ON "purchase_document_payments" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_documents_supplier_number_uq" ON "purchase_documents" USING btree ("supplier_id","document_type","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_name_uq" ON "suppliers" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_tax_id_uq" ON "suppliers" USING btree ("tenant_id","tax_id") WHERE "suppliers"."tax_id" is not null;--> statement-breakpoint
CREATE INDEX "credit_notes_order_idx" ON "credit_notes" USING btree ("retailer_id","order_number");--> statement-breakpoint
CREATE INDEX "dispatch_guides_date_idx" ON "dispatch_guides" USING btree ("guide_date");--> statement-breakpoint
CREATE INDEX "product_returns_order_idx" ON "product_returns" USING btree ("retailer_id","order_number");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_api_connections_uq" ON "retail_api_connections" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_api_order_items_uq" ON "retail_api_order_items" USING btree ("order_id","external_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_api_orders_uq" ON "retail_api_orders" USING btree ("tenant_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "retail_api_orders_date_idx" ON "retail_api_orders" USING btree ("order_date");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_api_products_uq" ON "retail_api_products" USING btree ("tenant_id","provider","seller_sku");