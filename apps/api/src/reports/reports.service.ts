import { Inject, Injectable } from '@nestjs/common';
import { PRICING_CHANNELS, CANCELLED_PATTERN } from '@cuadra/shared';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../database/database.module.js';

/** Una fila agrupada: un producto del catálogo de un retailer */
type ProductSalesRow = {
  retailer_code: string;
  retailer_name: string;
  product_key: string;
  retailer_sku: string | null;
  seller_sku: string | null;
  name: string;
  units: number;
  revenue: number;
  orders: number;
};

export interface TopProduct {
  /** Retailer + id del producto en su catálogo (o su SKU seller / nombre si no está en el catálogo) */
  key: string;
  retailerCode: string;
  retailerLabel: string;
  /** SKU del producto en el retailer (ej: Paris MK8400CF1K, Falabella 141096181) */
  retailerSku: string | null;
  /** SKU del vendedor (ej: SECRICHFBNGCL) */
  sellerSku: string | null;
  name: string;
  /** false = la venta no se encontró en el catálogo del retailer (se agrupa por nombre) */
  inCatalog: boolean;
  units: number;
  /** Venta bruta con IVA */
  revenue: number;
  orders: number;
}

export interface TopProductsReport {
  from: string | null;
  to: string | null;
  totals: { units: number; revenue: number; orders: number };
  /** Top 5 de todos los retailers juntos (cada producto con su retailer) */
  overall: TopProduct[];
  /** Ranking dentro de cada retailer */
  retailers: { code: string; label: string; units: number; revenue: number; products: TopProduct[] }[];
}

const OVERALL_LIMIT = 5;
const PER_RETAILER_LIMIT = 10;

/** Nombre a mostrar del retailer (Cencosud se muestra como "Paris", igual que en Productos) */
const LABELS: Record<string, string> = Object.fromEntries(PRICING_CHANNELS.map((c) => [c.code, c.label]));
const ORDER: string[] = PRICING_CHANNELS.map((c) => c.code);

@Injectable()
export class ReportsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Productos más vendidos (en unidades), por retailer y en conjunto.
   * Se agrupa por el producto de CADA retailer (su SKU propio), no por master.
   *
   * Cada venta se une a su producto del catálogo del retailer:
   *  - por SKU del vendedor (Falabella, Paris, Walmart)
   *  - por nombre del producto cuando la venta no trae SKU (Hites)
   * Si no está en el catálogo (ej: Paris "SECRICH1401-1"), se agrupa por el SKU seller
   * (o el nombre) que trae la venta y se marca "no está en el catálogo".
   * Las ventas canceladas/anuladas no cuentan.
   */
  async topProducts(from?: string, to?: string): Promise<TopProductsReport> {
    const result = await this.db.execute<ProductSalesRow>(sql`
      with s as (
        select
          r.code as retailer_code,
          r.name as retailer_name,
          s.order_number,
          s.quantity,
          s.product_name,
          s.seller_sku as sale_seller_sku,
          -- Venta bruta (con IVA): Walmart informa montos netos
          coalesce(s.paid_price, s.unit_price, 0) * s.quantity
            * case when s.amounts_include_tax then 1 else 1.19 end as revenue,
          rp.id as catalog_id,
          rp.retailer_sku,
          rp.seller_sku as catalog_seller_sku,
          rp.name as catalog_name
        from sales_records s
        join retailers r on r.id = s.retailer_id
        left join lateral (
          -- los ingresados a mano (MANUAL) no tienen SKU real del retailer
          select rp.id, case when rp.status = 'MANUAL' then null else rp.retailer_sku end as retailer_sku,
            rp.seller_sku, rp.name, rp.status
          from retailer_products rp
          where rp.retailer_id = s.retailer_id
            and (
              upper(rp.seller_sku) = upper(s.seller_sku)
              -- por nombre solo si la venta no trae SKU (Hites): un nombre genérico podría
              -- calzar con otro color y mezclar productos
              or (s.seller_sku is null and lower(trim(rp.name)) = lower(trim(s.product_name)))
            )
          order by (rp.status = 'MANUAL') nulls first -- primero el producto real del catálogo
          limit 1
        ) rp on true
        where coalesce(s.status, '') !~* ${CANCELLED_PATTERN}
          ${from ? sql`and s.order_date >= ${from}` : sql``}
          ${to ? sql`and s.order_date <= ${to}` : sql``}
      )
      select
        retailer_code,
        retailer_name,
        -- Producto del catálogo; si no está, se agrupa por SKU seller de la venta o por nombre
        coalesce(
          catalog_id::text,
          'sku:' || upper(sale_seller_sku),
          'nombre:' || lower(trim(coalesce(product_name, 'Sin nombre')))
        ) as product_key,
        max(retailer_sku) as retailer_sku,
        max(coalesce(catalog_seller_sku, sale_seller_sku)) as seller_sku,
        max(coalesce(catalog_name, product_name, 'Sin nombre')) as name,
        sum(quantity)::int as units,
        round(sum(revenue))::float8 as revenue,
        count(distinct order_number)::int as orders
      from s
      group by 1, 2, 3
    `);
    const rows = result.rows;

    const label = (r: ProductSalesRow) => LABELS[r.retailer_code] ?? r.retailer_name;
    const toProduct = (r: ProductSalesRow): TopProduct => ({
      key: `${r.retailer_code}|${r.product_key}`,
      retailerCode: r.retailer_code,
      retailerLabel: label(r),
      retailerSku: r.retailer_sku,
      sellerSku: r.seller_sku,
      name: r.name,
      inCatalog: r.retailer_sku !== null,
      units: r.units,
      revenue: r.revenue,
      orders: r.orders,
    });
    const byUnits = (a: TopProduct, b: TopProduct) => b.units - a.units || b.revenue - a.revenue;
    const all = rows.map(toProduct).sort(byUnits);

    // Ranking por retailer
    const codes = [...new Set(rows.map((r) => r.retailer_code))].sort(
      (a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99),
    );
    const retailers = codes.map((code) => {
      const own = all.filter((p) => p.retailerCode === code);
      return {
        code,
        label: own[0].retailerLabel,
        units: own.reduce((n, p) => n + p.units, 0),
        revenue: own.reduce((n, p) => n + p.revenue, 0),
        products: own.slice(0, PER_RETAILER_LIMIT),
      };
    });

    // Top en conjunto: los productos de todos los retailers en una sola lista
    const overall = all.slice(0, OVERALL_LIMIT);

    return {
      from: from ?? null,
      to: to ?? null,
      totals: {
        units: rows.reduce((n, r) => n + r.units, 0),
        revenue: rows.reduce((n, r) => n + r.revenue, 0),
        orders: rows.reduce((n, r) => n + r.orders, 0),
      },
      overall,
      retailers,
    };
  }
}