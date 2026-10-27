'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, ImageOff, Loader2, Pencil, RefreshCw, Search, Send, Store, Tag, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useSession } from '@/components/session';
import { Button, Card, clp, dmy, Empty, ErrorBox, Field, inputCls, Loading, Modal, parseAmount, Pill, shortDate, todayCL, typingAmount } from '@/components/ui';
import {
  api,
  type RetailApiConnection,
  type RetailApiProduct,
  type RetailChangeStatus,
  type RetailEditable,
  type RetailProductChange,
  type RetailProductChanges,
  type RetailSyncJob,
} from '@/lib/api';
import { cn } from '@/lib/cn';

const STATUS: Record<RetailChangeStatus, { label: string; tone: 'verde' | 'ambar' | 'rojo' | 'azul' }> = {
  ENVIANDO: { label: 'Enviando', tone: 'azul' },
  EN_PROCESO: { label: 'En proceso', tone: 'ambar' },
  APLICADO: { label: 'Aplicado', tone: 'verde' },
  RECHAZADO: { label: 'Rechazado', tone: 'rojo' },
};

const FIELD_LABEL: Record<keyof RetailProductChanges, string> = {
  stock: 'Stock',
  price: 'Precio',
  salePrice: 'Oferta',
  saleFrom: 'Oferta desde',
  saleTo: 'Oferta hasta',
  name: 'Nombre',
  description: 'Descripción',
};

/** Borrador de la tabla: lo que el usuario escribió y aún no envía */
type Draft = { stock?: string; price?: string };
type RowResult = { status: RetailChangeStatus | 'ERROR'; message: string };

/**
 * Productos publicados en cada retailer conectado por API.
 * Stock y precio se editan directo en la tabla; nombre, descripción y ofertas en "Editar".
 */
export function RetailProducts() {
  const { canEdit } = useSession();
  const qc = useQueryClient();
  const conns = useQuery({ queryKey: ['retail-connections'], queryFn: api.retailConnections });
  const connected = (conns.data ?? []).filter((c) => c.enabled && c.configured);
  const [provider, setProvider] = useState<RetailApiConnection['provider'] | null>(null);
  const conn = connected.find((c) => c.provider === provider) ?? connected[0] ?? null;
  const products = useQuery({ queryKey: ['retail-products', conn?.provider], queryFn: () => api.retailProducts(conn!.provider), enabled: !!conn });
  const [search, setSearch] = useState('');
  const [onlyNoStock, setOnlyNoStock] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [editing, setEditing] = useState<RetailApiProduct | null>(null);
  const [sending, setSending] = useState<{ done: number; total: number } | null>(null);

  // Al cambiar de retailer se descarta el borrador
  useEffect(() => {
    setDrafts({});
    setResults({});
  }, [conn?.provider]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (products.data ?? []).filter(
      (p) => (!q || `${p.name} ${p.sellerSku} ${p.retailerSku ?? ''} ${p.brand ?? ''}`.toLowerCase().includes(q)) && (!onlyNoStock || !p.stock),
    );
  }, [products.data, search, onlyNoStock]);

  if (conns.isLoading) return <Loading />;
  if (!connected.length)
    return (
      <Card>
        <Empty
          icon={<Store className="size-6" />}
          title="No hay retailers conectados por API"
          text="Conecta Paris, Falabella o Walmart y aquí verás tus productos publicados para cambiar stock, precios y descripciones sin entrar a cada portal."
          action={
            <Link href="/conexiones" className="text-sm font-medium text-brand-700 hover:underline">
              Ir a Conexiones
            </Link>
          }
        />
      </Card>
    );

  const editable = conn?.editable ?? [];
  const pending = Object.entries(drafts)
    .map(([sku, d]) => {
      const p = products.data?.find((x) => x.sellerSku === sku);
      if (!p) return null;
      const changes: RetailProductChanges = {};
      const stock = d.stock === undefined || d.stock.trim() === '' ? null : Number(d.stock.replace(/\D/g, ''));
      const price = d.price === undefined ? null : parseAmount(d.price);
      if (stock !== null && stock !== p.stock) changes.stock = stock;
      if (price !== null && price !== p.price) changes.price = price;
      return Object.keys(changes).length ? { p, changes } : null;
    })
    .filter((x): x is { p: RetailApiProduct; changes: RetailProductChanges } => x !== null);

  /** Envía uno por uno (así cada fila muestra su resultado) */
  async function sendAll() {
    if (!conn) return;
    setSending({ done: 0, total: pending.length });
    for (const [n, { p, changes }] of pending.entries()) {
      try {
        const r = await api.updateRetailProduct(conn.provider, p.sellerSku, changes);
        setResults((x) => ({ ...x, [p.sellerSku]: r }));
        if (r.status !== 'RECHAZADO') setDrafts(({ [p.sellerSku]: _, ...rest }) => rest);
      } catch (err) {
        setResults((x) => ({ ...x, [p.sellerSku]: { status: 'ERROR', message: err instanceof Error ? err.message : String(err) } }));
      }
      setSending({ done: n + 1, total: pending.length });
    }
    setSending(null);
    qc.invalidateQueries({ queryKey: ['retail-products', conn.provider] });
  }

  const setDraft = (sku: string, patch: Draft) => setDrafts((d) => ({ ...d, [sku]: { ...d[sku], ...patch } }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-xl bg-stone-100 p-1">
          {connected.map((c) => (
            <button
              key={c.provider}
              onClick={() => setProvider(c.provider)}
              className={cn('rounded-lg px-3 py-1.5 text-sm font-medium', c.provider === conn?.provider ? 'bg-white text-ink shadow-sm' : 'text-muted hover:text-ink')}
            >
              {c.label}
            </button>
          ))}
        </div>
        <label className="relative block w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar nombre o SKU" className={cn(inputCls, 'pl-9')} />
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={onlyNoStock} onChange={(e) => setOnlyNoStock(e.target.checked)} className="size-4 accent-brand-600" /> Sin stock
        </label>
        {conn && <SyncProducts conn={conn} />}
      </div>

      {conn && (
        <p className="text-xs text-muted">
          {conn.label} deja cambiar por API: {editable.map((e) => FIELD_LABEL[e].toLowerCase()).join(', ') || 'nada'}.
          {conn.provider === 'FALABELLA' && ' Falabella procesa los cambios en unos minutos: el estado pasa de "En proceso" a "Aplicado".'}
          {conn.provider === 'WALMART' && ' Nombre, descripción y ofertas de Walmart se cambian en su Seller Center.'}
        </p>
      )}

      <ErrorBox error={products.error} />
      {products.isLoading ? (
        <Loading />
      ) : !products.data?.length ? (
        <Card>
          <Empty icon={<Store className="size-6" />} title={`Aún no traes los productos de ${conn?.label}`} text='Usa "Traer productos" para verlos aquí.' />
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line">
              <tr>
                <th className="px-3 py-3 text-left text-xs font-medium tracking-wide text-muted uppercase">Producto</th>
                <th className="px-3 py-3 text-left text-xs font-medium tracking-wide text-muted uppercase">Estado</th>
                <th className="px-3 py-3 text-right text-xs font-medium tracking-wide text-muted uppercase">Stock</th>
                <th className="px-3 py-3 text-right text-xs font-medium tracking-wide text-muted uppercase">Precio</th>
                <th className="px-3 py-3 text-right text-xs font-medium tracking-wide text-muted uppercase">Oferta</th>
                <th className="px-3 py-3 text-left text-xs font-medium tracking-wide text-muted uppercase">Último cambio</th>
                <th className="px-3 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const d = drafts[p.sellerSku] ?? {};
                const r = results[p.sellerSku];
                const changed = pending.some((x) => x.p.sellerSku === p.sellerSku);
                return (
                  <tr key={p.id} className={cn('border-b border-line/60 last:border-0', changed && 'bg-sun-50/60')}>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-3">
                        {p.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.imageUrl} alt="" className="size-10 shrink-0 rounded-lg border border-line object-cover" />
                        ) : (
                          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-stone-100 text-stone-400">
                            <ImageOff className="size-4" />
                          </span>
                        )}
                        <div className="min-w-0">
                          <div className="max-w-sm truncate font-medium" title={p.name ?? ''}>
                            {p.name ?? 'Sin nombre'}
                          </div>
                          <div className="text-xs text-muted">
                            {p.sellerSku}
                            {p.retailerSku && p.retailerSku !== p.sellerSku && ` · ${conn?.label} ${p.retailerSku}`}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted">{p.status ?? '—'}</td>
                    <td className="px-3 py-2 text-right">
                      {canEdit && editable.includes('stock') ? (
                        <input
                          value={d.stock ?? (p.stock ?? '').toString()}
                          onChange={(e) => setDraft(p.sellerSku, { stock: e.target.value.replace(/\D/g, '') })}
                          inputMode="numeric"
                          className={cn(inputCls, 'w-20 px-2 py-1 text-right', p.stock === 0 && d.stock === undefined && 'text-berry-700')}
                        />
                      ) : (
                        (p.stock ?? '—')
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canEdit && editable.includes('price') ? (
                        <input
                          value={d.price ?? (p.price !== null ? typingAmount(String(p.price)) : '')}
                          onChange={(e) => setDraft(p.sellerSku, { price: typingAmount(e.target.value) })}
                          inputMode="numeric"
                          className={cn(inputCls, 'w-28 px-2 py-1 text-right')}
                        />
                      ) : (
                        clp(p.price)
                      )}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {p.salePrice ? (
                        <>
                          <div className="font-medium text-brand-700">{clp(p.salePrice)}</div>
                          {p.saleTo && <div className="text-xs text-muted">hasta {dmy(p.saleTo)}</div>}
                        </>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {r ? (
                        <ResultPill status={r.status} message={r.message} />
                      ) : p.lastChange ? (
                        <ResultPill status={p.lastChange.status} message={p.lastChange.message ?? ''} at={p.lastChange.at} />
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => setEditing(p)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50">
                        <Pencil className="size-3.5" /> {canEdit ? 'Editar' : 'Ver'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length && <p className="px-4 py-6 text-center text-sm text-muted">Ningún producto calza con la búsqueda.</p>}
        </Card>
      )}

      {pending.length > 0 && conn && (
        <div className="sticky bottom-4 z-20 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3 shadow-lg">
          <span className="text-sm">
            <b>{pending.length}</b> {pending.length === 1 ? 'producto con cambios' : 'productos con cambios'} sin enviar
          </span>
          {sending && (
            <span className="flex items-center gap-1.5 text-sm text-muted">
              <Loader2 className="size-4 animate-spin" /> Enviando {sending.done} de {sending.total}…
            </span>
          )}
          <span className="ml-auto flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setDrafts({})} disabled={!!sending}>
              <Undo2 className="size-4" /> Descartar
            </Button>
            <Button size="sm" onClick={sendAll} loading={!!sending}>
              <Send className="size-4" /> Enviar a {conn.label}
            </Button>
          </span>
        </div>
      )}

      {editing && conn && <EditDialog conn={conn} product={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ResultPill({ status, message, at }: { status: RetailChangeStatus | 'ERROR'; message: string; at?: string }) {
  const s = status === 'ERROR' ? { label: 'Error', tone: 'rojo' as const } : STATUS[status];
  return (
    <span title={message} className="inline-flex max-w-56 items-center gap-1.5">
      <Pill tone={s.tone}>{s.label}</Pill>
      <span className="truncate text-xs text-muted">{status === 'RECHAZADO' || status === 'ERROR' ? message : at ? shortDate(at) : ''}</span>
    </span>
  );
}

/** Botón para traer (de nuevo) los productos del retailer, con su avance */
function SyncProducts({ conn }: { conn: RetailApiConnection }) {
  const qc = useQueryClient();
  const { canEdit } = useSession();
  const [job, setJob] = useState<RetailSyncJob | null>(null);
  const start = useMutation({ mutationFn: () => api.syncRetailProducts(conn.provider), onSuccess: setJob });
  useEffect(() => {
    if (!job || job.status !== 'RUNNING') return;
    const t = setTimeout(async () => {
      const next = await api.retailJob(job.id).catch(() => ({ ...job, status: 'ERROR' as const, message: 'Se perdió el avance' }));
      setJob(next);
      if (next.status !== 'RUNNING') {
        qc.invalidateQueries({ queryKey: ['retail-products', conn.provider] });
        qc.invalidateQueries({ queryKey: ['retail-connections'] });
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [job, qc, conn.provider]);
  useEffect(() => setJob(null), [conn.provider]);
  const running = start.isPending || job?.status === 'RUNNING';
  return (
    <span className="ml-auto flex items-center gap-3 text-xs text-muted">
      {running ? (
        <span className="flex items-center gap-1.5 text-ink">
          <Loader2 className="size-3.5 animate-spin" /> {job?.message ?? 'Conectando…'}
        </span>
      ) : job ? (
        <span className={job.status === 'ERROR' ? 'text-berry-700' : 'text-money-700'}>{job.message}</span>
      ) : start.error ? (
        <span className="text-berry-700">{start.error instanceof Error ? start.error.message : 'Error'}</span>
      ) : (
        <span>{conn.lastProductsSyncAt ? `Traídos el ${shortDate(conn.lastProductsSyncAt)}` : 'Aún no se traen'}</span>
      )}
      {canEdit && (
        <Button variant="secondary" size="sm" onClick={() => start.mutate()} disabled={running}>
          <RefreshCw className={cn('size-4', running && 'animate-spin')} /> Traer productos
        </Button>
      )}
    </span>
  );
}

const inDays = (n: number) => {
  const d = new Date(`${todayCL()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Editar un producto en el retailer: nombre, descripción, stock, precio y oferta. Abajo, su historial */
function EditDialog({ conn, product: p, onClose }: { conn: RetailApiConnection; product: RetailApiProduct; onClose: () => void }) {
  const { canEdit } = useSession();
  const qc = useQueryClient();
  const can = (f: RetailEditable) => canEdit && conn.editable.includes(f);
  const [name, setName] = useState(p.name ?? '');
  const [description, setDescription] = useState(p.description ?? '');
  const [stock, setStock] = useState(p.stock === null ? '' : String(p.stock));
  const [price, setPrice] = useState(p.price !== null ? typingAmount(String(p.price)) : '');
  const [sale, setSale] = useState(p.salePrice ? typingAmount(String(p.salePrice)) : '');
  const [from, setFrom] = useState(p.saleFrom ?? todayCL());
  const [to, setTo] = useState(p.saleTo ?? inDays(7));
  const history = useQuery({
    queryKey: ['retail-changes', conn.provider, p.sellerSku],
    queryFn: () => api.retailProductChanges(conn.provider, p.sellerSku),
    // Mientras haya algo en proceso (Falabella), se vuelve a consultar
    refetchInterval: (q) => (q.state.data?.some((c) => c.status === 'EN_PROCESO' || c.status === 'ENVIANDO') ? 5000 : false),
  });

  const changes: RetailProductChanges = {};
  if (can('name') && name.trim() && name.trim() !== (p.name ?? '')) changes.name = name.trim();
  if (can('description') && description.trim() && description.trim() !== (p.description ?? '').trim()) changes.description = description.trim();
  if (can('stock') && stock !== '' && Number(stock) !== p.stock) changes.stock = Number(stock);
  const priceN = parseAmount(price);
  if (can('price') && priceN !== null && priceN !== p.price) changes.price = priceN;
  const saleN = parseAmount(sale);
  if (can('salePrice')) {
    if (!saleN && p.salePrice) changes.salePrice = null;
    else if (saleN && (saleN !== p.salePrice || from !== (p.saleFrom ?? '') || to !== (p.saleTo ?? ''))) Object.assign(changes, { salePrice: saleN, saleFrom: from, saleTo: to });
  }
  const effectivePrice = priceN ?? p.price;
  const saleError = saleN && effectivePrice && saleN >= effectivePrice ? 'La oferta debe ser menor que el precio normal' : saleN && to < from ? 'La fecha de término es anterior al inicio' : null;
  const discount = saleN && effectivePrice && !saleError ? Math.round((1 - saleN / effectivePrice) * 100) : null;

  const save = useMutation({
    mutationFn: () => api.updateRetailProduct(conn.provider, p.sellerSku, changes),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['retail-products', conn.provider] });
      qc.invalidateQueries({ queryKey: ['retail-changes', conn.provider, p.sellerSku] });
    },
  });
  const nothing = Object.keys(changes).length === 0;

  return (
    <Modal
      wide
      title={`${canEdit ? 'Editar' : 'Ver'} en ${conn.label}`}
      intro={
        <>
          {p.sellerSku}
          {p.retailerSku && p.retailerSku !== p.sellerSku && ` · ${conn.label} ${p.retailerSku}`}
          {p.url && (
            <>
              {' · '}
              <a href={p.url} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                ver publicación
              </a>
            </>
          )}
        </>
      }
      onClose={onClose}
      footer={
        <>
          {save.data && (
            <span className="mr-auto self-center">
              <ResultPill status={save.data.status} message={save.data.message} />
              <span className="ml-2 text-xs text-muted">{save.data.status !== 'RECHAZADO' && save.data.message}</span>
            </span>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cerrar
          </Button>
          {canEdit && (
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={nothing || !!saleError}>
              <Send className="size-4" /> Enviar a {conn.label}
            </Button>
          )}
        </>
      }
    >
      <Field label="Nombre" hint={!can('name') && canEdit ? `${conn.label} no deja cambiarlo por API` : undefined}>
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={!can('name')} className={inputCls} maxLength={300} />
      </Field>
      <Field label="Descripción" hint={!can('description') && canEdit ? `${conn.label} no deja cambiarla por API` : conn.provider === 'CENCOSUD' ? 'En Paris cambia la ficha completa del producto (todas sus variantes).' : undefined}>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={!can('description')} rows={5} className={inputCls} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Stock">
          <input value={stock} onChange={(e) => setStock(e.target.value.replace(/\D/g, ''))} disabled={!can('stock')} inputMode="numeric" className={inputCls} />
        </Field>
        <Field label="Precio normal (con IVA)">
          <input value={price} onChange={(e) => setPrice(typingAmount(e.target.value))} disabled={!can('price')} inputMode="numeric" className={inputCls} />
        </Field>
      </div>
      <div className="rounded-xl border border-line p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <Tag className="size-4 text-brand-700" /> Oferta
          {discount !== null && <Pill tone="verde">-{discount}%</Pill>}
          {!can('salePrice') && canEdit && <span className="text-xs font-normal text-muted">{conn.label} no deja cambiarla por API</span>}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Precio oferta" hint="Déjalo vacío para quitar la oferta">
            <input value={sale} onChange={(e) => setSale(typingAmount(e.target.value))} disabled={!can('salePrice')} inputMode="numeric" className={inputCls} />
          </Field>
          <Field label="Desde">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} disabled={!can('salePrice') || !saleN} className={inputCls} />
          </Field>
          <Field label="Hasta">
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} disabled={!can('salePrice') || !saleN} className={inputCls} />
          </Field>
        </div>
        {saleError && <p className="mt-2 text-sm text-berry-700">{saleError}</p>}
      </div>
      <ErrorBox error={save.error} />

      <div>
        <div className="mb-2 flex items-center gap-2 text-sm font-medium">
          <History className="size-4 text-muted" /> Cambios enviados
        </div>
        {history.isLoading ? (
          <Loading />
        ) : !history.data?.length ? (
          <p className="text-sm text-muted">Aún no se envían cambios desde Cuadra.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line text-sm">
            {history.data.map((c) => (
              <ChangeRow key={c.id} c={c} />
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function fmt(k: keyof RetailProductChanges, v: unknown) {
  if (v === null || v === undefined) return k === 'salePrice' ? 'sin oferta' : '—';
  if (k === 'price' || k === 'salePrice') return clp(Number(v));
  if (k === 'saleFrom' || k === 'saleTo') return dmy(String(v));
  if (k === 'description') return `"${String(v).slice(0, 40)}${String(v).length > 40 ? '…' : ''}"`;
  return String(v);
}

function ChangeRow({ c }: { c: RetailProductChange }) {
  const keys = (Object.keys(c.changes) as (keyof RetailProductChanges)[]).filter((k) => k !== 'saleFrom' && k !== 'saleTo');
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2">
      <Pill tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Pill>
      <div className="min-w-0 flex-1">
        {keys.map((k) => (
          <div key={k}>
            <span className="text-muted">{FIELD_LABEL[k]}:</span> {c.before && k in c.before && <span className="text-muted line-through">{fmt(k, c.before[k])}</span>}{' '}
            {fmt(k, c.changes[k])}
            {k === 'salePrice' && c.changes.salePrice && c.changes.saleFrom && (
              <span className="text-muted">
                {' '}
                ({dmy(c.changes.saleFrom)} al {dmy(c.changes.saleTo)})
              </span>
            )}
          </div>
        ))}
        {c.status === 'RECHAZADO' && c.message && <div className="text-xs text-berry-700">{c.message}</div>}
      </div>
      <span className="text-xs whitespace-nowrap text-muted">
        {shortDate(c.createdAt)}
        {c.createdBy && ` · ${c.createdBy}`}
      </span>
    </li>
  );
}
