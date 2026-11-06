'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ListChecks } from 'lucide-react';
import { useState } from 'react';
import { ORDER_STATE_INFO, type OrderState } from '@cuadra/shared';
import { api, type SaleRow } from '@/lib/api';
import { Button, ErrorBox, Modal, Pill } from './ui';

/** Estados que se pueden poner a mano, en el orden en que avanza una venta */
const CHOICES: Exclude<OrderState, 'OTRO'>[] = ['PENDIENTE', 'EN_PREPARACION', 'EN_CAMINO', 'ENTREGADA', 'FALLIDA', 'DEVUELTA', 'CANCELADA'];

/** Ventas cargadas por archivo (Hites y otros sin API): su estado se lleva desde Cuadra */
export const canChangeStatus = (s: SaleRow) => s.source === 'ARCHIVO' && !!s.orderNumber;

export function ChangeStatus({ sales, onClose }: { sales: SaleRow[]; onClose: () => void }) {
  const qc = useQueryClient();
  // Una entrada por orden; fija al abrir (la tabla se actualiza al guardar)
  const [orders] = useState(() => {
    const seen = new Map<string, SaleRow>();
    for (const s of sales) if (!seen.has(`${s.retailerCode}|${s.orderNumber}`)) seen.set(`${s.retailerCode}|${s.orderNumber}`, s);
    return [...seen.values()];
  });
  const [state, setState] = useState<Exclude<OrderState, 'OTRO'> | null>(null);
  const withReceipt = orders.filter((s) => s.receipt?.status === 'EMITIDA');

  const run = useMutation({
    mutationFn: () =>
      api.setSalesStatus(
        orders.map((s) => ({ retailerCode: s.retailerCode, orderNumber: s.orderNumber! })),
        state!,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales'] }),
  });

  return (
    <Modal
      title={`Cambiar estado de ${orders.length} ${orders.length === 1 ? 'venta' : 'ventas'}`}
      intro="Para ventas que se cargan por archivo, como Hites: el archivo no actualiza las órdenes ya cargadas."
      onClose={onClose}
      footer={
        run.data ? (
          <Button onClick={onClose}>Listo</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button onClick={() => run.mutate()} loading={run.isPending} disabled={!state}>
              <ListChecks className="size-4" /> {state ? `Dejar en ${ORDER_STATE_INFO[state].label}` : 'Elige un estado'}
            </Button>
          </>
        )
      }
    >
      {run.data ? (
        <div className="space-y-3 text-sm">
          {run.data.updated > 0 && (
            <p className="anim-rise flex items-center gap-2 rounded-xl bg-money-50 px-3 py-2.5 text-money-700">
              <CheckCircle2 className="size-4 shrink-0" /> {run.data.updated} {run.data.updated === 1 ? 'venta quedó' : 'ventas quedaron'} en {run.data.label}.
            </p>
          )}
          {run.data.skipped.length > 0 && (
            <div className="rounded-xl border border-sun-100 bg-sun-50 px-3 py-2.5 text-sun-700">
              <p className="mb-1 flex items-center gap-1.5 font-medium">
                <AlertTriangle className="size-4" /> No se cambiaron ({run.data.skipped.length})
              </p>
              <ul className="space-y-0.5 text-xs">
                {run.data.skipped.map((s) => (
                  <li key={s.order}>
                    <b>{s.order}</b>: {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <ul className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-line bg-[#fafbfc] px-3 py-2 text-xs">
            {orders.map((s) => (
              <li key={s.key} className="flex items-center justify-between gap-3">
                <span>
                  <b>{s.retailer.split(' · ')[0]}</b> {s.orderLabel ?? s.orderNumber}
                  {s.customer ? <span className="text-muted"> · {s.customer}</span> : null}
                </span>
                <Pill tone={ORDER_STATE_INFO[s.state].tone}>{ORDER_STATE_INFO[s.state].label}</Pill>
              </li>
            ))}
          </ul>
          <fieldset>
            <legend className="mb-2 text-xs text-muted">Nuevo estado</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {CHOICES.map((c) => (
                <label
                  key={c}
                  className={`flex cursor-pointer flex-col gap-0.5 rounded-xl border px-3 py-2 transition-colors ${state === c ? 'border-brand-500 bg-brand-50' : 'border-line hover:border-ink/30'}`}
                >
                  <span className="flex items-center gap-2">
                    <input type="radio" name="estado" value={c} checked={state === c} onChange={() => setState(c)} className="accent-brand-600" />
                    <span className="font-medium">{ORDER_STATE_INFO[c].label}</span>
                  </span>
                  <span className="pl-5 text-xs text-muted">{ORDER_STATE_INFO[c].help}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {state === 'CANCELADA' && withReceipt.length > 0 && (
            <p className="flex gap-2 rounded-xl border border-sun-100 bg-sun-50 px-3 py-2 text-xs text-sun-700">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              {withReceipt.length === 1 ? 'Una tiene' : `${withReceipt.length} tienen`} boleta emitida: al cancelarla, recuerda anularla con una nota de
              crédito.
            </p>
          )}
          <ErrorBox error={run.error} />
        </div>
      )}
    </Modal>
  );
}
