-- Ventas recibidas de clientes de Cuadra: el proveedor anota precios netos (la factura suma el IVA)
UPDATE "sales_records" SET "amounts_include_tax" = false WHERE "raw"->>'__origen' = 'CUADRA';
