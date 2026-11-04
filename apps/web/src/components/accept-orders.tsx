'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CircleCheckBig } from 'lucide-react';
import { useState } from 'react';
import { api, type SaleRow } from '@/lib/api';
import { Button, ErrorBox, Modal } from './ui';

/** Órdenes que aún se pueden aceptar en el retailer: nuevas, sin despachar ni cancelar */
export const canAccept = (s: SaleRow, providers: string[]) => providers.includes(s.retailerCode) && !s.cancelled && s.state === 'PENDIENTE' && !!s.orderNumber;

/**
 * Aceptar órdenes en el retailer (Walmart: "Created" -> "Acknowledged").
 * El retailer cambia el estado y Cuadra lo actualiza en Ventas.
 */
export function AcceptOrders({ sales, onClose }: { sales: SaleRow[]; onClose: () => void }) {
  const qc = useQueryClient();
  // Fija al abrir: al aceptar, la tabla se actualiza y estas ventas dejan de estar pendientes
  const [orders] = useState(() => {
    const seen = new Map<string, SaleRow>();
    for (const s of sales) if (!seen.has(`${s.retailerCode}|${s.orderNumber}`)) seen.set(`${s.retailerCode}|${s.orderNumber}`, s);
    return [...seen.values()];
  });
  const label = (n: string) => orders.find((s) => s.orderNumber === n)?.orderLabel ?? n;
  const retailers = [...new Set(orders.map((s) => s.retailer.split(' · ')[0]))].join(' y ');

  const run = useMutation({
    mutationFn: () => api.acceptOrders(orders.map((s) => ({ retailerCode: s.retailerCode, orderNumber: s.orderNumber! }))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales'] }),
  });

  return (
    <Modal
      title={`Aceptar ${orders.length} ${orders.length === 1 ? 'orden' : 'órdenes'} en ${retailers}`}
      intro="Le confirmas al retailer que vas a preparar y despachar estas órdenes."
      onClose={onClose}
      footer={
        run.data ? (
          <Button onClick={onClose}>Listo</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button onClick={() => run.mutate()} loading={run.isPending} disabled={!orders.length}>
              <CircleCheckBig className="size-4" /> Aceptar {orders.length === 1 ? 'orden' : `${orders.length} órdenes`}
            </Button>
          </>
        )
      }
    >
      {run.data ? (
        <div className="space-y-3 text-sm">
          {run.data.accepted > 0 && (
            <div className="anim-rise rounded-xl bg-money-50 px-3 py-2.5 text-money-700">
              <p className="flex items-center gap-2 font-medium">
                <CheckCircle2 className="size-4 shrink-0" /> {run.data.accepted} {run.data.accepted === 1 ? 'orden aceptada' : 'órdenes aceptadas'}
              </p>
              <ul className="mt-1 space-y-0.5 pl-6 text-xs">
                {run.data.orders.map((o) => (
                  <li key={o.orderNumber}>
                    <b>{label(o.orderNumber)}</b>: ahora está {o.status === 'Acknowledged' ? 'aceptada (en preparación)' : o.status}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {run.data.problems.length > 0 && (
            <div className="rounded-xl border border-sun-100 bg-sun-50 px-3 py-2.5 text-sun-700">
              <p className="mb-1 flex items-center gap-1.5 font-medium">
                <AlertTriangle className="size-4" /> No se aceptaron ({run.data.problems.length})
              </p>
              <ul className="space-y-0.5 text-xs">
                {run.data.problems.map((p) => (
                  <li key={p.orderNumber}>
                    <b>{label(p.orderNumber)}</b>: {p.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <ul className="max-h-48 space-y-1 overflow-y-auto rounded-xl border border-line bg-[#fafbfc] px-3 py-2 text-xs">
            {orders.map((s) => (
              <li key={s.key} className="flex justify-between gap-3">
                <span>
                  <b>{s.retailer.split(' · ')[0]}</b> {s.orderLabel ?? s.orderNumber}
                  {s.customer ? <span className="text-muted"> · {s.customer}</span> : null}
                </span>
                <span className="shrink-0 text-muted">
                  {s.dispatchDeadline ? `despachar antes del ${s.dispatchDeadline.split('-').reverse().join('/')}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">
            Una vez aceptada, el plazo de despacho corre en el retailer. Las órdenes ya aceptadas, despachadas o canceladas no se tocan.
          </p>
          <ErrorBox error={run.error} />
        </div>
      )}
    </Modal>
  );
}
