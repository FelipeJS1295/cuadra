'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileText, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, type PurchaseInvoice } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useSession } from './session';
import { Button, clp, dmy, ErrorBox, Field, inputCls, Loading, Modal, parseAmount, Pill, shortDate, todayCL, typingAmount } from './ui';

const refreshKeys = ['invoices', 'invoice', 'sales', 'home', 'reconciliation', 'vat'];

/** Detalle de una factura del proveedor: a qué ventas corresponde y sus pagos */
export function InvoiceDetail({ invoice, onClose, onAssign }: { invoice: PurchaseInvoice; onClose: () => void; onAssign: () => void }) {
  const qc = useQueryClient();
  const { canEdit } = useSession();
  const d = useQuery({ queryKey: ['invoice', invoice.id], queryFn: () => api.getInvoice(invoice.id) });
  const sii = useQuery({ queryKey: ['sii-status'], queryFn: api.siiStatus, staleTime: 300_000 });
  const [amount, setAmount] = useState('');
  const [paidAt, setPaidAt] = useState(todayCL());
  const pay = useMutation({
    mutationFn: () => api.addInvoicePayment(invoice.id, { amount: String(parseAmount(amount) ?? 0), paidAt, method: 'Transferencia', note: null }),
    onSuccess: () => {
      setAmount('');
      for (const k of refreshKeys) qc.invalidateQueries({ queryKey: [k] });
    },
  });
  const delPay = useMutation({
    mutationFn: api.deleteInvoicePayment,
    onSuccess: () => {
      for (const k of refreshKeys) qc.invalidateQueries({ queryKey: [k] });
    },
  });
  const x = d.data;
  return (
    <Modal wide title={`Factura N° ${invoice.documentNumber}`} intro={`${invoice.supplier} · ${dmy(invoice.issueDate)}`} onClose={onClose}>
      {!x ? (
        <Loading />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-xl bg-stone-50 p-3">
              <p className="text-xs text-muted">Total</p>
              <p className="num text-lg font-semibold">{clp(x.total)}</p>
            </div>
            <div className="rounded-xl bg-stone-50 p-3">
              <p className="text-xs text-muted">Pagado</p>
              <p className="num text-lg font-semibold">{clp(x.paid)}</p>
            </div>
            <div className={cn('rounded-xl p-3', x.balance > 0 ? 'bg-sun-50' : 'bg-brand-50')}>
              <p className="text-xs text-muted">Falta pagar</p>
              <p className="num text-lg font-semibold">{clp(x.balance)}</p>
            </div>
          </div>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-semibold">Ventas que cubre ({x.lines.length})</h3>
              {canEdit && (
                <Button size="sm" variant="ghost" onClick={onAssign}>
                  + Asignar ventas
                </Button>
              )}
            </div>
            {x.fromSii && x.assignedNet < x.net && (
              <p className="mb-2 rounded-xl bg-sun-50 px-3 py-2 text-sm text-sun-700">Faltan {clp(x.net - x.assignedNet)} netos por asignar a ventas.</p>
            )}
            <ul className="divide-y divide-line rounded-xl border border-line text-sm">
              {x.lines.length === 0 && <li className="px-3 py-3 text-muted">Aún no se asigna a ninguna venta.</li>}
              {x.lines.map((l) => (
                <li key={l.id} className="flex justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 truncate">
                    {l.productName} <span className="text-muted">· {l.retailer} · {l.orderNumber}</span>
                  </span>
                  <span className="num shrink-0">{clp(l.total)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-2 font-semibold">Pagos</h3>
            <ul className="divide-y divide-line rounded-xl border border-line text-sm">
              {x.payments.length === 0 && <li className="px-3 py-3 text-muted">Aún no le pagas.</li>}
              {x.payments.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span>
                    {dmy(p.paidAt)} · {p.method}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="num">{clp(p.amount)}</span>
                    {canEdit && (
                      <button onClick={() => delPay.mutate(p.id)} className="text-muted hover:text-berry-700" aria-label="Quitar pago">
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {canEdit && x.balance > 0 && (
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <Field label="Monto pagado">
                  <input value={amount} onChange={(e) => setAmount(typingAmount(e.target.value))} placeholder={clp(x.balance)} className={cn(inputCls, 'num w-40')} />
                </Field>
                <Field label="Fecha">
                  <input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} className={cn(inputCls, 'w-44')} />
                </Field>
                <Button onClick={() => pay.mutate()} loading={pay.isPending} disabled={!parseAmount(amount)}>
                  Registrar pago
                </Button>
                <Button variant="ghost" onClick={() => setAmount(typingAmount(String(x.balance)))}>
                  Pagar todo
                </Button>
              </div>
            )}
            <ErrorBox error={pay.error ?? delPay.error} />
          </section>
          {x.fromSii && sii.data?.can.comprasDetalle && (
            <a href={api.purchasePdfUrl(x.id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
              <FileText className="size-4" /> Ver PDF en el SII
            </a>
          )}
        </>
      )}
    </Modal>
  );
}

/**
 * Asignar una factura del proveedor a ventas: se elige el retailer y se marcan las ventas
 * que cubre (con su monto neto). Si la factura no existe, se crea.
 */
export function AssignDialog({ invoice, onClose }: { invoice?: PurchaseInvoice | null; onClose: () => void }) {
  const qc = useQueryClient();
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: api.suppliers });
  const retailers = useQuery({ queryKey: ['import-retailers', 'liquidacion'], queryFn: api.settlementRetailers });
  const [supplier, setSupplier] = useState(invoice?.supplier ?? '');
  const [number, setNumber] = useState(invoice?.documentNumber ?? '');
  const [issueDate, setIssueDate] = useState(invoice?.issueDate ?? todayCL());
  const [retailer, setRetailer] = useState('');
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const rec = useQuery({ queryKey: ['reconciliation', retailer], queryFn: () => api.reconcile(retailer), enabled: Boolean(retailer) });
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rec.data?.rows ?? []).filter(
      (r) => r.itemId && r.orderNumber && r.documents.length === 0 && r.status !== 'CANCELADA' && r.status !== 'SIN_VENTA' && r.status !== 'MULTA' && (!q || `${r.productName} ${r.orderLabel} ${r.orderNumber}`.toLowerCase().includes(q)),
    );
  }, [rec.data, search]);
  const total = Object.values(picked).reduce((n, v) => n + (parseAmount(v) ?? 0), 0);

  const save = useMutation({
    mutationFn: () =>
      api.createPurchaseDocument({
        supplier: supplier.trim(),
        documentNumber: number.trim(),
        issueDate,
        retailerCode: retailer,
        lines: candidates
          .filter((r) => picked[r.itemId!] !== undefined)
          .map((r) => ({ itemKey: r.itemId!, orderNumber: r.orderNumber, productName: r.productName, amountNet: String(parseAmount(picked[r.itemId!]) ?? 0) })),
      }),
    onSuccess: () => {
      for (const k of refreshKeys) qc.invalidateQueries({ queryKey: [k] });
    },
  });

  if (save.isSuccess) {
    return (
      <Modal title="Factura asignada" onClose={onClose} footer={<Button onClick={onClose}>Listo</Button>}>
        <p className="flex items-center gap-2 rounded-xl bg-brand-50 p-4 text-brand-700">
          <CheckCircle2 className="size-5" /> La factura N° {save.data.documentNumber} quedó asignada a {save.data.lines} ventas.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      wide
      title={invoice ? `Asignar ventas a la factura N° ${invoice.documentNumber}` : 'Agregar factura de proveedor'}
      intro="Marca las ventas que cubre esta factura y escribe el monto neto (sin IVA) de cada una. Así sabremos cuánto ganaste en cada venta."
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto self-center text-sm text-muted">
            {Object.keys(picked).length} ventas · neto {clp(total)} · con IVA {clp(total * 1.19)}
          </span>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!supplier.trim() || !number.trim() || !retailer || !Object.keys(picked).length}>
            Guardar
          </Button>
        </>
      }
    >
      {!invoice && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Proveedor">
            <input list="suppliers" value={supplier} onChange={(e) => setSupplier(e.target.value)} className={inputCls} />
            <datalist id="suppliers">
              {suppliers.data?.map((s) => (
                <option key={s.id} value={s.name} />
              ))}
            </datalist>
          </Field>
          <Field label="N° de factura">
            <input value={number} onChange={(e) => setNumber(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Fecha de la factura">
            <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} className={inputCls} />
          </Field>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Ventas de qué retailer">
          <select
            value={retailer}
            onChange={(e) => {
              setRetailer(e.target.value);
              setPicked({});
            }}
            className={inputCls}
          >
            <option value="">Elige uno…</option>
            {retailers.data?.map((r) => (
              <option key={r.code} value={r.code}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Buscar">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Producto u orden" className={inputCls} />
        </Field>
      </div>
      {rec.isLoading && <Loading />}
      {retailer && rec.data && (
        <div className="max-h-[45vh] overflow-auto rounded-xl border border-line">
          {candidates.length === 0 ? (
            <p className="p-4 text-sm text-muted">No hay ventas sin factura de proveedor en este retailer.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {candidates.map((r) => {
                const on = picked[r.itemId!] !== undefined;
                return (
                  <li key={r.itemId} className={cn('flex items-center gap-3 px-3 py-2', on && 'bg-brand-50')}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setPicked((p) => {
                          const n = { ...p };
                          if (on) delete n[r.itemId!];
                          else n[r.itemId!] = '';
                          return n;
                        })
                      }
                      className="size-4 accent-brand-600"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{r.productName}</p>
                      <p className="text-xs text-muted">
                        {r.orderLabel ?? r.orderNumber} · {shortDate(r.orderDate)} · vendida en {clp(r.salePrice)}
                      </p>
                    </div>
                    {on && (
                      <input
                        value={picked[r.itemId!]}
                        onChange={(e) => setPicked((p) => ({ ...p, [r.itemId!]: typingAmount(e.target.value) }))}
                        placeholder="Neto $"
                        className={cn(inputCls, 'num w-32')}
                        autoFocus
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      <ErrorBox error={save.error ?? rec.error} />
    </Modal>
  );
}

/** Traer las facturas de compra del Registro de Compras del SII */
export function SiiImportDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [month, setMonth] = useState(todayCL().slice(0, 7));
  const preview = useQuery({ queryKey: ['sii-purchases', month], queryFn: () => api.siiPurchases(month), retry: false });
  const docs = preview.data?.documents ?? [];
  const fresh = docs.filter((d) => d.erpStatus !== 'IMPORTADA');
  const save = useMutation({
    mutationFn: () => api.importSiiPurchases(month, fresh.map((d) => d.key)),
    onSuccess: () => {
      for (const k of refreshKeys) qc.invalidateQueries({ queryKey: [k] });
    },
  });
  return (
    <Modal
      wide
      title="Traer facturas del SII"
      intro="Leemos el Registro de Compras del SII y traemos las facturas de tus proveedores. Las que ya tenías no se duplican."
      onClose={onClose}
      footer={
        save.isSuccess ? (
          <Button onClick={onClose}>Listo</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!fresh.length}>
              Traer {fresh.length} facturas
            </Button>
          </>
        )
      }
    >
      <Field label="Mes">
        <input type="month" value={month} max={todayCL().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} className={cn(inputCls, 'w-48')} />
      </Field>
      {preview.isLoading && <Loading label="Consultando el SII…" />}
      <ErrorBox error={preview.error ?? save.error} />
      {save.isSuccess && (
        <p className="rounded-xl bg-brand-50 p-3 text-brand-700">
          {save.data.created} facturas nuevas · {save.data.linked} que ya tenías quedaron con los datos del SII.
        </p>
      )}
      {preview.data && !save.isSuccess && (
        <ul className="max-h-[45vh] divide-y divide-line overflow-auto rounded-xl border border-line text-sm">
          {docs.length === 0 && <li className="p-4 text-muted">El SII no tiene compras en este mes.</li>}
          {docs.map((d) => (
            <li key={d.key} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{d.supplierName}</p>
                <p className="text-xs text-muted">
                  {d.typeLabel} N° {d.folio} · {dmy(d.issueDate)}
                  {d.retailer && ` · factura de ${d.retailer.name} (comisiones)`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="num">{clp(d.total)}</span>
                <Pill tone={d.erpStatus === 'IMPORTADA' ? 'gris' : 'verde'}>{d.erpStatus === 'IMPORTADA' ? 'Ya está' : 'Nueva'}</Pill>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
