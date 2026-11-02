'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ExternalLink, ImageOff, Search, Store, UploadCloud } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, type StoreProduct, type StorePublishItem } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useSession } from './session';
import { Button, Card, clp, Empty, ErrorBox, inputCls, Loading, Modal, Pill, parseAmount, typingAmount } from './ui';

type Draft = { name?: string; price?: string; compareAt?: string; category?: string; stock?: string; active?: boolean };
type Filter = 'todos' | 'publicados' | 'sin-publicar';

/**
 * Tienda web propia: los productos de Cuadra (los de los retailers, agrupados por SKU padre/color)
 * se publican en la tienda con sus fotos y descripción. Se elige precio, categoría y stock.
 */
export function StoreProducts() {
  const { canEdit } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['store-catalog'], queryFn: api.storeCatalog });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('todos');
  const [images, setImages] = useState(true);

  const value = (p: StoreProduct) => {
    const d = drafts[p.key] ?? {};
    const price = (d.price !== undefined ? parseAmount(d.price) : (p.store?.price ?? p.suggestedPrice)) ?? 0;
    const before = d.compareAt !== undefined ? parseAmount(d.compareAt) : (p.store?.compareAtPrice ?? p.suggestedCompareAt);
    return {
      name: d.name ?? p.name,
      price,
      compareAt: before && before > price ? before : null,
      category: d.category ?? p.store?.category ?? '',
      stock: d.stock !== undefined ? (d.stock.trim() === '' ? null : Number(d.stock)) : (p.store?.stock ?? p.stock),
      active: d.active ?? p.store?.active ?? true,
    };
  };

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data?.products ?? []).filter(
      (p) =>
        (!s || `${p.name} ${p.key} ${p.sources.map((x) => x.sellerSku).join(' ')}`.toLowerCase().includes(s)) &&
        (filter === 'todos' || (filter === 'publicados' ? p.store : !p.store)),
    );
  }, [q.data, search, filter]);

  const publish = useMutation({
    mutationFn: () => {
      const items: StorePublishItem[] = (q.data?.products ?? [])
        .filter((p) => chosen.has(p.key))
        .map((p) => {
          const v = value(p);
          return {
            key: p.key,
            name: v.name.trim(),
            price: v.price,
            compareAtPrice: v.compareAt,
            category: v.category || null,
            stock: v.stock,
            active: v.active,
            images,
          };
        });
      return api.storePublish(items);
    },
    onSuccess: () => {
      setChosen(new Set());
      setDrafts({});
      qc.invalidateQueries({ queryKey: ['store-catalog'] });
    },
  });

  if (q.isLoading) return <Loading label="Trayendo tus productos y la tienda…" />;
  if (q.error) return <ErrorBox error={q.error} />;
  const all = q.data!.products;
  if (!all.length)
    return (
      <Card>
        <Empty
          icon={<Store className="size-6" />}
          title="Aún no hay productos para publicar"
          text='Trae tus productos desde los retailers (En los retailers → "Actualizar productos") y aparecerán aquí para publicarlos en tu tienda.'
        />
      </Card>
    );

  const set = (key: string, patch: Draft) => {
    setDrafts((d) => ({ ...d, [key]: { ...d[key], ...patch } }));
    setChosen((c) => new Set(c).add(key));
  };
  const toggle = (key: string, on: boolean) =>
    setChosen((c) => {
      const n = new Set(c);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });
  const invalid = all.filter((p) => chosen.has(p.key)).filter((p) => !value(p).price || value(p).name.trim().length < 2);
  const published = all.filter((p) => p.store).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative block w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar producto o SKU" className={cn(inputCls, 'pl-9')} />
        </label>
        <div className="flex gap-1 rounded-xl bg-stone-100 p-1 text-sm">
          {(
            [
              ['todos', `Todos (${all.length})`],
              ['publicados', `En la tienda (${published})`],
              ['sin-publicar', `Sin publicar (${all.length - published})`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setFilter(id)}
              className={cn('rounded-lg px-3 py-1 font-medium', filter === id ? 'bg-white shadow-sm' : 'text-muted hover:text-ink')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted">
        Cada producto junta sus publicaciones en los retailers por su SKU padre/color. Las fotos y la descripción se toman del retailer con la ficha más
        completa. El precio sugerido es el más bajo que tiene en los retailers. Al publicar de nuevo, la tienda se actualiza con lo que pongas aquí.
      </p>
      <ErrorBox error={publish.error} />

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line">
            <tr className="text-left text-xs font-medium tracking-wide text-muted uppercase">
              <th className="w-10 px-3 py-3">
                <input
                  type="checkbox"
                  aria-label="Elegir todos"
                  className="size-4 accent-brand-600"
                  checked={rows.length > 0 && rows.every((p) => chosen.has(p.key))}
                  onChange={(e) =>
                    setChosen((c) => new Set(e.target.checked ? [...c, ...rows.map((p) => p.key)] : [...c].filter((k) => !rows.some((p) => p.key === k))))
                  }
                  disabled={!canEdit}
                />
              </th>
              <th className="px-3 py-3">Producto</th>
              <th className="px-3 py-3">Precio</th>
              <th className="px-3 py-3">Precio antes</th>
              <th className="px-3 py-3">Categoría</th>
              <th className="px-3 py-3">Stock</th>
              <th className="px-3 py-3">En la tienda</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const v = value(p);
              const d = drafts[p.key];
              const img = p.store?.image ?? p.images[0] ?? null;
              return (
                <tr key={p.key} className={cn('border-b border-line/60 align-top last:border-0', chosen.has(p.key) && 'bg-brand-50/40')}>
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Elegir ${p.name}`}
                      className="size-4 accent-brand-600"
                      checked={chosen.has(p.key)}
                      onChange={(e) => toggle(p.key, e.target.checked)}
                      disabled={!canEdit}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-3">
                      {img ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={img} alt="" className="size-14 shrink-0 rounded-lg border border-line object-cover" loading="lazy" />
                      ) : (
                        <span className="grid size-14 shrink-0 place-items-center rounded-lg border border-line bg-paper text-muted">
                          <ImageOff className="size-5" />
                        </span>
                      )}
                      <div className="min-w-0">
                        <input
                          value={v.name}
                          onChange={(e) => set(p.key, { name: e.target.value })}
                          disabled={!canEdit}
                          className={cn(inputCls, 'w-72 px-2 py-1 font-medium')}
                          aria-label="Nombre en la tienda"
                        />
                        <p className="mt-1 text-xs text-muted">
                          <span className="font-mono">{p.key}</span> ·{' '}
                          {p.sources
                            .map((s) => s.label)
                            .filter((x, i, a) => a.indexOf(x) === i)
                            .join(', ')}
                        </p>
                        <p className={cn('text-xs', p.images.length ? 'text-muted' : 'text-sun-700')}>
                          {p.images.length ? `${p.images.length} ${p.images.length === 1 ? 'foto' : 'fotos'} de ${p.imagesFrom}` : 'Sin fotos en los retailers'}
                          {p.description ? ' · con descripción' : ' · sin descripción'}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={d?.price ?? (v.price ? typingAmount(String(v.price)) : '')}
                      onChange={(e) => set(p.key, { price: typingAmount(e.target.value) })}
                      disabled={!canEdit}
                      inputMode="numeric"
                      placeholder="$"
                      className={cn(inputCls, 'w-28 px-2 py-1 text-right', !v.price && 'border-berry-100')}
                      aria-label="Precio"
                    />
                    {p.suggestedPrice ? <p className="mt-1 text-xs text-muted">Retail: {clp(p.suggestedPrice)}</p> : null}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={d?.compareAt ?? (v.compareAt ? typingAmount(String(v.compareAt)) : '')}
                      onChange={(e) => set(p.key, { compareAt: typingAmount(e.target.value) })}
                      disabled={!canEdit}
                      inputMode="numeric"
                      placeholder="Sin oferta"
                      className={cn(inputCls, 'w-28 px-2 py-1 text-right')}
                      aria-label="Precio antes (tachado)"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={v.category}
                      onChange={(e) => set(p.key, { category: e.target.value })}
                      disabled={!canEdit}
                      list="store-categories"
                      placeholder="Elegir o escribir"
                      className={cn(inputCls, 'w-40 px-2 py-1')}
                      aria-label="Categoría"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={d?.stock ?? (v.stock ?? '').toString()}
                      onChange={(e) => set(p.key, { stock: e.target.value.replace(/\D/g, '') })}
                      disabled={!canEdit}
                      inputMode="numeric"
                      className={cn(inputCls, 'w-20 px-2 py-1 text-right')}
                      aria-label="Stock"
                    />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {p.store ? (
                      <div className="space-y-1">
                        <Pill tone={p.store.active ? 'verde' : 'gris'}>{p.store.active ? 'Publicado' : 'Oculto'}</Pill>
                        <a href={p.store.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-brand-700 hover:underline">
                          Ver <ExternalLink className="size-3" />
                        </a>
                        <label className="flex items-center gap-1.5 text-xs text-muted">
                          <input
                            type="checkbox"
                            checked={v.active}
                            onChange={(e) => set(p.key, { active: e.target.checked })}
                            disabled={!canEdit}
                            className="accent-brand-600"
                          />{' '}
                          Visible
                        </label>
                      </div>
                    ) : (
                      <span className="text-xs text-muted">Sin publicar</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <p className="px-4 py-6 text-center text-sm text-muted">Ningún producto con ese filtro.</p>}
        <datalist id="store-categories">
          {q.data!.categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </Card>

      {canEdit && chosen.size > 0 && (
        <div className="sticky bottom-4 z-20 mx-auto flex w-fit flex-wrap items-center gap-3 rounded-2xl bg-graphite-900 px-4 py-2.5 text-sm text-white shadow-xl">
          <span className="font-medium">
            {chosen.size} {chosen.size === 1 ? 'producto elegido' : 'productos elegidos'}
          </span>
          <label className="flex items-center gap-1.5 text-white/80">
            <input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} className="accent-brand-500" /> Con fotos
          </label>
          <Button
            size="sm"
            onClick={() => publish.mutate()}
            loading={publish.isPending}
            disabled={invalid.length > 0}
            title={invalid.length ? 'Falta nombre o precio' : undefined}
          >
            <UploadCloud className="size-4" /> Publicar en la tienda
          </Button>
          {invalid.length > 0 && <span className="text-xs text-sun-100">{invalid.length} sin precio</span>}
          <button onClick={() => setChosen(new Set())} className="text-white/60 hover:text-white">
            Cancelar
          </button>
        </div>
      )}

      {publish.data && <PublishResult result={publish.data} names={new Map(all.map((p) => [p.key, p.name]))} onClose={() => publish.reset()} />}
    </div>
  );
}

function PublishResult({
  result,
  names,
  onClose,
}: {
  result: NonNullable<ReturnType<typeof api.storePublish> extends Promise<infer R> ? R : never>;
  names: Map<string, string>;
  onClose: () => void;
}) {
  return (
    <Modal title="Tienda actualizada" onClose={onClose} footer={<Button onClick={onClose}>Listo</Button>}>
      <div className="flex items-center gap-2 rounded-xl bg-money-50 px-3 py-2.5 text-sm text-money-700">
        <CheckCircle2 className="size-4" /> {result.ok} {result.ok === 1 ? 'producto publicado' : 'productos publicados'}
        {result.failed ? `, ${result.failed} con error` : ''}.
      </div>
      <ul className="max-h-80 divide-y divide-line overflow-y-auto text-sm">
        {result.results.map((r) => (
          <li key={r.key} className="py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{names.get(r.key) ?? r.key}</span>
              {r.ok ? (
                <span className="flex items-center gap-2 text-xs">
                  <Pill tone="verde">{r.created ? 'Nuevo' : 'Actualizado'}</Pill>
                  {r.url && (
                    <a href={r.url} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                      Ver
                    </a>
                  )}
                </span>
              ) : (
                <Pill tone="rojo">Error</Pill>
              )}
            </div>
            {r.error && <p className="text-xs text-berry-700">{r.error}</p>}
            {!!r.warnings?.length && (
              <p className="flex items-start gap-1 text-xs text-sun-700">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {r.warnings.length}{' '}
                {r.warnings.length === 1 ? 'foto no se pudo bajar' : 'fotos no se pudieron bajar'}
              </p>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
