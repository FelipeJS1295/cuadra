'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, RotateCcw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, type SaleRow } from '@/lib/api';
import { Button, Empty, ErrorBox, Loading, Modal } from './ui';

const WORD = 'ELIMINAR';

/**
 * Eliminar ventas (solo el dueño): borra la orden, su liquidación y su boleta sin emitir.
 * Cuadra la recuerda para no volver a traerla al actualizar ventas o subir archivos.
 */
export function DeleteSales({ sales, onClose }: { sales: SaleRow[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [word, setWord] = useState('');
  // Una entrada por orden (una orden con varios productos es una sola venta)
  const orders = useMemo(() => {
    const seen = new Map<string, SaleRow>();
    for (const s of sales) if (s.orderNumber && !seen.has(`${s.retailerCode}|${s.orderNumber}`)) seen.set(`${s.retailerCode}|${s.orderNumber}`, s);
    return [...seen.values()];
  }, [sales]);
  const withReceipt = orders.filter((s) => s.receipt?.status === 'EMITIDA' || s.receipt?.status === 'EMITIENDO');

  const run = useMutation({
    mutationFn: () => api.deleteSales(orders.map((s) => ({ retailerCode: s.retailerCode, orderNumber: s.orderNumber! }))),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales'] });
      qc.invalidateQueries({ queryKey: ['deleted-sales'] });
    },
  });
  const ready = word.trim().toUpperCase() === WORD;

  return (
    <Modal
      title={`Eliminar ${orders.length} ${orders.length === 1 ? 'venta' : 'ventas'}`}
      intro="Solo el dueño de la empresa puede hacerlo."
      onClose={onClose}
      footer={
        run.data ? (
          <Button onClick={onClose}>Listo</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={() => run.mutate()} loading={run.isPending} disabled={!ready || !orders.length}>
              <Trash2 className="size-4" /> Eliminar {orders.length === 1 ? 'venta' : `${orders.length} ventas`}
            </Button>
          </>
        )
      }
    >
      {run.data ? (
        <div className="space-y-3 text-sm">
          {run.data.deleted > 0 && (
            <div className="anim-rise flex items-center gap-2 rounded-xl bg-money-50 px-3 py-2.5 text-money-700">
              <CheckCircle2 className="size-4 shrink-0" /> {run.data.deleted} {run.data.deleted === 1 ? 'venta eliminada' : 'ventas eliminadas'}. No volverán a
              aparecer al actualizar ventas ni al subir archivos.
            </div>
          )}
          {run.data.skipped.length > 0 && (
            <div className="rounded-xl border border-sun-100 bg-sun-50 px-3 py-2.5 text-sun-700">
              <p className="mb-1 flex items-center gap-1.5 font-medium">
                <AlertTriangle className="size-4" /> No se eliminaron ({run.data.skipped.length})
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
        <div className="space-y-3 text-sm">
          <ul className="max-h-48 space-y-1 overflow-y-auto rounded-xl border border-line bg-[#fafbfc] px-3 py-2 text-xs">
            {orders.map((s) => (
              <li key={s.key} className="flex justify-between gap-3">
                <span>
                  <b>{s.retailer.split(' · ')[0]}</b> {s.orderLabel ?? s.orderNumber}
                  {s.customer ? <span className="text-muted"> · {s.customer}</span> : null}
                </span>
                <span className="shrink-0 text-muted">{s.orderDate ? s.orderDate.split('-').reverse().join('/') : ''}</span>
              </li>
            ))}
          </ul>
          <div className="flex gap-2 rounded-xl border border-berry-100 bg-berry-50 px-3 py-2.5 text-berry-700">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="space-y-1">
              <p>
                Se borran de Ventas junto con su <b>liquidación</b> y la boleta <b>sin emitir</b>. Cuadra las recordará para <b>no volver a traerlas</b> al
                actualizar ventas, subir archivos o recibirlas de un cliente.
              </p>
              <p className="text-xs">Si te equivocas, en &quot;Ventas eliminadas&quot; puedes permitir que vuelvan con la próxima actualización.</p>
            </div>
          </div>
          {withReceipt.length > 0 && (
            <p className="text-xs text-sun-700">
              {withReceipt.length === 1 ? 'Una de ellas tiene' : `${withReceipt.length} tienen`} boleta emitida en el SII: esas no se eliminarán (primero hay
              que anular la boleta con una nota de crédito).
            </p>
          )}
          <label className="block">
            <span className="text-xs text-muted">
              Para confirmar, escribe <b className="text-ink">{WORD}</b>
            </span>
            <input
              value={word}
              onChange={(e) => setWord(e.target.value)}
              autoFocus
              autoComplete="off"
              className="mt-1 h-10 w-full rounded-lg border border-line px-3 text-sm outline-none focus:border-berry-500"
              placeholder={WORD}
            />
          </label>
          <ErrorBox error={run.error} />
        </div>
      )}
    </Modal>
  );
}

/** Ventas eliminadas: quién y cuándo, y la opción de permitir que vuelvan */
export function DeletedSales({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['deleted-sales'], queryFn: api.deletedSales });
  const allow = useMutation({
    mutationFn: (id: string) => api.allowDeletedSale(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deleted-sales'] }),
  });
  const fmt = (iso: string) => new Date(iso).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' });

  return (
    <Modal
      title="Ventas eliminadas"
      intro="Cuadra no las vuelve a traer al actualizar ventas ni al subir archivos."
      onClose={onClose}
      wide
      footer={<Button onClick={onClose}>Cerrar</Button>}
    >
      {list.isLoading ? (
        <Loading />
      ) : !list.data?.length ? (
        <Empty title="No hay ventas eliminadas" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-2 pr-3 font-medium">Venta</th>
                <th className="py-2 pr-3 font-medium">Cliente</th>
                <th className="py-2 pr-3 font-medium">Eliminada</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {list.data.map((d) => {
                const s = (d.summary ?? {}) as { cliente?: string; fecha?: string; productos?: { nombre?: string }[] };
                return (
                  <tr key={d.id} className="border-t border-line align-top">
                    <td className="py-2 pr-3">
                      <b>{d.retailer}</b> {d.orderNumber}
                      <span className="block text-xs text-muted">
                        {s.fecha ? s.fecha.split('-').reverse().join('/') : ''}
                        {s.productos?.length
                          ? ` · ${s.productos
                              .map((p) => p.nombre)
                              .filter(Boolean)
                              .join(', ')}`
                          : ''}
                      </span>
                    </td>
                    <td className="py-2 pr-3">{s.cliente ?? '—'}</td>
                    <td className="py-2 pr-3 text-xs">
                      {fmt(d.deletedAt)}
                      <span className="block text-muted">{d.deletedByName ?? ''}</span>
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={allow.isPending && allow.variables === d.id}
                        onClick={() => allow.mutate(d.id)}
                        title="La próxima vez que actualices ventas o subas el archivo, esta venta vuelve a Cuadra"
                      >
                        <RotateCcw className="size-3.5" /> Permitir que vuelva
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <ErrorBox error={allow.error} />
        </div>
      )}
    </Modal>
  );
}
