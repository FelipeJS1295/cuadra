-- Fecha en que hay que entregar al courier (Maestra de despachos), para las ventas ya traídas por API.
-- Paris: "dispatchDate" y "carrier" de cada sub-orden
WITH x AS (
  SELECT o.tenant_id, so->>'subOrderNumber' AS sub_no, so->>'dispatchDate' AS dispatch, nullif(so->>'carrier', '') AS carrier
  FROM "retail_api_orders" o
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.raw->'subOrders') = 'array' THEN o.raw->'subOrders' ELSE '[]'::jsonb END) so
  WHERE o.provider = 'CENCOSUD'
)
UPDATE "sales_records" s
SET "dispatch_deadline" = coalesce(s.dispatch_deadline, CASE WHEN x.dispatch ~ '^\d{4}-\d{2}-\d{2}' THEN left(x.dispatch, 10)::date END),
    "carrier" = coalesce(nullif(s.carrier, ''), left(x.carrier, 100))
FROM x, "retailers" r
WHERE r.id = s.retailer_id AND r.code = 'CENCOSUD' AND r.tenant_id = x.tenant_id AND s.order_number = x.sub_no;--> statement-breakpoint
-- Falabella: "PromisedShippingTime" de la orden
UPDATE "sales_records" s SET "dispatch_deadline" = left(o.raw->>'PromisedShippingTime', 10)::date
FROM "retail_api_orders" o, "retailers" r
WHERE r.id = s.retailer_id AND r.code = 'FALABELLA' AND o.provider = 'FALABELLA' AND o.tenant_id = r.tenant_id
  AND s.dispatch_deadline IS NULL AND o.raw->>'PromisedShippingTime' ~ '^\d{4}-\d{2}-\d{2}'
  AND (s.order_number IN (o.order_number, o.customer_order_id) OR s.order_id IN (o.order_number, o.customer_order_id));--> statement-breakpoint
-- Walmart: "shippingInfo.estimatedShipDate" (milisegundos, medianoche UTC del día de despacho)
UPDATE "sales_records" s SET "dispatch_deadline" = (to_timestamp((o.raw->'shippingInfo'->>'estimatedShipDate')::bigint / 1000) AT TIME ZONE 'UTC')::date
FROM "retail_api_orders" o, "retailers" r
WHERE r.id = s.retailer_id AND r.code = 'WALMART' AND o.provider = 'WALMART' AND o.tenant_id = r.tenant_id
  AND s.dispatch_deadline IS NULL AND o.raw->'shippingInfo'->>'estimatedShipDate' ~ '^\d{12,13}$'
  AND (s.order_number IN (o.order_number, o.customer_order_id) OR s.order_id IN (o.order_number, o.customer_order_id));--> statement-breakpoint
-- Ripley (Mirakl): "shipping_deadline"
UPDATE "sales_records" s SET "dispatch_deadline" = ((o.raw->>'shipping_deadline')::timestamptz AT TIME ZONE 'America/Santiago')::date
FROM "retail_api_orders" o, "retailers" r
WHERE r.id = s.retailer_id AND r.code = 'RIPLEY' AND o.provider = 'RIPLEY' AND o.tenant_id = r.tenant_id
  AND s.dispatch_deadline IS NULL AND o.raw->>'shipping_deadline' ~ '^\d{4}-\d{2}-\d{2}T'
  AND (s.order_number IN (o.order_number, o.customer_order_id) OR s.order_id IN (o.order_number, o.customer_order_id));
