'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Search, Store } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, type ClientProduct, type Product } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useSession } from './session';
import { Button, Card, clp, Empty, ErrorBox, inputCls, Loading, parseAmount, typingAmount } from './ui';

type Draft = { parentSku?: string; name?: string; price?: string; productId?: string };

/**
 * Productos que llegaron con las ventas de clientes de Cuadra (ej. Jamaroff -> Jerk Home).
 * Igual que con los retailers: a cada uno se le asigna SKU padre/color, nombre, precio de venta
 * al cliente (neto, sin IVA) y a cuál de tus productos corresponde (para el costo).
 */
export function ClientProducts({ products }: { products: Product[] }) {
  const { canEdit } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['client-products'], queryFn: api.clientProducts });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [onlyPending, setOnlyPending] = useState(false);

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? []).filter(
      (p) => (!s || `${p.name} ${p.sku} ${p.client} ${p.parentSku ?? ''} ${p.ownName ?? ''}`.toLowerCase().includes(s)) && (!onlyPending || p.price === null),
    );
  }, [q.data, search, onlyPending]);
  const pending = (q.data ?? []).filter((p) => p.price === null).length;

  const save = useMutation({
    mutationFn: ({ p, d }: { p: ClientProduct; d: Draft }) =>
      api.updateClientProduct(p.id, {
        ...(d.price !== undefined ? { price: d.price.trim() ? parseAmount(d.price) : null } : {}),
        ...(d.parentSku !== undefined || d.name !== undefined
          ? { parentSku: (d.parentSku ?? p.parentSku ?? '').trim() || null, name: (d.name ?? p.ownName ?? p.name).trim() || null }
          : {}),
        ...(d.productId !== undefined ? { productId: d.productId || null } : {}),
      }),
    onSuccess: (_r, { p }) => {
      setDrafts(({ [p.id]: _, ...rest }) => rest);
      setSaved((s) => ({ ...s, [p.id]: true }));
      setTimeout(() => setSaved(({ [p.id]: _, ...rest }) => rest), 2500);
      for (const k of ['client-products', 'sales', 'home', 'dispatch-board']) qc.invalidateQueries({ queryKey: [k] });
    },
  });

  if (q.isLoading) return <Loading />;
  if (!q.data?.length)
    return (
      <Card>
        <Empty
          icon={<Store className="size-6" />}
          title="Aún no te llegan ventas de clientes"
          text="Cuando un cliente que usa Cuadra te envíe sus ventas, sus productos aparecerán aquí para que les pongas precio, SKU padre/color y nombre."
        />
      </Card>
    );

  const set = (id: string, patch: Draft) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative block w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar producto, SKU o cliente" className={cn(inputCls, 'pl-9')} />
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} className="size-4 accent-brand-600" /> Sin precio
          <span className="figure text-xs">({pending})</span>
        </label>
      </div>
      <p className="text-xs text-muted">
        El precio es lo que le cobras al cliente por unidad, neto (sin IVA): la factura le suma el IVA. Al guardarlo se aplica a sus ventas que aún no tienen factura. Asocia cada uno a tu producto
        para que Cuadra calcule tu costo y margen.
      </p>
      <ErrorBox error={save.error} />
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line">
            <tr>
              {['Producto del cliente', 'SKU padre / color', 'Nombre para Ventas', 'Precio neto', 'Tu producto', 'Unid.', ''].map((h, i) => (
                <th key={i} className={cn('px-3 py-3 text-left text-xs font-medium tracking-wide whitespace-nowrap text-muted uppercase', i === 5 && 'text-right')}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const d = drafts[p.id] ?? {};
              const dirty = Object.keys(d).length > 0;
              return (
                <tr key={p.id} className={cn('border-b border-line/60 last:border-0', dirty && 'bg-sun-50/60', p.price === null && !dirty && 'bg-berry-50/30')}>
                  <td className="px-3 py-2">
                    <p className="max-w-64 truncate font-medium" title={p.name}>
                      {p.name}
                    </p>
                    <p className="text-xs text-muted">
                      {p.client} · SKU {p.sku}
                    </p>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={d.parentSku ?? p.parentSku ?? ''}
                      onChange={(e) => set(p.id, { parentSku: e.target.value.toUpperCase() })}
                      disabled={!canEdit}
                      placeholder="RICH-3C-GO"
                      className={cn(inputCls, 'w-36 px-2 py-1 uppercase')}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={d.name ?? p.ownName ?? ''}
                      onChange={(e) => set(p.id, { name: e.target.value })}
                      disabled={!canEdit}
                      placeholder={p.name}
                      className={cn(inputCls, 'w-56 px-2 py-1')}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={d.price ?? (p.price !== null ? typingAmount(String(p.price)) : '')}
                      onChange={(e) => set(p.id, { price: typingAmount(e.target.value) })}
                      disabled={!canEdit}
                      inputMode="numeric"
                      placeholder="$"
                      className={cn(inputCls, 'w-28 px-2 py-1 text-right', p.price === null && d.price === undefined && 'border-berry-100')}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={d.productId ?? p.productId ?? ''}
                      onChange={(e) => set(p.id, { productId: e.target.value })}
                      disabled={!canEdit}
                      className={cn(inputCls, 'w-48 px-2 py-1')}
                    >
                      <option value="">Sin asociar</option>
                      {products.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="figure px-3 py-2 text-right">{p.units}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {saved[p.id] ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-money-700">
                        <Check className="size-3.5" /> Guardado
                      </span>
                    ) : canEdit && dirty ? (
                      <Button size="sm" onClick={() => save.mutate({ p, d })} loading={save.isPending && save.variables?.p.id === p.id}>
                        Guardar
                      </Button>
                    ) : p.price !== null ? (
                      <span className="text-xs text-muted">{clp(p.price)}</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <p className="px-4 py-6 text-center text-sm text-muted">Ningún producto calza con la búsqueda.</p>}
      </Card>
    </div>
  );
}
