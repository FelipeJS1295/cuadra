-- Las órdenes que ya se trajeron por API pasan a Ventas (sales_records), con las mismas
-- reglas que usa la API desde ahora (ver src/retail-api/api-to-sales.ts):
--  · clave de línea igual a la del archivo del retailer (no se duplica)
--  · si la orden ya estaba cargada por archivo, no se toca
--  · las líneas quedan marcadas con raw.__origen = 'API'
WITH lines AS (
	SELECT
		o.tenant_id, r.id AS retailer_id, o.id AS api_order_id, o.provider,
		o.order_number, o.customer_order_id, o.external_id, o.order_date, o.status AS order_status,
		o.customer_name, o.customer_email, o.customer_rut, o.address, o.commune, o.region,
		coalesce(i.external_item_id, 'orden') AS item_id,
		i.seller_sku,
		coalesce(i.name, CASE WHEN i.id IS NULL THEN 'Orden sin detalle de productos' END) AS name,
		greatest(1, round(coalesce(i.quantity, 1)))::int AS qty,
		CASE WHEN i.id IS NULL THEN o.total - coalesce(o.shipping_total, 0) ELSE i.paid_price END AS paid_line,
		CASE WHEN i.id IS NULL THEN o.total - coalesce(o.shipping_total, 0) ELSE i.unit_price END AS unit_price,
		CASE WHEN i.id IS NULL THEN o.shipping_total ELSE i.shipping_amount END AS shipping,
		coalesce(i.status, o.status) AS status,
		i.raw AS item_raw
	FROM retail_api_orders o
	JOIN retailers r ON r.tenant_id = o.tenant_id AND r.code = o.provider
	LEFT JOIN retail_api_order_items i ON i.order_id = o.id
	WHERE NOT EXISTS (
		SELECT 1 FROM sales_records s
		WHERE s.retailer_id = r.id
			AND (s.order_number IN (o.order_number, o.customer_order_id) OR s.order_id IN (o.order_number, o.customer_order_id))
			AND coalesce(s.raw->>'__origen', '') <> 'API'
	)
), keyed AS (
	SELECT *,
		CASE provider
			WHEN 'WALMART' THEN coalesce(order_number, external_id) || '|' || item_id
			WHEN 'CENCOSUD' THEN coalesce(order_number, external_id) || '|' || coalesce(seller_sku, item_id)
			ELSE item_id
		END AS base_key
	FROM lines
), numbered AS (
	SELECT *, row_number() OVER (PARTITION BY retailer_id, base_key ORDER BY api_order_id, item_id) AS n FROM keyed
)
INSERT INTO sales_records (
	tenant_id, retailer_id, external_item_id, seller_sku, product_name, order_date, order_number, order_id, status,
	customer_name, customer_email, customer_document, shipping_name, shipping_address, shipping_commune, shipping_region,
	paid_price, unit_price, shipping_cost, amounts_include_tax, quantity, raw
)
SELECT
	tenant_id, retailer_id,
	left(CASE WHEN n > 1 THEN base_key || '|' || n ELSE base_key END, 50),
	left(seller_sku, 60), name,
	(order_date AT TIME ZONE 'America/Santiago')::date,
	left(coalesce(order_number, external_id), 50),
	left(coalesce(customer_order_id, order_number, external_id), 50),
	left(status, 50),
	customer_name, customer_email, left(customer_rut, 20), customer_name, address, left(commune, 100), left(region, 100),
	round(paid_line / qty, 2), unit_price, shipping, true, qty,
	jsonb_build_object('__origen', 'API', 'apiOrderId', api_order_id::text, 'provider', provider, 'item', item_raw)
FROM numbered
ON CONFLICT (retailer_id, external_item_id) DO NOTHING;
