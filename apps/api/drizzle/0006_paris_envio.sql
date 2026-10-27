-- Paris: lo que pagó el cliente por el envío viene en la sub-orden ("cost") y no en cada producto.
-- Las ventas traídas por API antes de este cambio quedaron sin envío: se completa en la primera
-- línea de cada sub-orden (solo si ninguna línea de esa orden tiene envío).
with sub as (
  select o.tenant_id, s->>'subOrderNumber' as sub_no, nullif(s->>'cost', '')::numeric as cost
  from retail_api_orders o
  cross join lateral jsonb_array_elements(case when jsonb_typeof(o.raw->'subOrders') = 'array' then o.raw->'subOrders' else '[]'::jsonb end) s
  where o.provider = 'CENCOSUD'
), first_line as (
  select distinct on (sr.retailer_id, sr.order_number) sr.id, sr.retailer_id, sr.order_number, r.tenant_id
  from sales_records sr join retailers r on r.id = sr.retailer_id
  where r.code = 'CENCOSUD' and sr.raw->>'__origen' = 'API'
  order by sr.retailer_id, sr.order_number, sr.external_item_id
)
update sales_records t set shipping_cost = sub.cost
from first_line f join sub on sub.tenant_id = f.tenant_id and sub.sub_no = f.order_number
where t.id = f.id and sub.cost > 0
  and not exists (
    select 1 from sales_records x
    where x.retailer_id = f.retailer_id and x.order_number = f.order_number and coalesce(x.shipping_cost, 0) <> 0
  );
