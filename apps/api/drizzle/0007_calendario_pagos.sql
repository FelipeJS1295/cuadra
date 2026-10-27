ALTER TABLE "retailers" ADD COLUMN "payment_rule" varchar(20) DEFAULT 'DIAS' NOT NULL;--> statement-breakpoint
ALTER TABLE "retailers" ADD COLUMN "payment_weekday" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_records" ADD COLUMN "delivered_at" date;--> statement-breakpoint
-- Cómo paga cada retailer (lo que informó la empresa): Walmart quincenal, Falabella 8 días hábiles
-- después de la entrega, Paris los miércoles lo entregado la semana anterior
UPDATE "retailers" SET "payment_rule" = 'QUINCENAL', "payment_days" = 7 WHERE "code" = 'WALMART' AND "payment_rule" = 'DIAS';--> statement-breakpoint
UPDATE "retailers" SET "payment_rule" = 'HABILES_ENTREGA', "payment_days" = 8 WHERE "code" = 'FALABELLA' AND "payment_rule" = 'DIAS';--> statement-breakpoint
UPDATE "retailers" SET "payment_rule" = 'SEMANAL', "payment_weekday" = 3, "payment_days" = 0 WHERE "code" = 'CENCOSUD' AND "payment_rule" = 'DIAS';--> statement-breakpoint
-- Fecha de entrega de las ventas de Paris ya traídas por API (viene en la sub-orden)
UPDATE "sales_records" s SET "delivered_at" = (x.arrival::timestamptz AT TIME ZONE 'America/Santiago')::date
FROM (
  SELECT o.tenant_id, so->>'subOrderNumber' AS sub_no, so->>'effectiveArrivalDate' AS arrival
  FROM "retail_api_orders" o
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.raw->'subOrders') = 'array' THEN o.raw->'subOrders' ELSE '[]'::jsonb END) so
  WHERE o.provider = 'CENCOSUD' AND so->>'effectiveArrivalDate' ~ '^\d{4}-\d{2}-\d{2}'
) x, "retailers" r
WHERE r.id = s.retailer_id AND r.code = 'CENCOSUD' AND r.tenant_id = x.tenant_id AND s.order_number = x.sub_no AND s.delivered_at IS NULL;--> statement-breakpoint
-- Falabella por API: la fecha de la última actualización de un producto entregado es su entrega
UPDATE "sales_records" s SET "delivered_at" = (s.raw->'item'->>'UpdatedAt')::timestamp::date
FROM "retailers" r
WHERE r.id = s.retailer_id AND r.code = 'FALABELLA' AND s.delivered_at IS NULL
  AND s.raw->>'__origen' = 'API' AND coalesce(s.status, '') ~* 'deliver|entregad'
  AND s.raw->'item'->>'UpdatedAt' ~ '^\d{4}-\d{2}-\d{2}';
