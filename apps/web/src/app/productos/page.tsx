'use client';

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ClipboardList, Layers, Link2, Package, Plus, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { RetailProducts } from '@/components/retail-products';
import { useSession } from '@/components/session';
import { Button, Card, clp, Empty, ErrorBox, Field, inputCls, Loading, Modal, Page, parseAmount, Pill, Tabs, td, th, typingAmount } from '@/components/ui';
import { api, type Product, type Supply } from '@/lib/api';
import { cn } from '@/lib/cn';

export default function ProductsPage() {
  const { canEdit, isFactory } = useSession();
  const [tab, setTab] = useState<'productos' | 'insumos' | 'sin-asociar' | 'retailers'>('productos');
  const supplies = useQuery({ queryKey: ['supplies'], queryFn: api.listSupplies, enabled: isFactory });
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
      intro={
        isFactory
          ? 'Lo que fabricas y vendes. Arma la receta de insumos de cada producto y Cuadra calcula su costo solo.'
          : 'Lo que vendes y cuánto te cuesta. Con el costo te decimos cuánto deberías ganar antes de que llegue la factura.'
      }
      help={
        <>
          <p>Un producto puede venderse con distintos nombres y SKU en cada retailer (por color o tamaño). Aquí los agrupas en uno solo con su costo.</p>
          {isFactory && (
            <p>
              En <b>Insumos</b> cargas tus materiales (tela, espuma, patas…) con su costo. En cada producto armas su <b>receta</b>: cuánto lleva de cada
              insumo. Si cambia el costo de un insumo, se actualiza el costo de todos los productos que lo usan.
            </p>
          )}
          <p>
            En <b>En los retailers</b> ves tus publicaciones en Paris, Falabella y Walmart (los conectados por API) y cambias stock, precios, ofertas,
            nombre y descripción sin entrar a cada portal.
          </p>
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
            ...(isFactory ? [{ id: 'insumos' as const, label: 'Insumos', count: supplies.data?.length }] : []),
            { id: 'sin-asociar', label: 'Sin asociar', count: unlinked.length },
            { id: 'retailers', label: 'En los retailers' },
          ]}
        />
      </div>
      <ErrorBox error={products.error} />
      {tab === 'productos' ? (
        <ProductList products={products.data} loading={products.isLoading} onCreate={() => setCreating(true)} />
      ) : tab === 'insumos' ? (
        <SupplyList supplies={supplies.data} loading={supplies.isLoading} />
      ) : tab === 'retailers' ? (
        <RetailProducts />
      ) : (
        <Unlinked items={unlinked} products={products.data ?? []} loading={recs.some((q) => q.isLoading)} />
      )}
      {creating && <NewProduct onClose={() => setCreating(false)} />}
    </Page>
  );
}

function ProductList({ products, loading, onCreate }: { products?: Product[]; loading: boolean; onCreate: () => void }) {
  const { canEdit, isFactory } = useSession();
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
              <th className={cn(th, 'text-right')}>{isFactory ? 'Costo de fabricación (neto)' : 'Te cuesta (neto)'}</th>
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
  const { canEdit, isFactory } = useSession();
  const [recipeOpen, setRecipeOpen] = useState(false);
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
        {p.recipe ? (
          // Con receta: el costo lo calcula Cuadra con los insumos
          <div className="flex items-center justify-end gap-2">
            <span className="num font-medium">{clp(cost)}</span>
            <button onClick={() => setRecipeOpen(true)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50">
              <ClipboardList className="size-3.5" /> Receta · {p.recipe.items} {p.recipe.items === 1 ? 'insumo' : 'insumos'}
            </button>
          </div>
        ) : canEdit ? (
          <div className="flex items-center justify-end gap-2">
            {!cost && <Pill tone="ambar">Sin costo</Pill>}
            <input value={value} onChange={(e) => setValue(typingAmount(e.target.value))} placeholder="$ costo" className={cn(inputCls, 'num w-32 text-right')} />
            {changed && (
              <Button size="sm" onClick={() => save.mutate()} loading={save.isPending}>
                <Check className="size-4" />
              </Button>
            )}
            {isFactory && (
              <button onClick={() => setRecipeOpen(true)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50">
                <ClipboardList className="size-3.5" /> Armar receta
              </button>
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
        {recipeOpen && <RecipeDialog product={p} onClose={() => setRecipeOpen(false)} />}
      </td>
    </tr>
  );
}

/** Receta de un producto: qué insumos lleva y cuánto de cada uno */
function RecipeDialog({ product, onClose }: { product: Product; onClose: () => void }) {
  const qc = useQueryClient();
  const { canEdit } = useSession();
  const recipe = useQuery({ queryKey: ['recipe', product.id], queryFn: () => api.recipe(product.id) });
  const supplies = useQuery({ queryKey: ['supplies'], queryFn: api.listSupplies });
  const [lines, setLines] = useState<{ supplyId: string; quantity: string }[] | null>(null);
  const current = lines ?? recipe.data?.items.map((i) => ({ supplyId: i.supplyId, quantity: String(i.quantity) })) ?? [];
  const byId = new Map((supplies.data ?? []).map((s) => [s.id, s]));
  const qty = (v: string) => Number(v.replace(',', '.')) || 0;
  const total = current.reduce((n, l) => n + qty(l.quantity) * Number(byId.get(l.supplyId)?.netCost ?? 0), 0);
  const set = (i: number, patch: Partial<{ supplyId: string; quantity: string }>) => setLines(current.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const save = useMutation({
    mutationFn: () => api.saveRecipe(product.id, current.filter((l) => l.supplyId && qty(l.quantity) > 0).map((l) => ({ supplyId: l.supplyId, quantity: qty(l.quantity) }))),
    onSuccess: () => {
      for (const k of ['products', 'recipe', 'supplies', 'sales', 'home', 'reconciliation']) qc.invalidateQueries({ queryKey: [k] });
      onClose();
    },
  });
  return (
    <Modal
      wide
      title={`Receta: ${product.name}`}
      intro="Cuánto lleva de cada insumo para fabricar una unidad. El costo del producto se calcula solo."
      onClose={onClose}
      footer={
        canEdit && (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={lines === null}>
              Guardar receta
            </Button>
          </>
        )
      }
    >
      {recipe.isLoading || supplies.isLoading ? (
        <Loading />
      ) : !supplies.data?.length ? (
        <Empty icon={<Layers className="size-6" />} title="Aún no tienes insumos" text="Primero carga tus insumos en la pestaña Insumos (tela, espuma, patas…) con su costo." />
      ) : (
        <div className="space-y-3 text-left">
          {current.length === 0 && <p className="text-sm text-muted">Este producto aún no tiene insumos. Agrega el primero.</p>}
          {current.map((l, i) => {
            const sup = byId.get(l.supplyId);
            return (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <Field label={i === 0 ? 'Insumo' : ''} className="min-w-56 flex-1">
                  <select value={l.supplyId} onChange={(e) => set(i, { supplyId: e.target.value })} disabled={!canEdit} className={inputCls}>
                    <option value="">Elige un insumo</option>
                    {supplies.data!.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {clp(Number(s.netCost))} por {s.unit}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={i === 0 ? 'Cantidad' : ''} className="w-36">
                  <div className="flex items-center gap-1.5">
                    <input value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value.replace(/[^\d.,]/g, '') })} disabled={!canEdit} className={cn(inputCls, 'num text-right')} />
                    <span className="text-xs text-muted">{sup?.unit ?? ''}</span>
                  </div>
                </Field>
                <p className="num w-28 pb-2.5 text-right text-sm">{clp(qty(l.quantity) * Number(sup?.netCost ?? 0))}</p>
                {canEdit && (
                  <button onClick={() => setLines(current.filter((_, j) => j !== i))} className="mb-1.5 rounded-lg p-2 text-muted hover:bg-stone-100" title="Quitar">
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            );
          })}
          {canEdit && (
            <Button variant="ghost" size="sm" onClick={() => setLines([...current, { supplyId: '', quantity: '1' }])}>
              <Plus className="size-4" /> Agregar insumo
            </Button>
          )}
          <div className="flex items-center justify-between rounded-xl bg-stone-50 px-4 py-3">
            <span className="text-sm font-medium">Costo de fabricación (neto)</span>
            <span className="num text-lg font-semibold">{clp(Math.round(total))}</span>
          </div>
          <ErrorBox error={save.error} />
        </div>
      )}
    </Modal>
  );
}

/** Insumos: materiales con su costo neto por unidad */
function SupplyList({ supplies, loading }: { supplies?: Supply[]; loading: boolean }) {
  const qc = useQueryClient();
  const { canEdit } = useSession();
  const [f, setF] = useState({ name: '', sku: '', unit: 'unidad', cost: '' });
  const refresh = () => {
    for (const k of ['supplies', 'products', 'recipe', 'sales', 'home', 'reconciliation']) qc.invalidateQueries({ queryKey: [k] });
  };
  const create = useMutation({
    mutationFn: () =>
      api.createSupply({
        name: f.name.trim(),
        sku: (f.sku.trim() || f.name.trim()).toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 60),
        unit: f.unit.trim() || 'unidad',
        netCost: String(parseAmount(f.cost) ?? 0),
      }),
    onSuccess: () => {
      setF({ name: '', sku: '', unit: f.unit, cost: '' });
      refresh();
    },
  });
  if (loading) return <Loading />;
  return (
    <div className="space-y-4">
      {canEdit && (
        <Card className="flex flex-wrap items-end gap-3 p-4">
          <Field label="Nuevo insumo" className="min-w-56 flex-1">
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ej: Tela lino gris" className={inputCls} />
          </Field>
          <Field label="Código (opcional)" className="w-40">
            <input value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} placeholder="TELA-LINO-GR" className={inputCls} />
          </Field>
          <Field label="Se mide en" className="w-32">
            <input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} list="units" className={inputCls} />
          </Field>
          <Field label="Costo neto por unidad" className="w-40">
            <input value={f.cost} onChange={(e) => setF({ ...f, cost: typingAmount(e.target.value) })} placeholder="$" className={cn(inputCls, 'num text-right')} />
          </Field>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!f.name.trim()}>
            <Plus className="size-4" /> Agregar
          </Button>
          <datalist id="units">
            {['unidad', 'metro', 'metro²', 'kilo', 'litro', 'par', 'juego'].map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
          <div className="basis-full">
            <ErrorBox error={create.error} />
          </div>
        </Card>
      )}
      {!supplies?.length ? (
        <Card>
          <Empty icon={<Layers className="size-6" />} title="Aún no tienes insumos" text="Carga los materiales con que fabricas (tela, espuma, madera, patas…) y su costo." />
        </Card>
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b border-line">
              <tr>
                <th className={th}>Insumo</th>
                <th className={th}>Unidad</th>
                <th className={cn(th, 'text-right')}>Costo neto por unidad</th>
                <th className={th}>Se usa en</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {supplies.map((s) => (
                <SupplyRow key={s.id} s={s} onChange={refresh} />
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function SupplyRow({ s, onChange }: { s: Supply; onChange: () => void }) {
  const { canEdit } = useSession();
  const cost = Number(s.netCost);
  const [value, setValue] = useState(cost ? typingAmount(String(Math.round(cost))) : '');
  const save = useMutation({ mutationFn: () => api.updateSupply(s.id, { netCost: String(parseAmount(value) ?? 0) }), onSuccess: onChange });
  const del = useMutation({ mutationFn: () => api.deleteSupply(s.id), onSuccess: onChange });
  const changed = (parseAmount(value) ?? 0) !== cost;
  return (
    <tr>
      <td className={td}>
        <p className="font-medium">{s.name}</p>
        <p className="text-xs text-muted">{s.sku}</p>
      </td>
      <td className={cn(td, 'text-muted')}>{s.unit}</td>
      <td className={cn(td, 'text-right')}>
        {canEdit ? (
          <div className="flex items-center justify-end gap-2">
            <input value={value} onChange={(e) => setValue(typingAmount(e.target.value))} placeholder="$ costo" className={cn(inputCls, 'num w-32 text-right')} />
            {changed && (
              <Button size="sm" onClick={() => save.mutate()} loading={save.isPending} title="Guardar y recalcular los productos que lo usan">
                <Check className="size-4" />
              </Button>
            )}
          </div>
        ) : (
          <span className="num">{clp(cost)}</span>
        )}
      </td>
      <td className={cn(td, 'text-muted')}>{s.usedIn ? `${s.usedIn} ${s.usedIn === 1 ? 'producto' : 'productos'}` : '—'}</td>
      <td className={cn(td, 'text-right')}>
        {canEdit && (
          <button
            onClick={() => {
              if (!s.usedIn || window.confirm(`"${s.name}" se usa en ${s.usedIn} productos. Si lo eliminas, sale de sus recetas. ¿Eliminar?`)) del.mutate();
            }}
            className="rounded-lg p-2 text-muted hover:bg-stone-100 hover:text-berry-700"
            title="Eliminar insumo"
          >
            <Trash2 className="size-4" />
          </button>
        )}
        <ErrorBox error={save.error ?? del.error} />
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
