'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, FileText, Send } from 'lucide-react';
import { useState } from 'react';
import { api, type SaleRow } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useSession } from './session';
import { Button, clp, dmy, ErrorBox, Field, inputCls, Modal, parseAmount, Pill, typingAmount } from './ui';

/** Qué le falta a una venta, en palabras */
export function saleState(s: SaleRow): { label: string; tone: 'verde' | 'ambar' | 'rojo' | 'gris' | 'azul'; missing: string[] } {
  if (s.cancelled) {
    const nc = s.receipt && ['EMITIDA', 'REGISTRADA'].includes(s.receipt.status) && s.receipt.creditNotes < s.receipt.totalGross;
    return { label: nc ? 'Cancelada: falta anular la boleta' : 'Cancelada', tone: nc ? 'rojo' : 'gris', missing: [] };
  }
  const missing: string[] = [];
  if (!s.receipt) missing.push('boleta');
  if (s.settlementNet === null) missing.push('pago del retailer');
  if (s.supplierGross === null) missing.push('factura del proveedor');
  if (!missing.length) return { label: 'Lista', tone: 'verde', missing };
  return { label: `Falta ${missing.join(', ')}`, tone: !s.receipt ? 'rojo' : 'ambar', missing };
}

function Step({ done, title, amount, children, negative }: { done: boolean; title: string; amount?: number | null; children?: React.ReactNode; negative?: boolean }) {
  return (
    <li className="flex gap-3">
      {done ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-brand-500" /> : <Circle className="mt-0.5 size-5 shrink-0 text-stone-300" />}
      <div className="flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className={cn('font-medium', !done && 'text-muted')}>{title}</p>
          {amount !== undefined && amount !== null && <p className={cn('num font-semibold', negative && 'text-berry-700')}>{negative ? `− ${clp(Math.abs(amount))}` : clp(amount)}</p>}
        </div>
        {children && <div className="text-sm text-muted">{children}</div>}
      </div>
    </li>
  );
}

/** La venta paso a paso: lo que pagó el cliente hasta lo que ganaste */
export function SaleDetail({
  sale: s,
  siiEnabled,
  siiConnected = siiEnabled,
  siiProvider,
  onClose,
}: {
  sale: SaleRow;
  /** Se pueden emitir boletas con el proveedor del SII de la empresa */
  siiEnabled: boolean;
  siiConnected?: boolean;
  siiProvider?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { canEdit } = useSession();
  const [manual, setManual] = useState(false);
  const [number, setNumber] = useState('');
  const [total, setTotal] = useState(typingAmount(String(Math.round(s.salePrice ?? 0))));
  const refresh = () => {
    for (const k of ['sales', 'home', 'vat']) qc.invalidateQueries({ queryKey: [k] });
  };
  const emit = useMutation({ mutationFn: () => api.emitBoleta(s.retailerCode, s.orderNumber!), onSuccess: refresh });
  const save = useMutation({
    mutationFn: () => api.saveReceipt({ retailerCode: s.retailerCode, orderNumber: s.orderNumber!, receiptNumber: number.trim(), totalGross: String(parseAmount(total) ?? 0) }),
    onSuccess: () => {
      setManual(false);
      refresh();
      onClose();
    },
  });
  const customer = useQuery({ queryKey: ['customer', s.key], queryFn: () => api.customerData(s.retailerCode, s.orderNumber!), enabled: Boolean(s.orderNumber) });
  const st = saleState(s);
  const fees = (s.commission ?? 0) + (s.shippingCharges ?? 0);

  return (
    <Modal wide title={`Venta ${s.orderLabel ?? s.orderNumber ?? ''}`} intro={`${s.retailer} · ${dmy(s.orderDate)} · ${s.productName ?? ''}`} onClose={onClose}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={st.tone}>{st.label}</Pill>
        {s.status && <Pill>{s.status}</Pill>}
      </div>

      <ol className="space-y-4 rounded-2xl bg-stone-50 p-5">
        <Step done title="El cliente pagó" amount={s.salePrice}>
          {customer.data && (
            <>
              {customer.data.customer.name ?? 'Cliente'} · RUT {customer.data.customer.rut ?? 'sin RUT'}
            </>
          )}
        </Step>
        <Step done={s.settlementNet !== null} title={s.settlementNet !== null ? 'El retailer te depositó' : 'El retailer aún no te paga'} amount={s.settlementNet}>
          {s.settlementNet !== null
            ? `Ya descontó su comisión y cargos: ${clp(Math.abs(fees))}`
            : 'Aparece cuando subas la liquidación donde viene esta venta.'}
        </Step>
        <Step done={s.supplierGross !== null} title={s.supplierGross !== null ? 'Le pagaste al proveedor' : 'Falta la factura del proveedor'} amount={s.supplierGross} negative>
          {s.supplierGross === null && 'Asígnala en Compras para saber cuánto ganaste.'}
        </Step>
        <Step done={s.vat !== null} title="IVA que te toca pagar" amount={s.vat} negative>
          IVA de la venta − IVA de la compra − IVA de la comisión y envío
        </Step>
        <li className="border-t border-line pt-4">
          <div className="flex items-baseline justify-between">
            <p className="text-lg font-semibold">Ganaste</p>
            <p className={cn('num text-2xl font-semibold', (s.total ?? 0) >= 0 ? 'text-brand-700' : 'text-berry-700')}>
              {s.total !== null ? clp(s.total) : '—'}
              {s.marginPct !== null && <span className="ml-2 text-sm font-normal text-muted">{s.marginPct.toLocaleString('es-CL', { maximumFractionDigits: 1 })}%</span>}
            </p>
          </div>
          {s.total === null && <p className="text-sm text-muted">Se calcula cuando la venta tenga el pago del retailer y la factura del proveedor.</p>}
        </li>
      </ol>

      <section className="rounded-2xl border border-line p-5">
        <h3 className="font-semibold">Boleta</h3>
        {s.receipt ? (
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
            <Pill tone={s.receipt.status === 'EMITIDA' || s.receipt.status === 'REGISTRADA' ? 'verde' : 'ambar'}>
              {s.receipt.documentType === 33 ? 'Factura' : 'Boleta'} N° {s.receipt.number}
            </Pill>
            <span className="num">{clp(s.receipt.totalGross)}</span>
            {s.receipt.creditNotes > 0 && <span className="text-berry-700">Nota de crédito −{clp(s.receipt.creditNotes)}</span>}
            {s.receipt.status === 'EMITIDA' && (
              <a href={api.boletaPdfUrl(s.receipt.id, s.orderLabel)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">
                <FileText className="size-4" /> Ver PDF
              </a>
            )}
          </div>
        ) : s.cancelled ? (
          <p className="mt-1 text-sm text-muted">Venta cancelada: no necesita boleta.</p>
        ) : (
          <div className="mt-2 space-y-3">
            <p className="text-sm text-muted">Esta venta aún no tiene boleta.</p>
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                {siiEnabled ? (
                  <Button onClick={() => emit.mutate()} loading={emit.isPending}>
                    <Send className="size-4" /> Emitir boleta en el SII
                  </Button>
                ) : (
                  <p className="text-sm text-sun-700">
                    {siiConnected
                      ? `${siiProvider ?? 'Tu proveedor del SII'} no emite boletas: hazla en el SII y anota su N° aquí.`
                      : 'Conecta el SII en Configuración para emitirlas desde aquí.'}
                  </p>
                )}
                <Button variant="secondary" onClick={() => setManual(!manual)}>
                  Ya la hice fuera de Cuadra
                </Button>
              </div>
            )}
            {emit.isSuccess && <p className="text-sm text-brand-700">Boleta N° {emit.data.folio} emitida.</p>}
            {manual && (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="N° de boleta">
                  <input value={number} onChange={(e) => setNumber(e.target.value)} className={inputCls} />
                </Field>
                <Field label="Total con IVA">
                  <input value={total} onChange={(e) => setTotal(typingAmount(e.target.value))} className={cn(inputCls, 'num')} />
                </Field>
                <div className="flex items-end">
                  <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!number.trim()}>
                    Guardar
                  </Button>
                </div>
              </div>
            )}
            <ErrorBox error={emit.error ?? save.error} />
          </div>
        )}
      </section>
    </Modal>
  );
}
