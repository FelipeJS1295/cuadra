'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CloudUpload, FileText, PackageCheck, Printer, RefreshCw, Search, Send, ShoppingBag, Truck, Upload } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { BulkDialog, SelectionBar, type BulkKind } from '@/components/bulk-actions';
import { SaleDetail } from '@/components/sale-detail';
import { useSession } from '@/components/session';
import { Button, Card, clp, Empty, ErrorBox, Loading, monthRange, MonthPicker, Page, Pill, dmy, Tabs, td, th, todayCL } from '@/components/ui';
import { DispatchBoard } from '@/components/dispatch-board';
import { FacturaLote } from '@/components/factura-lote';
import { ParisPickups } from '@/components/paris-logistics';
import { RetailLabels } from '@/components/retail-labels';
import { SendToSupplier } from '@/components/send-to-supplier';
import { SyncDialog } from '@/components/sync-dialog';
import { UploadDialog } from '@/components/upload';
import { ORDER_STATE_INFO, ORDER_STATES, type OrderState } from '@cuadra/shared';
import { api, type SaleRow } from '@/lib/api';
import { cn } from '@/lib/cn';

type Filter = 'todas' | 'sin-boleta' | 'falta-retail' | 'sin-pago' | 'sin-factura' | 'sin-costo' | 'listas' | 'canceladas';

const FILTERS: { id: Filter; label: string; match: (s: SaleRow) => boolean }[] = [
  { id: 'todas', label: 'Todas', match: () => true },
  {
    id: 'sin-boleta',
    label: 'Sin boleta',
    match: (s) => !s.cancelled && !s.receipt,
  },
  // El retailer (Paris, Falabella, Ripley) aún no tiene la boleta, o falló el envío
  {
    id: 'falta-retail',
    label: 'Falta en retail',
    match: (s) => !s.cancelled && (s.receipt?.retailStatus === 'FALTA' || s.receipt?.retailStatus === 'ERROR'),
  },
  {
    id: 'sin-pago',
    label: 'Esperando pago',
    match: (s) => !s.cancelled && s.settlementNet === null,
  },
  {
    id: 'sin-factura',
    label: 'Sin factura proveedor',
    match: (s) => !s.cancelled && s.supplierGross === null,
  },
  {
    id: 'sin-costo',
    label: 'Sin costo',
    match: (s) => !s.cancelled && s.cost === null,
  },
  { id: 'listas', label: 'Listas', match: (s) => s.total !== null },
  { id: 'canceladas', label: 'Canceladas', match: (s) => s.cancelled },
];

/** Celdas más angostas: la tabla de ventas tiene muchas columnas */
const thc = th.replace('px-4', 'px-3');
const tdc = td.replace('px-4', 'px-3');

const Dash = () => <span className="text-stone-300">—</span>;

/** Monto; si es estimado, con "≈" y más suave */
function Amount({ value, estimated }: { value: number; estimated?: boolean }) {
  return (
    <p className={cn(estimated && 'text-ink/70')} title={estimated ? 'Estimado: aún falta la liquidación o la factura del proveedor' : undefined}>
      {estimated && '≈ '}
      {clp(value)}
    </p>
  );
}

/** Retailers que reciben las boletas por API */
const RECEIPT_UPLOAD = ['CENCOSUD', 'FALABELLA', 'RIPLEY'];

/** Nombre corto del retailer (sin "· Fulfillment") */
const retailerShort = (s: SaleRow) => s.retailer.split(' · ')[0];

const sumOf = (rows: SaleRow[], f: (s: SaleRow) => number | null) => rows.reduce((n, s) => n + (f(s) ?? 0), 0);

/** Boleta o factura de la venta: la emitida, o la que falta */
function DocumentCell({ s }: { s: SaleRow }) {
  const r = s.receipt;
  if (r) {
    const kind = r.documentType === 33 ? 'Factura' : 'Boleta';
    const draft = r.status === 'BORRADOR' || r.status === 'EMITIENDO' || r.status === 'REVISAR';
    return (
      <>
        <p className="font-medium">
          {kind} {draft ? '' : `N° ${r.number}`}
        </p>
        <p className={cn('text-xs', draft ? 'text-sun-700' : 'text-muted')}>
          {r.status === 'BORRADOR'
            ? 'borrador por firmar'
            : r.status === 'REVISAR'
              ? 'revisar en el SII'
              : r.status === 'EMITIENDO'
                ? 'emitiendo…'
                : r.creditNotes > 0
                  ? 'con nota de crédito'
                  : r.status === 'EMITIDA'
                    ? 'emitida'
                    : 'anotada'}
          {r.retailStatus === 'ENVIADA' && <span className="text-money-700"> · en {retailerShort(s)} ✓</span>}
        </p>
        {r.retailStatus === 'ERROR' && (
          <p className="text-xs text-berry-700" title={r.retailMessage ?? undefined}>
            no llegó a {retailerShort(s)}
          </p>
        )}
        {r.retailStatus === 'FALTA' && (
          <p className="text-xs text-sun-700" title={r.retailMessage ?? undefined}>
            {retailerShort(s)} aún no la tiene
          </p>
        )}
      </>
    );
  }
  if (s.cancelled) return <span className="text-xs text-muted">No necesita</span>;
  return (
    <>
      <Pill tone="rojo">Falta {s.documentRequested === 'FACTURA' ? 'factura' : 'boleta'}</Pill>
      {s.documentRequested === 'FACTURA' && <p className="mt-1 text-xs text-muted">el cliente pidió factura</p>}
    </>
  );
}

export default function SalesPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Sales />
    </Suspense>
  );
}

function Sales() {
  const params = useSearchParams();
  const { canEdit, isFactory } = useSession();
  const qc = useQueryClient();
  const [month, setMonth] = useState(todayCL().slice(0, 7));
  const [filter, setFilter] = useState<Filter>((params.get('filtro') as Filter) ?? 'todas');
  const [search, setSearch] = useState('');
  const [retailer, setRetailer] = useState(params.get('retailer') ?? '');
  const [stateFilter, setStateFilter] = useState<OrderState | ''>('');
  const [upload, setUpload] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [board, setBoard] = useState(false);
  const [sending, setSending] = useState(false);
  const [facturing, setFacturing] = useState(false);
  const [pickups, setPickups] = useState(false);
  const [labels, setLabels] = useState(false);
  // Envíame (Paris): retiros y etiquetas
  const enviame = useQuery({ queryKey: ['enviame-status'], queryFn: api.enviameStatus, staleTime: 300_000 });
  const labelProviders = useQuery({ queryKey: ['label-providers'], queryFn: api.labelProviders, staleTime: 300_000 });
  const [detail, setDetail] = useState<SaleRow | null>(null);
  const [bulk, setBulk] = useState<{ kind: BulkKind; sales: SaleRow[] } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const range = monthRange(month);
  const sales = useQuery({
    queryKey: ['sales', range.from, range.to],
    queryFn: () => api.listSales(range.from, range.to),
  });
  const sii = useQuery({
    queryKey: ['sii-status'],
    queryFn: api.siiStatus,
    staleTime: 300_000,
  });
  const everything = sales.data ?? [];
  const retailerOptions = useMemo(() => [...new Map(everything.map((s) => [s.retailerCode, s.retailer.split(' · ')[0]])).entries()], [everything]);
  const all = useMemo(
    () => everything.filter((s) => (!retailer || s.retailerCode === retailer) && (!stateFilter || s.state === stateFilter)),
    [everything, retailer, stateFilter],
  );
  const stateOptions = useMemo(() => ORDER_STATES.filter((st) => everything.some((s) => s.state === st)), [everything]);
  const rows = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter)!;
    const q = search.trim().toLowerCase();
    return all.filter(
      (s) =>
        f.match(s) && (!q || [s.orderLabel, s.orderNumber, s.productName, s.retailName, s.parentSku, s.retailer].some((v) => v?.toLowerCase().includes(q))),
    );
  }, [all, filter, search]);
  const withoutReceipt = all.filter((s) => !s.cancelled && !s.receipt && s.orderNumber && s.documentRequested === 'BOLETA');
  // Paris y Falabella piden la boleta en su portal: las emitidas desde Cuadra que aún no les llegan
  const conns = useQuery({
    queryKey: ['retail-connections'],
    queryFn: api.retailConnections,
    enabled: canEdit,
    staleTime: 300_000,
  });
  const uploadPending = (conns.data ?? [])
    .filter((c) => RECEIPT_UPLOAD.includes(c.provider) && c.enabled && c.configured)
    .map((c) => ({
      code: c.provider,
      label: c.label,
      count: everything.filter(
        (s) => s.retailerCode === c.provider && !s.retailer.includes('Fulfillment') && s.receipt?.status === 'EMITIDA' && s.receipt.retailStatus !== 'ENVIADA',
      ).length,
    }))
    .filter((x) => x.count > 0);
  const pendingTotal = uploadPending.reduce((n, r) => n + r.count, 0);
  // Se envían retailer por retailer; el resultado junta todo
  const sendRetail = useMutation({
    mutationFn: async () => {
      let sent = 0;
      let failed = 0;
      const results: {
        orderNumber: string;
        ok: boolean;
        message: string;
        retailer: string;
      }[] = [];
      for (const r of uploadPending) {
        try {
          const res = await api.sendPendingReceipts(r.code);
          sent += res.sent;
          failed += res.failed;
          results.push(...res.results);
        } catch (err) {
          failed += r.count;
          results.push({
            orderNumber: r.label,
            ok: false,
            message: (err as Error).message,
            retailer: r.label,
          });
        }
      }
      return {
        sent,
        failed,
        results,
        label: uploadPending.length === 1 ? uploadPending[0].label : 'los retailers',
      };
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['sales'] }),
  });
  const chosen = everything.filter((s) => selected.has(s.key));
  const allShown = rows.length > 0 && rows.every((s) => selected.has(s.key));
  const toggle = (key: string) =>
    setSelected((x) => {
      const n = new Set(x);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const toggleAll = () =>
    setSelected((x) => {
      const n = new Set(x);
      for (const s of rows) {
        if (allShown) n.delete(s.key);
        else n.add(s.key);
      }
      return n;
    });

  return (
    <Page
      wide
      title="Ventas"
      intro="Todas las órdenes que te llegaron de los retailers y qué le falta a cada una para estar cerrada."
      help={
        <>
          <p>
            Una venta está <b>lista</b> cuando tiene boleta, el retailer ya te pagó (viene en su liquidación) y{' '}
            {isFactory ? 'tiene su costo de fabricación (receta de insumos).' : 'tienes la factura del proveedor.'}
          </p>
          <p>Con eso Cuadra calcula cuánto ganaste en esa venta. Haz clic en cualquier venta para verla paso a paso.</p>
        </>
      }
      actions={
        <>
          <Button variant="secondary" onClick={() => setBoard(true)}>
            <Truck className="size-4" /> Maestra de despachos
          </Button>
          {canEdit && enviame.data?.connected && (
            <Button variant="secondary" onClick={() => setPickups(true)}>
              <CalendarClock className="size-4" /> Retiros Paris
            </Button>
          )}
          {canEdit && (
            <>
              <Button variant="secondary" onClick={() => setUpload(true)}>
                <Upload className="size-4" /> Subir ventas
              </Button>
              <Button variant="secondary" onClick={() => setSyncing(true)}>
                <RefreshCw className="size-4" /> Actualizar ventas
              </Button>
              {pendingTotal > 0 && (
                <Button
                  variant="secondary"
                  onClick={() => sendRetail.mutate()}
                  loading={sendRetail.isPending}
                  title={uploadPending.map((r) => `${r.label}: ${r.count}`).join(' · ')}
                >
                  <CloudUpload className="size-4" /> Enviar {pendingTotal} {pendingTotal === 1 ? 'boleta' : 'boletas'} a{' '}
                  {uploadPending.length === 1 ? uploadPending[0].label : 'retailers'}
                </Button>
              )}
              {sii.data?.can.boletas && withoutReceipt.length > 0 && (
                <Button onClick={() => setBulk({ kind: 'boletas', sales: withoutReceipt })}>
                  <Send className="size-4" /> Emitir {withoutReceipt.length} boletas
                </Button>
              )}
            </>
          )}
        </>
      }
    >
      {(sendRetail.data || sendRetail.error) && (
        <div
          className={cn(
            'mb-4 rounded-xl border px-4 py-3 text-sm',
            sendRetail.error || sendRetail.data?.failed ? 'border-berry-100 bg-berry-50 text-berry-700' : 'border-money-100 bg-money-50 text-money-700',
          )}
        >
          {sendRetail.error ? (
            (sendRetail.error as Error).message
          ) : (
            <>
              {sendRetail.data!.sent} {sendRetail.data!.sent === 1 ? 'boleta enviada' : 'boletas enviadas'} a {sendRetail.data!.label}
              {sendRetail.data!.failed > 0 && ` · ${sendRetail.data!.failed} no se pudieron enviar:`}
              {sendRetail
                .data!.results.filter((r) => !r.ok)
                .slice(0, 5)
                .map((r) => (
                  <span key={`${r.retailer}-${r.orderNumber}`} className="block text-xs">
                    {r.retailer} {r.orderNumber}: {r.message}
                  </span>
                ))}
            </>
          )}
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <MonthPicker
          value={month}
          onChange={(m) => {
            setMonth(m);
            setSelected(new Set());
          }}
        />
        <select
          value={retailer}
          onChange={(e) => setRetailer(e.target.value)}
          className="rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand-500"
        >
          <option value="">Todos los retailers</option>
          {retailerOptions.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
          {retailer && !retailerOptions.some(([code]) => code === retailer) && <option value={retailer}>{retailer}</option>}
        </select>
        <select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value as OrderState | '')}
          className="rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand-500"
        >
          <option value="">Todos los estados</option>
          {stateOptions.map((st) => (
            <option key={st} value={st}>
              {ORDER_STATE_INFO[st].label} ({everything.filter((s) => s.state === st).length})
            </option>
          ))}
        </select>
        <label className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar orden o producto"
            className="w-64 rounded-xl border border-line bg-white py-2 pr-3 pl-9 text-sm outline-none focus:border-brand-500"
          />
        </label>
      </div>
      <div className="mb-4">
        <Tabs
          value={filter}
          onChange={setFilter}
          items={FILTERS.filter((f) => !(isFactory && f.id === 'sin-factura') && !(f.id === 'falta-retail' && filter !== f.id && !all.some(f.match))).map(
            (f) => ({
              id: f.id,
              label: f.label,
              count: all.filter(f.match).length,
            }),
          )}
        />
      </div>

      <ErrorBox error={sales.error} />
      <Card>
        {sales.isLoading ? (
          <Loading />
        ) : all.length === 0 ? (
          <Empty
            icon={<ShoppingBag className="size-6" />}
            title="No hay ventas en este mes"
            text="Sube el reporte de órdenes de tus retailers, o conéctalos por API en Configuración → Conexiones para que lleguen solas."
            action={canEdit && <Button onClick={() => setUpload(true)}>Subir ventas</Button>}
          />
        ) : rows.length === 0 ? (
          <Empty title="Nada por aquí" text="Ninguna venta calza con este filtro." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1240px] text-sm">
              <thead className="border-b border-line">
                <tr>
                  {canEdit && (
                    <th className={cn(thc, 'w-10 pr-0')}>
                      <input type="checkbox" checked={allShown} onChange={toggleAll} aria-label="Elegir todas" className="size-4 accent-brand-600" />
                    </th>
                  )}
                  <th className={thc} title="Fecha en que hay que despachar (entregar al courier)">
                    Despacho
                  </th>
                  <th className={thc}>Cliente</th>
                  <th className={thc}>OC</th>
                  <th className={thc}>Producto</th>
                  <th className={thc}>Estado</th>
                  <th className={cn(thc, 'text-right whitespace-nowrap')} title="Lo que pagó el cliente: producto + envío, con IVA">
                    Venta + envío
                  </th>
                  <th className={cn(thc, 'text-right')} title={isFactory ? 'Costo de los insumos, con IVA' : 'Lo que le pagas al proveedor, con IVA'}>
                    Costo
                  </th>
                  <th className={cn(thc, 'text-right')} title="Lo que se queda el retailer: comisión, envío y otros cobros">
                    Liquidación
                  </th>
                  <th className={cn(thc, 'text-right')} title="Venta − costo − IVA − liquidación">
                    Utilidad
                  </th>
                  <th className={thc}>Documento</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((s) => {
                  const st = ORDER_STATE_INFO[s.state];
                  return (
                    <tr
                      key={s.key}
                      onClick={() => setDetail(s)}
                      className={cn(
                        'cursor-pointer align-top hover:bg-stone-50',
                        s.cancelled && 'opacity-60',
                        selected.has(s.key) && 'bg-brand-50/60 hover:bg-brand-50',
                      )}
                    >
                      {canEdit && (
                        <td className={cn(tdc, 'w-10 pr-0')} onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selected.has(s.key)}
                            onChange={() => toggle(s.key)}
                            aria-label="Elegir venta"
                            className="size-4 accent-brand-600"
                          />
                        </td>
                      )}
                      <td className={cn(tdc, 'num whitespace-nowrap text-muted')} title={`Compra: ${dmy(s.orderDate)}`}>
                        {s.dispatchDeadline ? (
                          <span
                            className={cn(
                              !s.cancelled && s.state !== 'ENTREGADA' && s.state !== 'EN_CAMINO' && s.dispatchDeadline < todayCL() && 'text-berry-700',
                            )}
                          >
                            {dmy(s.dispatchDeadline)}
                          </span>
                        ) : (
                          <span className="text-muted/70">sin fecha</span>
                        )}
                      </td>
                      <td className={cn(tdc, 'whitespace-nowrap font-medium')}>{s.retailer}</td>
                      <td className={cn(tdc, 'whitespace-nowrap')}>
                        <p className="num">{s.orderLabel ?? s.orderNumber}</p>
                        {s.source === 'API' && (
                          <span
                            title="Llegó sola por la conexión con el retailer"
                            className="rounded-full bg-sky-50 px-1.5 py-px text-[10px] font-semibold text-sky-700"
                          >
                            API
                          </span>
                        )}
                        {s.source === 'CLIENTE' && (
                          <span
                            title="Te la envió tu cliente desde Cuadra"
                            className="rounded-full bg-brand-50 px-1.5 py-px text-[10px] font-semibold text-brand-700"
                          >
                            CUADRA
                          </span>
                        )}
                        {s.sentToSupplier && (
                          <p className="mt-0.5 text-xs text-money-700" title={`Enviada a ${s.sentToSupplier} por Cuadra`}>
                            → {s.sentToSupplier}
                          </p>
                        )}
                      </td>
                      <td className={cn(tdc, 'min-w-40 max-w-60')}>
                        <p className="line-clamp-2" title={s.retailName ? `En ${s.retailer}: ${s.retailName}` : (s.productName ?? undefined)}>
                          {s.productName ?? 'Producto'}
                        </p>
                        {s.parentSku && <p className="mt-0.5 truncate text-xs text-muted">{s.parentSku}</p>}
                      </td>
                      <td className={cn(tdc, 'whitespace-nowrap')}>
                        <span title={s.statusRaw ? `${st.help}. Retailer: ${s.statusRaw}` : st.help}>
                          <Pill tone={st.tone}>{s.state === 'OTRO' && s.statusRaw ? s.statusRaw : st.label}</Pill>
                        </span>
                      </td>
                      <td className={cn(tdc, 'num text-right whitespace-nowrap')}>
                        <p className={cn(s.cancelled && 'line-through')}>{clp(s.cancelled ? s.salePrice : s.saleTotal)}</p>
                        {s.shippingPrice > 0 && <p className="text-xs text-muted">envío {clp(s.shippingPrice)}</p>}
                      </td>
                      <td className={cn(tdc, 'num text-right whitespace-nowrap')}>
                        {s.cancelled ? (
                          <Dash />
                        ) : s.costGross !== null ? (
                          <>
                            <Amount value={s.costGross} estimated={s.costSource === 'ESTIMADO'} />
                            <p className="text-xs text-muted">
                              {s.costSource === 'FACTURA' ? 'factura proveedor' : s.costSource === 'RECETA' ? 'insumos' : 'según producto'}
                            </p>
                          </>
                        ) : (
                          <span className="text-xs font-medium text-sun-700">Sin costo</span>
                        )}
                      </td>
                      <td className={cn(tdc, 'num text-right whitespace-nowrap')}>
                        {s.cancelled || s.settlementCharges === null ? (
                          <Dash />
                        ) : (
                          <>
                            <Amount value={s.settlementCharges} estimated={s.settlementEstimated} />
                            <p className="text-xs text-muted">{s.settlementEstimated ? 'según contrato' : 'pagada'}</p>
                          </>
                        )}
                      </td>
                      <td className={cn(tdc, 'num text-right whitespace-nowrap')}>
                        {s.cancelled ? (
                          <Dash />
                        ) : s.utility !== null ? (
                          <>
                            <p className={cn('font-semibold', s.utility >= 0 ? 'text-money-700' : 'text-berry-700')}>
                              {s.utilityEstimated && '≈ '}
                              {clp(s.utility)}
                            </p>
                            <p className="text-xs text-muted">
                              {s.saleTotal ? `${Math.round((s.utility / s.saleTotal) * 100)}%` : ''}
                              {s.utilityEstimated ? ' · estimada' : ' · real'}
                            </p>
                          </>
                        ) : (
                          <Dash />
                        )}
                      </td>
                      <td className={cn(tdc, 'whitespace-nowrap')}>
                        <DocumentCell s={s} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="border-t-2 border-line bg-stone-50/60 text-sm">
                <tr>
                  <td className={cn(tdc, 'font-medium')} colSpan={canEdit ? 6 : 5}>
                    {rows.length} {rows.length === 1 ? 'venta' : 'ventas'}
                  </td>
                  <td className={cn(tdc, 'num text-right font-semibold')}>{clp(sumOf(rows, (s) => (s.cancelled ? 0 : s.saleTotal)))}</td>
                  <td className={cn(tdc, 'num text-right font-semibold')}>{clp(sumOf(rows, (s) => (s.cancelled ? 0 : s.costGross)))}</td>
                  <td className={cn(tdc, 'num text-right font-semibold')}>{clp(sumOf(rows, (s) => (s.cancelled ? 0 : s.settlementCharges)))}</td>
                  <td className={cn(tdc, 'num text-right font-semibold text-money-700')}>
                    {rows.some((s) => s.utilityEstimated) && '≈ '}
                    {clp(sumOf(rows, (s) => (s.cancelled ? 0 : s.utility)))}
                  </td>
                  <td className={tdc} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      {upload && <UploadDialog kind="ventas" onClose={() => setUpload(false)} />}
      {syncing && <SyncDialog onClose={() => setSyncing(false)} />}
      {board && <DispatchBoard onClose={() => setBoard(false)} />}
      {pickups && <ParisPickups onClose={() => setPickups(false)} />}
      {labels && (
        <RetailLabels
          sales={chosen}
          onClose={() => {
            setLabels(false);
            setSelected(new Set());
          }}
        />
      )}
      {facturing && (
        <FacturaLote
          sales={chosen}
          onClose={() => {
            setFacturing(false);
            setSelected(new Set());
          }}
        />
      )}
      {sending && (
        <SendToSupplier
          sales={chosen}
          onClose={() => {
            setSending(false);
            setSelected(new Set());
          }}
        />
      )}
      {detail && (
        <SaleDetail
          sale={detail}
          siiEnabled={Boolean(sii.data?.can.boletas)}
          siiConnected={Boolean(sii.data?.enabled)}
          siiProvider={sii.data?.providerName}
          onClose={() => setDetail(null)}
        />
      )}
      {chosen.length > 0 && !bulk && (
        <SelectionBar
          selected={chosen}
          sii={sii.data}
          onAction={(kind) => setBulk({ kind, sales: chosen })}
          onClear={() => setSelected(new Set())}
          extra={
            <>
              {/* Ventas que envió un cliente de Cuadra: una sola factura para varias */}
              {chosen.length > 0 && chosen.every((s) => s.retailerCode.startsWith('CLI-')) && (
                <button
                  onClick={() => setFacturing(true)}
                  disabled={!sii.data?.can.facturas || new Set(chosen.map((s) => s.retailerCode)).size > 1}
                  title={
                    !sii.data?.can.facturas
                      ? 'Conecta el SII para emitir facturas'
                      : new Set(chosen.map((s) => s.retailerCode)).size > 1
                        ? 'Elige ventas de un solo cliente'
                        : undefined
                  }
                  className="inline-flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-1.5 font-medium hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <FileText className="size-4" /> Una factura ({chosen.length})
                </button>
              )}
              {/* Etiquetas de despacho desde la API de cada retailer */}
              {canEdit && (labelProviders.data?.length ?? 0) > 0 && (
                <button
                  onClick={() => setLabels(true)}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-1.5 font-medium hover:bg-white/20"
                >
                  <Printer className="size-4" /> Etiquetas
                </button>
              )}
              {/* Empresas de compra y venta: enviar las ventas al proveedor (si usa Cuadra) */}
              {!isFactory && (
                <button
                  onClick={() => setSending(true)}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-1.5 font-medium hover:bg-white/20"
                >
                  <PackageCheck className="size-4" /> Enviar al proveedor
                </button>
              )}
            </>
          }
        />
      )}
      {bulk && (
        <BulkDialog
          kind={bulk.kind}
          sales={bulk.sales}
          sii={sii.data}
          onClose={() => {
            setBulk(null);
            setSelected(new Set());
            qc.invalidateQueries({ queryKey: ['sales'] });
          }}
        />
      )}
    </Page>
  );
}
