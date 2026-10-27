-- Paris (Cencosud): cada orden tiene una orden madre (315388869 / ecl18872210) y sub-órdenes
-- (3153888690 / ecl18872210-01). La liquidación y el reporte de ventas usan la SUB-ORDEN.
--
-- 1) Al correr la migración 0002 después de traer ventas por API quedaron órdenes repetidas:
--    una con el N° de la madre y otra con el de la sub-orden. Se quita la de la madre.
DELETE FROM sales_records s
WHERE s.raw->>'__origen' = 'API'
  AND EXISTS (
    SELECT 1 FROM sales_records t
    WHERE t.retailer_id = s.retailer_id
      AND t.id <> s.id
      AND t.raw->>'__origen' = 'API'
      AND t.raw->>'apiOrderId' = s.raw->>'apiOrderId'
      AND t.order_number = s.order_id
      AND t.order_id = s.order_number
      AND length(t.order_number) > length(s.order_number)
  );
--> statement-breakpoint
-- 2) Las que quedaron solo con el N° de la madre pasan a la sub-orden (igual que la API desde ahora)
UPDATE sales_records s
SET order_number = s.order_id,
    order_id = s.order_number,
    external_item_id = left(s.order_id || substr(s.external_item_id, length(s.order_number) + 1), 50)
FROM retailers r
WHERE r.id = s.retailer_id
  AND r.code = 'CENCOSUD'
  AND s.raw->>'__origen' = 'API'
  AND s.order_id IS NOT NULL
  AND length(s.order_id) > length(s.order_number)
  AND s.order_id LIKE s.order_number || '%'
  AND s.external_item_id LIKE s.order_number || '|%'
  AND NOT EXISTS (
    SELECT 1 FROM sales_records x
    WHERE x.retailer_id = s.retailer_id
      AND x.external_item_id = left(s.order_id || substr(s.external_item_id, length(s.order_number) + 1), 50)
  );
