CREATE TABLE "user_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"company_id" uuid,
	"kind" varchar(20) NOT NULL,
	"description" text NOT NULL,
	"method" varchar(10),
	"path" varchar(300),
	"status" integer,
	"ip" varchar(60),
	"user_agent" varchar(300),
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_activity" ADD CONSTRAINT "user_activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_activity" ADD CONSTRAINT "user_activity_company_id_tenants_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_activity_created_idx" ON "user_activity" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "user_activity_user_idx" ON "user_activity" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "user_activity_company_idx" ON "user_activity" USING btree ("company_id","created_at");--> statement-breakpoint
-- Solo la lee el administrador del sistema (no las empresas)
REVOKE ALL ON "user_activity" FROM cuadra_app;
