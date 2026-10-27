'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Info, PackageCheck, Store } from 'lucide-react';
import { useState } from 'react';
import { api, type SaleRow } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button, Empty, ErrorBox, Loading, Modal } from './ui';

/**
 * Envía las ventas elegidas al proveedor (si tiene cuenta en Cuadra). Viajan retail, orden de
 * compra, fecha de despacho, courier, SKU, producto y cantidad; no van montos ni datos del cliente.
 */
export function SendToSupplier({ sales, onClose }: { sales: SaleRow[]; onClose: () => void }) {
  const qc = useQueryClient();
  const suppliers = useQuery({ queryKey: ['b2b-suppliers'], queryFn: api.b2bSuppliers });
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const ready = sales.filter((s) => !s.cancelled && s.orderNumber);
  const skipped = sales.length - ready.length;
  const onPlatform = (suppliers.data ?? []).filter((s) => s.onPlatform);
  const others = (suppliers.data ?? []).filter((s) => !s.onPlatform);
  const chosen = onPlatform.find((s) => s.id === supplierId) ?? (onPlatform.length === 1 ? onPlatform[0] : null);
  const already = ready.filter((s) => s.sentToSupplier).length;

  const send = useMutation({
    mutationFn: () => api.b2bSend(chosen!.id, ready.map((s) => ({ retailerCode: s.retailerCode, orderNumber: s.orderNumber! }))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales'] }),
  });

  if (send.data)
    return (
      <Modal
        title="Ventas enviadas"
        onClose={onClose}
        footer={<Button onClick={onClose}>Listo</Button>}
      >
        <div className="flex flex-col items-center py-2 text-center">
          <span className="anim-pop grid size-12 place-items-center rounded-full bg-money-50 text-money-600">
            <CheckCircle2 className="size-7" />
          </span>
          <p className="mt-3 font-medium">
            {send.data.orders} {send.data.orders === 1 ? 'venta enviada' : 'ventas enviadas'} a {send.data.supplier}
          </p>
          <p className="mt-1 text-sm text-muted">
            {send.data.lines} {send.data.lines === 1 ? 'producto' : 'productos'}
            {send.data.updatedLines > 0 && ` · ${send.data.updatedLines} ya ${send.data.updatedLines === 1 ? 'estaba enviado y se actualizó' : 'estaban enviados y se actualizaron'}`}
            . {send.data.supplier} recibió un aviso en su cuenta.
          </p>
        </div>
      </Modal>
    );

  return (
    <Modal
      title="Enviar ventas al proveedor"
      intro={`${ready.length} ${ready.length === 1 ? 'venta' : 'ventas'}${skipped ? ` · ${skipped} cancelada${skipped === 1 ? '' : 's'} no se envía${skipped === 1 ? '' : 'n'}` : ''}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => send.mutate()} loading={send.isPending} disabled={!chosen || !ready.length}>
            <PackageCheck className="size-4" /> Enviar {ready.length} {ready.length === 1 ? 'venta' : 'ventas'}
            {chosen ? ` a ${chosen.platformName}` : ''}
          </Button>
        </>
      }
    >
      {suppliers.isLoading ? (
        <Loading />
      ) : !onPlatform.length ? (
        <Empty
          icon={<Store className="size-6" />}
          title="Ninguno de tus proveedores tiene cuenta en Cuadra"
          text={
            others.length
              ? 'Solo se les puede enviar ventas a proveedores que usan Cuadra. Se reconocen por su RUT (el de sus facturas de compra).'
              : 'Tus proveedores aparecen al traer las compras del SII. Solo se les puede enviar ventas si usan Cuadra.'
          }
        />
      ) : (
        <div className="space-y-1.5" role="radiogroup" aria-label="Proveedor">
          {onPlatform.map((s) => (
            <button
              key={s.id}
              role="radio"
              aria-checked={chosen?.id === s.id}
              onClick={() => setSupplierId(s.id)}
              className={cn(
                'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm',
                chosen?.id === s.id ? 'border-brand-500 bg-brand-50/60 ring-1 ring-brand-500' : 'border-line hover:border-line-strong',
              )}
            >
              <span className={cn('grid size-4 shrink-0 place-items-center rounded-full border', chosen?.id === s.id ? 'border-brand-600' : 'border-line-strong')}>
                {chosen?.id === s.id && <span className="size-2 rounded-full bg-brand-600" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{s.platformName}</span>
                <span className="block text-xs text-muted">
                  {s.name !== s.platformName && `${s.name} · `}RUT {s.taxId}
                </span>
              </span>
            </button>
          ))}
          {others.length > 0 && (
            <p className="px-1 pt-1 text-xs text-muted">
              {others.length} {others.length === 1 ? 'proveedor no tiene' : 'proveedores no tienen'} cuenta en Cuadra ({others.slice(0, 3).map((o) => o.name).join(', ')}
              {others.length > 3 ? '…' : ''}).
            </p>
          )}
        </div>
      )}

      <div className="flex gap-2.5 rounded-xl bg-paper px-3 py-2.5 text-[0.8125rem] text-muted">
        <Info className="mt-0.5 size-4 shrink-0" />
        <p>
          Se envía por cada producto: retail, orden de compra, fecha de despacho, courier, SKU (tu SKU padre/color si lo tiene), nombre y cantidad.{' '}
          <b className="font-medium text-ink">No se envían montos ni datos de tus clientes.</b> El proveedor pone sus precios en su cuenta.
          {already > 0 && ` ${already} de estas ya se habían enviado: se actualizan, no se duplican.`}
        </p>
      </div>
      <ErrorBox error={send.error} />
    </Modal>
  );
}
