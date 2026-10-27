'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileText, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type FacturaReceptor, type SaleRow } from '@/lib/api';
import { cn } from '@/lib/cn';
import { InvoicePreview } from './invoice-preview';
import { Button, clp, ErrorBox, Loading, Modal } from './ui';

/**
 * Una factura para varias ventas del mismo cliente (ej. las que envió Jamaroff): una línea por
 * producto con su nombre y OC, cantidad y precio neto; la factura suma el IVA.
 */
export function FacturaLote({ sales, onClose }: { sales: SaleRow[]; onClose: () => void }) {
  const qc = useQueryClient();
  const retailerCode = sales[0]?.retailerCode;
  const orderNumbers = [...new Set(sales.filter((s) => !s.cancelled && s.orderNumber).map((s) => s.orderNumber!))];
  const preview = useQuery({
    queryKey: ['factura-lote', retailerCode, orderNumbers.join('|')],
    queryFn: () => api.facturaLotePreview(retailerCode, orderNumbers),
    enabled: Boolean(retailerCode && orderNumbers.length),
  });
  const [receptor, setReceptor] = useState<FacturaReceptor | null>(null);
  useEffect(() => {
    if (preview.data && !receptor) setReceptor(preview.data.receptor);
  }, [preview.data, receptor]);

  // Datos del receptor según el SII (razón social, giro, dirección)
  const lookup = useMutation({
    mutationFn: () => api.contribuyente(receptor!.rut),
    onSuccess: (c) =>
      setReceptor((r) => ({
        ...r!,
        name: c.razonSocial ?? r!.name,
        activity: r!.activity || (c.actividades[0]?.glosa ?? ''),
        address: r!.address || (c.direcciones[0]?.direccion ?? ''),
        commune: r!.commune || (c.direcciones[0]?.comuna ?? ''),
      })),
  });

  const create = useMutation({
    mutationFn: () => api.createFacturaLote(retailerCode, orderNumbers, receptor!),
    onSuccess: () => {
      for (const k of ['sales', 'home', 'vat', 'receivables']) qc.invalidateQueries({ queryKey: [k] });
    },
  });

  const p = preview.data;
  const missing = receptor ? (['rut', 'name', 'activity', 'address', 'commune'] as const).filter((k) => !receptor[k]?.trim()) : [];
  const set = (k: keyof FacturaReceptor, v: string) => setReceptor((r) => ({ ...r!, [k]: v }));

  if (create.data)
    return (
      <Modal title="Factura lista" onClose={onClose} footer={<Button onClick={onClose}>Listo</Button>}>
        <div className="flex flex-col items-center py-2 text-center">
          <span className="anim-pop grid size-12 place-items-center rounded-full bg-money-50 text-money-600">
            <CheckCircle2 className="size-7" />
          </span>
          <p className="mt-3 font-medium">
            {create.data.folio ? `Factura N° ${create.data.folio} emitida` : `Factura en borrador N° ${create.data.draftCode}`} por {clp(create.data.total)}
          </p>
          <p className="mt-1 text-sm text-muted">
            Cubre {create.data.orders} {create.data.orders === 1 ? 'venta' : 'ventas'}.
            {!create.data.folio && ' Fírmala en el Portal MIPYME del SII para que quede emitida.'}
          </p>
        </div>
      </Modal>
    );

  return (
    <Modal
      wide
      title={p ? `Factura a ${p.client}` : 'Factura'}
      intro={`${orderNumbers.length} ${orderNumbers.length === 1 ? 'venta' : 'ventas'} en una sola factura`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!p || p.problems.length > 0 || missing.length > 0}>
            <FileText className="size-4" /> {p?.direct ? `Emitir factura en ${p.providerName}` : 'Crear borrador en el Portal MIPYME'}
          </Button>
        </>
      }
    >
      {preview.isLoading || !receptor ? (
        <Loading />
      ) : p ? (
        <>
          {p.problems.length > 0 && (
            <div className="flex gap-2 rounded-xl border border-berry-100 bg-berry-50 px-3 py-2.5 text-sm text-berry-700">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <ul className="space-y-0.5">
                {p.problems.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          )}

          <InvoicePreview receptor={receptor} lines={p.lines} net={p.net} vat={p.vat} total={p.total} onReceptor={set} disabled={create.isPending} />
          {receptor.rut && (!receptor.name || !receptor.activity) && (
            <Button variant="secondary" size="sm" onClick={() => lookup.mutate()} loading={lookup.isPending}>
              <Search className="size-4" /> Traer razón social y giro del SII
            </Button>
          )}
          {missing.length > 0 && <p className="text-xs text-sun-700">Completa los datos del cliente para emitir.</p>}
          <ErrorBox error={lookup.error} />
          <ErrorBox error={create.error} />
        </>
      ) : (
        <ErrorBox error={preview.error} />
      )}
    </Modal>
  );
}
