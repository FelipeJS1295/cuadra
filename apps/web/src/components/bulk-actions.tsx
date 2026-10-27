'use client';

import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleDashed, FileMinus, FileText, Loader2, Send, X, XCircle } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, type FacturaLotePreview, type FacturaReceptor, type RetailSend, type SaleRow, type SiiStatus } from '@/lib/api';
import { InvoicePreview } from './invoice-preview';
import { cn } from '@/lib/cn';
import { Button, clp, Field, inputCls, Modal } from './ui';

export type BulkKind = 'boletas' | 'facturas' | 'notas';

/** Una orden elegida: si se le puede hacer el documento y, si no, por qué */
interface Candidate {
  sale: SaleRow;
  ok: boolean;
  why?: string;
  /** Notas de crédito: lo que queda por rebajar de la boleta */
  amount?: number;
}

const label = (s: SaleRow) => `${s.retailer.split(' · ')[0]} ${s.orderLabel ?? s.orderNumber}`;

/** Qué órdenes de la selección sirven para cada acción */
export function candidates(kind: BulkKind, sales: SaleRow[]): Candidate[] {
  return sales.map((sale) => {
    if (!sale.orderNumber) return { sale, ok: false, why: 'sin número de orden' };
    if (kind === 'notas') {
      if (!sale.receipt) return { sale, ok: false, why: 'no tiene boleta' };
      if (!['EMITIDA', 'REGISTRADA'].includes(sale.receipt.status)) return { sale, ok: false, why: 'su boleta aún no está emitida' };
      const amount = sale.receipt.totalGross - sale.receipt.creditNotes;
      if (amount <= 0) return { sale, ok: false, why: 'ya está anulada' };
      if (sale.receipt.draftCreditNotes > 0) return { sale, ok: false, why: 'ya tiene una nota en borrador' };
      return { sale, ok: true, amount };
    }
    if (sale.cancelled) return { sale, ok: false, why: 'está cancelada' };
    if (sale.receipt) return { sale, ok: false, why: `ya tiene ${sale.receipt.documentType === 33 ? 'factura' : 'boleta'}` };
    if (kind === 'boletas' && sale.documentRequested === 'FACTURA') return { sale, ok: false, why: 'el cliente pidió factura' };
    if (kind === 'facturas' && sale.documentRequested !== 'FACTURA') return { sale, ok: false, why: 'el cliente no pidió factura' };
    return { sale, ok: true };
  });
}

const TITLES: Record<BulkKind, { title: string; verb: string; icon: typeof Send }> = {
  boletas: { title: 'Emitir boletas', verb: 'Emitir', icon: Send },
  facturas: { title: 'Crear facturas', verb: 'Crear', icon: FileText },
  notas: { title: 'Notas de crédito', verb: 'Crear', icon: FileMinus },
};

const REASONS = ['Venta cancelada', 'Devolución del cliente', 'Error en la boleta'];

type Result = { state: 'pendiente' | 'trabajando' | 'ok' | 'error'; message?: string };

/** Hace la boleta, factura o nota de crédito de varias órdenes, una por una, mostrando cómo va cada una */
export function BulkDialog({ kind, sales, sii, onClose }: { kind: BulkKind; sales: SaleRow[]; sii: SiiStatus | undefined; onClose: () => void }) {
  const qc = useQueryClient();
  const list = candidates(kind, sales);
  const ready = list.filter((c) => c.ok);
  const skipped = list.filter((c) => !c.ok);
  const [reason, setReason] = useState(REASONS[0]);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [running, setRunning] = useState(false);
  const done = ready.length > 0 && ready.every((c) => ['ok', 'error'].includes(results[c.sale.key]?.state ?? ''));
  const okCount = ready.filter((c) => results[c.sale.key]?.state === 'ok').length;
  const errCount = ready.filter((c) => results[c.sale.key]?.state === 'error').length;
  const { title, verb } = TITLES[kind];
  const provider = sii?.providerName ?? 'el SII';

  const set = (key: string, r: Result) => setResults((x) => ({ ...x, [key]: r }));

  // Facturas: datos del receptor de cada orden (Cuadra completa lo que puede; el resto se escribe aquí)
  const [receptors, setReceptors] = useState<Record<string, FacturaReceptor | 'error'>>({});
  // Factura de cada orden como se va a emitir (líneas, neto, IVA, total)
  const [invoices, setInvoices] = useState<Record<string, FacturaLotePreview>>({});
  const readyKeys = ready.map((c) => c.sale.key).join('|');
  useEffect(() => {
    if (kind !== 'facturas') return;
    let alive = true;
    (async () => {
      for (const c of ready) {
        const p = await api.facturaLotePreview(c.sale.retailerCode, [c.sale.orderNumber!]).catch(() => null);
        if (!alive) return;
        if (p) setInvoices((x) => ({ ...x, [c.sale.key]: p }));
        setReceptors((x) => ({ ...x, [c.sale.key]: p ? p.receptor : 'error' }));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, readyKeys]);
  const missingOf = (r: FacturaReceptor | 'error' | undefined) =>
    !r || r === 'error' ? [] : (['rut', 'name', 'activity', 'address', 'commune'] as const).filter((k) => !r[k]?.trim());
  const loadingReceptors = kind === 'facturas' && ready.some((c) => receptors[c.sale.key] === undefined);
  const incomplete = kind === 'facturas' ? ready.filter((c) => results[c.sale.key]?.state !== 'ok' && missingOf(receptors[c.sale.key]).length > 0) : [];
  /** Al escribir un dato, se completa también en las otras órdenes del mismo RUT que lo tengan vacío */
  const editReceptor = (key: string, field: keyof FacturaReceptor, value: string) =>
    setReceptors((x) => {
      const cur = x[key];
      if (!cur || cur === 'error') return x;
      const next = { ...x, [key]: { ...cur, [field]: value } };
      for (const [k, r] of Object.entries(x)) if (k !== key && r !== 'error' && r.rut && r.rut === cur.rut && !r[field]?.trim()) next[k] = { ...r, [field]: value };
      return next;
    });

  async function one(c: Candidate): Promise<string> {
    const s = c.sale;
    if (kind === 'boletas') {
      const r = await api.emitBoleta(s.retailerCode, s.orderNumber!);
      return `Boleta N° ${r.folio}${retailNote(r.retail)}`;
    }
    if (kind === 'facturas') {
      const known = receptors[c.sale.key];
      const r = known && known !== 'error' ? known : (await api.facturaPreview(s.retailerCode, s.orderNumber!)).receptor;
      const missing = [!r.rut && 'RUT', !r.name && 'razón social', !r.activity && 'giro', !r.address && 'dirección', !r.commune && 'comuna'].filter(Boolean);
      if (missing.length) throw new Error(`Faltan datos de facturación (${missing.join(', ')})`);
      const res = await api.createFactura({ retailerCode: s.retailerCode, orderNumber: s.orderNumber!, receptor: r });
      return res.folio ? `Factura N° ${res.folio}${retailNote(res.retail)}` : `Borrador N° ${res.draftCode}`;
    }
    const res = await api.draftCreditNote({ retailerCode: s.retailerCode, orderNumber: s.orderNumber!, amountGross: c.amount!, refCode: 1, reason });
    return res.folio ? `Nota N° ${res.folio}` : `Borrador N° ${res.draftCode}`;
  }

  async function run() {
    setRunning(true);
    for (const c of ready) {
      if (results[c.sale.key]?.state === 'ok') continue;
      set(c.sale.key, { state: 'trabajando' });
      try {
        set(c.sale.key, { state: 'ok', message: await one(c) });
      } catch (err) {
        const message = (err as Error).message;
        set(c.sale.key, { state: 'error', message });
        // Problema de conexión o de claves: no tiene sentido seguir con las demás
        if (/configurad|clave|token|autentic|Conexiones → SII|Configuración → SII|no puedes/i.test(message)) break;
      }
    }
    setRunning(false);
    for (const k of ['sales', 'home', 'vat', 'credit-notes', 'credit-notes-pending', 'receivables']) qc.invalidateQueries({ queryKey: [k] });
  }

  const intro =
    kind === 'boletas'
      ? `Se emiten boletas reales en ${provider}, con la fecha de cada orden. No se pueden borrar: se anulan con nota de crédito.`
      : kind === 'facturas'
        ? sii?.can.facturasDirectas
          ? `Se emiten facturas reales en ${provider} con los datos de facturación que mandó el retailer. No se pueden borrar: se anulan con nota de crédito.`
          : 'Se crean como borrador en el Portal MIPYME del SII con los datos de facturación que mandó el retailer. Después las firmas allá.'
        : sii?.can.notasCreditoDirectas
          ? `Se emiten en ${provider} por lo que queda de cada boleta (la anulan completa).`
          : 'Se crean como borrador en el portal del SII por lo que queda de cada boleta (la anulan completa). Después las firmas allá.';

  return (
    <Modal
      wide
      title={`${title} (${ready.length})`}
      intro={intro}
      onClose={running ? () => undefined : onClose}
      footer={
        done ? (
          <Button onClick={onClose}>Listo</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={running}>
              Cancelar
            </Button>
            <Button
              onClick={run}
              loading={running || loadingReceptors}
              disabled={ready.length === 0 || incomplete.length > 0}
              title={incomplete.length ? 'Completa los datos de facturación que faltan' : undefined}
            >
              {kind === 'facturas' && sii?.can.facturasDirectas ? 'Emitir' : verb} {ready.length} {kind === 'boletas' ? 'boletas' : kind === 'facturas' ? 'facturas' : 'notas'}
            </Button>
          </>
        )
      }
    >
      {kind === 'notas' && ready.length > 0 && !done && (
        <Field label="Motivo">
          <select value={reason} onChange={(e) => setReason(e.target.value)} disabled={running} className={inputCls}>
            {REASONS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
      )}

      {kind === 'facturas' && !done && incomplete.length > 0 && !loadingReceptors && (
        <p className="rounded-xl bg-sun-50 p-3 text-sm text-sun-700">
          {incomplete.length === 1 ? 'A 1 orden le faltan' : `A ${incomplete.length} órdenes les faltan`} datos de facturación que no encontramos (ni en tus facturas
          anteriores ni en el SII). Escríbelos abajo: quedan guardados para la próxima.
        </p>
      )}
      {done && (
        <p className={cn('rounded-xl p-3 text-sm font-medium', errCount ? 'bg-sun-50 text-sun-700' : 'bg-money-50 text-money-700')}>
          {okCount} {okCount === 1 ? 'lista' : 'listas'}
          {errCount ? ` · ${errCount} con problemas (puedes reintentarlas cerrando y volviendo a elegirlas)` : ''}.
        </p>
      )}

      {ready.length > 0 && (
        <ul className={cn('divide-y divide-line overflow-y-auto rounded-xl border border-line', kind === 'facturas' ? 'max-h-[62vh]' : 'max-h-80')}>
          {ready.map((c) => {
            const r = results[c.sale.key];
            return (
              <li key={c.sale.key} className="flex items-start gap-3 px-3 py-2 text-sm">
                <span className="mt-0.5">
                  {!r || r.state === 'pendiente' ? (
                    <CircleDashed className="size-4 text-stone-300" />
                  ) : r.state === 'trabajando' ? (
                    <Loader2 className="size-4 animate-spin text-sky-700" />
                  ) : r.state === 'ok' ? (
                    <CheckCircle2 className="size-4 text-money-600" />
                  ) : (
                    <XCircle className="size-4 text-berry-700" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="font-medium">{label(c.sale)}</span>
                  <span className="text-muted"> · {c.sale.customer ?? 'Sin nombre'}</span>
                  {r?.message && <span className={cn('block text-xs', r.state === 'error' ? 'text-berry-700' : 'text-money-700')}>{r.message}</span>}
                  {kind === 'facturas' && r?.state !== 'ok' && (() => {
                    const rec = receptors[c.sale.key];
                    const inv = invoices[c.sale.key];
                    if (!rec || rec === 'error' || !inv) return <ReceptorFields value={rec} disabled={running} onChange={(f, v) => editReceptor(c.sale.key, f, v)} />;
                    return (
                      <div className="mt-2">
                        {inv.problems.length > 0 && <p className="mb-1.5 text-xs text-berry-700">{inv.problems.join(' · ')}</p>}
                        <InvoicePreview
                          receptor={rec}
                          lines={inv.lines}
                          net={inv.net}
                          vat={inv.vat}
                          total={inv.total}
                          onReceptor={(f, v) => editReceptor(c.sale.key, f, v)}
                          disabled={running}
                        />
                      </div>
                    );
                  })()}
                </div>
                {kind !== 'facturas' && <span className="num whitespace-nowrap">{clp(kind === 'notas' ? c.amount : c.sale.salePrice)}</span>}
              </li>
            );
          })}
        </ul>
      )}

      {skipped.length > 0 && (
        <details className="text-sm" open={ready.length === 0}>
          <summary className="cursor-pointer text-muted">
            {skipped.length} {skipped.length === 1 ? 'orden no aplica' : 'órdenes no aplican'}
          </summary>
          <ul className="mt-2 space-y-1">
            {skipped.map((c) => (
              <li key={c.sale.key} className="flex items-center gap-2 text-muted">
                <X className="size-3.5" /> {label(c.sale)}: {c.why}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Modal>
  );
}

/** Barra que aparece abajo al elegir ventas */
export function SelectionBar({
  selected,
  sii,
  onAction,
  onClear,
  extra,
}: {
  selected: SaleRow[];
  sii: SiiStatus | undefined;
  onAction: (k: BulkKind) => void;
  onClear: () => void;
  /** Más acciones (ej: enviar al proveedor) */
  extra?: ReactNode;
}) {
  const count = (k: BulkKind) => candidates(k, selected).filter((c) => c.ok).length;
  const can = sii?.can;
  const actions: { kind: BulkKind; label: string; allowed: boolean; why: string }[] = [
    { kind: 'boletas', label: 'Emitir boleta', allowed: Boolean(can?.boletas), why: sii?.enabled ? `${sii.providerName} no emite boletas` : 'Conecta el SII' },
    {
      kind: 'facturas',
      label: can?.facturasDirectas ? 'Emitir factura' : 'Crear factura',
      allowed: Boolean(can?.facturas),
      why: sii?.enabled ? `${sii.providerName} no emite facturas` : 'Conecta el SII',
    },
    { kind: 'notas', label: 'Nota de crédito', allowed: Boolean(can?.notasCredito), why: sii?.enabled ? `${sii.providerName} no hace notas de crédito` : 'Conecta el SII' },
  ];
  return (
    <div className="fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-ink px-4 py-3 text-sm text-white shadow-xl">
        <span className="mr-1 font-medium">
          {selected.length} {selected.length === 1 ? 'venta elegida' : 'ventas elegidas'}
        </span>
        {actions.map((a) => {
          const n = count(a.kind);
          const { icon: Icon } = TITLES[a.kind];
          return (
            <button
              key={a.kind}
              onClick={() => onAction(a.kind)}
              disabled={!a.allowed || n === 0}
              title={!a.allowed ? a.why : n === 0 ? 'Ninguna de las elegidas aplica' : undefined}
              className="inline-flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-1.5 font-medium hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon className="size-4" /> {a.label}
              {a.allowed && n > 0 && <span className="rounded-full bg-white/20 px-1.5 text-xs">{n}</span>}
            </button>
          );
        })}
        {extra}
        <button onClick={onClear} className="ml-1 rounded-xl px-2 py-1.5 text-white/70 hover:text-white" title="Quitar selección">
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}

/** "· enviada a Paris" o el error del retailer, cuando el retailer pide la boleta en su portal */
function retailNote(r: RetailSend | null | undefined) {
  if (!r) return '';
  return r.ok ? ` · ${r.message.toLowerCase()}` : ` · no se pudo enviar a ${r.retailer}: ${r.message} (reintenta desde la venta)`;
}

const RECEPTOR_LABEL: Record<keyof FacturaReceptor, string> = { rut: 'RUT', name: 'Razón social', activity: 'Giro', address: 'Dirección', commune: 'Comuna' };
const RECEPTOR_MAX: Record<keyof FacturaReceptor, number> = { rut: 12, name: 100, activity: 40, address: 70, commune: 20 };

/** Datos del receptor de una factura: muestra lo encontrado y deja escribir lo que falta */
function ReceptorFields({
  value,
  disabled,
  onChange,
}: {
  value: FacturaReceptor | 'error' | undefined;
  disabled: boolean;
  onChange: (field: keyof FacturaReceptor, value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (value === undefined)
    return (
      <span className="mt-1 flex items-center gap-1.5 text-xs text-muted">
        <Loader2 className="size-3 animate-spin" /> Buscando datos de facturación…
      </span>
    );
  if (value === 'error') return <span className="mt-1 block text-xs text-berry-700">No se pudieron leer los datos de facturación de esta orden</span>;
  const fields = (['rut', 'name', 'activity', 'address', 'commune'] as const).filter((k) => editing || !value[k]?.trim());
  return (
    <span className="mt-1 block">
      <span className="block text-xs text-muted">
        {[value.name || '—', value.rut, value.activity, [value.address, value.commune].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
        {!editing && !fields.length && !disabled && (
          <button onClick={() => setEditing(true)} className="ml-1.5 font-medium text-brand-700 hover:underline">
            Cambiar
          </button>
        )}
      </span>
      {fields.length > 0 && (
        <span className="mt-1.5 grid gap-1.5 sm:grid-cols-3">
          {fields.map((f) => (
            <input
              key={f}
              value={value[f] ?? ''}
              onChange={(e) => onChange(f, e.target.value)}
              disabled={disabled}
              maxLength={RECEPTOR_MAX[f]}
              placeholder={RECEPTOR_LABEL[f]}
              aria-label={RECEPTOR_LABEL[f]}
              className={cn(inputCls, 'h-8 px-2 py-1 text-xs', !value[f]?.trim() && 'border-sun-500')}
            />
          ))}
        </span>
      )}
    </span>
  );
}
