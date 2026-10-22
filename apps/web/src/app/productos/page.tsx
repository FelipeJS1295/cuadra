'use client';

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Link2, Package, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSession } from '@/components/session';
import { Button, Card, clp, Empty, ErrorBox, Field, inputCls, Loading, Modal, Page, parseAmount, Pill, Tabs, td, th, typingAmount } from '@/components/ui';
import { api, type Product } from '@/lib/api';
import { cn } from '@/lib/cn';

export default function ProductsPage() {
  const { canEdit } = useSession();
  const [tab, setTab] = useState<'productos' | 'sin-asociar'>('productos');
  const [creating, setCreating] = useState(false);
  const products = useQuery({ queryKey: ['products'], queryFn: api.listProducts });
  const retailers = useQuery({ queryKey: ['import-retailers', 'liquidacion'], queryFn: api.settlementRetailers });
  const recs = useQueries({ queries: (retailers.data ?? []).map((r) => ({ queryKey: ['reconciliation', r.code], queryFn: () => api.reconcile(r.code) })) });
  // Productos vendidos que no están asociados a ninguno de tus productos (o que no tienen costo)
  const unlinked = useMemo(() => {
    const m = new Map<string, { retailerCode: string; retailer: string; sellerSku: string | null; name: string; sales: number }>();
    recs.forEach((q, i) => {
      for (const row of q.data?.rows ?? []) {
        for (const mp of row.missingProducts) {
          if (mp.masterId) continue;
          const key = `${retailers.data![i].code}|${mp.sellerSku ?? mp.name}`;
          const prev = m.get(key) ?? { retailerCode: q.data!.retailerCode, retailer: retailers.data![i].name, sellerSku: mp.sellerSku, name: mp.name ?? 'Producto', sales: 0 };
          prev.sales++;
          m.set(key, prev);
        }
      }
    });
    return [...m.values()].sort((a, b) => b.sales - a.sales);
  }, [recs, retailers.data]);

  return (
    <Page
      title="Productos"
      intro="Lo que vendes y cuánto te cuesta. Con el costo te decimos cuánto deberías ganar antes de que llegue la factura."
      help={
        <>
          <p>Un producto puede venderse con distintos nombres y SKU en cada retailer (por color o tamaño). Aquí los agrupas en uno solo con su costo.</p>
          <p>
            En <b>Sin asociar</b> aparecen los productos que vendiste y que todavía no sabemos a cuál de tus productos corresponden.
          </p>
        </>
      }
      actions={
        canEdit && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> Nuevo producto
          </Button>
        )
      }
    >
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { id: 'productos', label: 'Mis productos', count: products.data?.length },
            { id: 'sin-asociar', label: 'Sin asociar', count: unlinked.length },
          ]}
        />
      </div>
      <ErrorBox error={products.error} />
      {tab === 'productos' ? (
        <ProductList products={products.data} loading={products.isLoading} onCreate={() => setCreating(true)} />
      ) : (
        <Unlinked items={unlinked} products={products.data ?? []} loading={recs.some((q) => q.isLoading)} />
      )}
      {creating && <NewProduct onClose={() => setCreating(false)} />}
    </Page>
  );
}

function ProductList({ products, loading, onCreate }: { products?: Product[]; loading: boolean; onCreate: () => void }) {
  const { canEdit } = useSession();
  const [search, setSearch] = useState('');
  const rows = (products ?? []).filter((p) => `${p.name} ${p.skuMaster}`.toLowerCase().includes(search.trim().toLowerCase()));
  if (loading) return <Loading />;
  if (!products?.length)
    return (
      <Card>
        <Empty
          icon={<Package className="size-6" />}
          title="Aún no tienes productos"
          text="Crea tus productos con su costo. Después los asociamos a lo que vendes en cada retailer."
          action={canEdit && <Button onClick={onCreate}>Crear el primero</Button>}
        />
      </Card>
    );
  return (
    <>
      <label className="relative mb-3 block w-72">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar producto" className={cn(inputCls, 'pl-9')} />
      </label>
      <Card>
        <table className="w-full text-sm">
          <thead className="border-b border-line">
            <tr>
              <th className={th}>Producto</th>
              <th className={cn(th, 'text-right')}>Te cuesta (neto)</th>
              <th className={cn(th, 'text-right')}>Deberías recibir</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((p) => (
              <ProductRow key={p.id} p={p} />
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function ProductRow({ p }: { p: Product }) {
  const qc = useQueryClient();
  const { canEdit } = useSession();
  const cost = Number(p.provisionalCost);
  const [value, setValue] = useState(cost ? typingAmount(String(Math.round(cost))) : '');
  const save = useMutation({
    mutationFn: () => api.updateProduct(p.id, { provisionalCost: String(parseAmount(value) ?? 0) }),
    onSuccess: () => {
      for (const k of ['products', 'reconciliation', 'home', 'onboarding']) qc.invalidateQueries({ queryKey: [k] });
    },
  });
  const changed = (parseAmount(value) ?? 0) !== cost;
  return (
    <tr>
      <td className={td}>
        <p className="font-medium">{p.name}</p>
        <p className="text-xs text-muted">{p.skuMaster}</p>
      </td>
      <td className={cn(td, 'text-right')}>
        {canEdit ? (
          <div className="flex items-center justify-end gap-2">
            {!cost && <Pill tone="ambar">Sin costo</Pill>}
            <input value={value} onChange={(e) => setValue(typingAmount(e.target.value))} placeholder="$ costo" className={cn(inputCls, 'num w-32 text-right')} />
            {changed && (
              <Button size="sm" onClick={() => save.mutate()} loading={save.isPending}>
                <Check className="size-4" />
              </Button>
            )}
          </div>
        ) : (
          <span className="num">{clp(cost)}</span>
        )}
      </td>
      <td className={cn(td, 'num text-right text-muted')} title="Costo + tu % de utilidad + % de devoluciones">
        {p.targetNet ? clp(p.targetNet) : '—'}
      </td>
      <td className={td}>
        <ErrorBox error={save.error} />
      </td>
    </tr>
  );
}

function Unlinked({ items, products, loading }: { items: { retailerCode: string; retailer: string; sellerSku: string | null; name: string; sales: number }[]; products: Product[]; loading: boolean }) {
  const qc = useQueryClient();
  const { canEdit } = useSession();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const link = useMutation({
    mutationFn: (i: (typeof items)[number]) => api.manualCatalogAssign({ retailerCode: i.retailerCode, sellerSku: i.sellerSku, name: i.name, productId: choice[`${i.retailerCode}|${i.sellerSku ?? i.name}`] }),
    onSuccess: () => {
      for (const k of ['reconciliation', 'sales', 'home']) qc.invalidateQueries({ queryKey: [k] });
    },
  });
  if (loading) return <Loading label="Buscando productos vendidos…" />;
  if (!items.length)
    return (
      <Card>
        <Empty icon={<Link2 className="size-6" />} title="Todo asociado" text="Cada producto que vendiste ya está asociado a uno de tus productos." />
      </Card>
    );
  return (
    <Card>
      <ul className="divide-y divide-line">
        {items.map((i) => {
          const key = `${i.retailerCode}|${i.sellerSku ?? i.name}`;
          return (
            <li key={key} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-56 flex-1">
                <p className="font-medium">{i.name}</p>
                <p className="text-xs text-muted">
                  {i.retailer} · SKU {i.sellerSku ?? '—'} · {i.sales} {i.sales === 1 ? 'venta' : 'ventas'}
                </p>
              </div>
              {canEdit && (
                <>
                  <select value={choice[key] ?? ''} onChange={(e) => setChoice((c) => ({ ...c, [key]: e.target.value }))} className={cn(inputCls, 'w-64')}>
                    <option value="">¿Cuál de tus productos es?</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <Button size="sm" onClick={() => link.mutate(i)} disabled={!choice[key]} loading={link.isPending && link.variables === i}>
                    Asociar
                  </Button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <div className="px-5 pb-4">
        <ErrorBox error={link.error} />
      </div>
    </Card>
  );
}

function NewProduct({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ skuMaster: '', name: '', cost: '' });
  const save = useMutation({
    mutationFn: () => api.createProduct({ skuMaster: f.skuMaster.trim().toUpperCase(), name: f.name.trim(), provisionalCost: String(parseAmount(f.cost) ?? 0) }),
    onSuccess: () => {
      for (const k of ['products', 'onboarding', 'home']) qc.invalidateQueries({ queryKey: [k] });
      onClose();
    },
  });
  return (
    <Modal
      title="Nuevo producto"
      intro="Ej: Sofá Seccional Richter (sin color ni tamaño: eso va en cada retailer)."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!f.skuMaster.trim() || !f.name.trim()}>
            Crear
          </Button>
        </>
      }
    >
      <Field label="Nombre">
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inputCls} autoFocus />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Código interno (SKU)" hint="Ej: SOF-RICHTER">
          <input value={f.skuMaster} onChange={(e) => setF({ ...f, skuMaster: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Te cuesta (neto, sin IVA)">
          <input value={f.cost} onChange={(e) => setF({ ...f, cost: typingAmount(e.target.value) })} className={cn(inputCls, 'num')} />
        </Field>
      </div>
      <ErrorBox error={save.error} />
    </Modal>
  );
}
