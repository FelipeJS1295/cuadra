-- Walmart informa la fecha de despacho como instante UTC (ej. 27-10 00:00 UTC). Su portal la
-- muestra en hora de Chile (26-10 21:00 -> día 26): se recalcula igual en las ventas ya guardadas.
UPDATE "sales_records" s SET "dispatch_deadline" = (to_timestamp((o.raw->'shippingInfo'->>'estimatedShipDate')::bigint / 1000) AT TIME ZONE 'America/Santiago')::date
FROM "retail_api_orders" o, "retailers" r
WHERE r.id = s.retailer_id AND r.code = 'WALMART' AND o.provider = 'WALMART' AND o.tenant_id = r.tenant_id
  AND o.raw->'shippingInfo'->>'estimatedShipDate' ~ '^\d{12,13}$'
  AND (s.order_number IN (o.order_number, o.customer_order_id) OR s.order_id IN (o.order_number, o.customer_order_id));
