'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Download } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, type FacturaReceptor, type InvoiceLine, type SaleRow } from '@/lib/api';
import { InvoicePreview } from './invoice-preview';
import { Button, clp, ErrorBox, Loading, Modal } from './ui';

const FOLIO_KEY = 'cuadra:nubox-folio';
/** Datos del cliente escritos a mano, por cliente (no se consultan al SII) */
const receptorKey = (code: string) => `cuadra:nubox-receptor:${code}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
const dmy = (iso: string) => iso.split('-').reverse().join('/');

/** Igual que el archivo: una factura por día de venta y retail, en orden */
function groupsOf(lines: InvoiceLine[]) {
  const map = new Map<string, { date: string; origin: string; lines: InvoiceLine[] }>();
  for (const l of lines) {
    const date = l.date || today();
    const origin = l.origin || 'Sin retail';
    const k = `${date}|${origin}`;
    if (!map.has(k)) map.set(k, { date, origin, lines: [] });
    map.get(k)!.lines.push(l);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date) || a.origin.localeCompare(b.origin, 'es'));
}

const inputCls = 'h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none focus:border-brand-500';

/**
 * Ventas de un cliente de Cuadra (ej. Jamaroff) en el archivo de "Importar ventas electrónicas" de
 * Nubox: cada línea lleva el producto, su OC, el retail donde se vendió y el cliente. No emite nada:
 * la factura se crea al subir el archivo en Nubox.
 */
export function NuboxFile({ sales, onClose }: { sales: SaleRow[]; onClose: () => void }) {
  const retailerCode = sales[0]?.retailerCode;
  const [orderNumbers] = useState(() => [...new Set(sales.filter((s) => !s.cancelled && s.orderNumber).map((s) => s.orderNumber!))]);
  const preview = useQuery({
    queryKey: ['nubox-file', retailerCode, orderNumbers.join('|')],
    queryFn: () => api.facturaLoteNuboxPreview(retailerCode, orderNumbers),
    enabled: Boolean(retailerCode && orderNumbers.length),
  });
  const [receptor, setReceptor] = useState<FacturaReceptor | null>(null);
  useEffect(() => {
    if (!preview.data || receptor) return;
    // Lo último que escribiste para este cliente; lo que falte, de la venta
    let saved: Partial<FacturaReceptor> = {};
    try {
      saved = JSON.parse(localStorage.getItem(receptorKey(retailerCode)) ?? '{}') ?? {};
    } catch {
      /* sin datos guardados */
    }
    const base = preview.data.receptor;
    const pick = (k: keyof FacturaReceptor) => (typeof saved[k] === 'string' && saved[k]!.trim() ? saved[k]! : base[k]);
    setReceptor({ rut: pick('rut'), name: pick('name'), activity: pick('activity'), address: pick('address'), commune: pick('commune') });
  }, [preview.data, receptor, retailerCode]);
  // Por defecto cada factura lleva la fecha de sus ventas; se puede poner una sola fecha para todas
  const [sameDate, setSameDate] = useState(false);
  const [fecha, setFecha] = useState(today);
  // El folio siguiente al último archivo (solo una ayuda: revisa el que corresponde en Nubox)
  const [folio, setFolio] = useState(() => {
    try {
      return localStorage.getItem(FOLIO_KEY) ?? '';
    } catch {
      return '';
    }
  });


  const p = preview.data;
  const groups = useMemo(() => groupsOf(p?.lines ?? []), [p]);
  const invoices = groups.length;
  const download = useMutation({
    mutationFn: async () => {
      const file = await api.facturaLoteNubox({ retailerCode, orderNumbers, receptor: receptor!, folio: Number(folio), fecha: sameDate ? fecha : null });
      const slug = (p?.client ?? 'cliente')
        .normalize('NFD')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();
      const name = file.name ?? `nubox-facturas-${slug}-${sameDate ? fecha : today()}.csv`;
      const url = URL.createObjectURL(file.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      try {
        localStorage.setItem(FOLIO_KEY, String(Number(folio) + invoices));
        localStorage.setItem(receptorKey(retailerCode), JSON.stringify(receptor));
      } catch {
        /* sin recordar el folio */
      }
      return name;
    },
  });

  const missing = receptor ? (['rut', 'name', 'activity', 'address', 'commune'] as const).filter((k) => !receptor[k]?.trim()) : [];
  const set = (k: keyof FacturaReceptor, v: string) => setReceptor((r) => ({ ...r!, [k]: v }));
  // Lo que impide armar el archivo: productos sin precio. Lo demás (ya facturada…) es aviso.
  const blocking = p?.problems.filter((x) => x.startsWith('Sin precio')) ?? [];
  const warnings = p?.problems.filter((x) => !x.startsWith('Sin precio')) ?? [];
  const folioOk = /^\d{1,8}$/.test(folio) && Number(folio) > 0;
  const lastFolio = folioOk ? Number(folio) + invoices - 1 : null;

  if (download.data)
    return (
      <Modal title="Archivo para Nubox listo" onClose={onClose} footer={<Button onClick={onClose}>Listo</Button>}>
        <div className="flex flex-col items-center py-2 text-center text-sm">
          <span className="anim-pop grid size-12 place-items-center rounded-full bg-money-50 text-money-600">
            <CheckCircle2 className="size-7" />
          </span>
          <p className="mt-3 font-medium">Se descargó {download.data}</p>
          <p className="mt-1 max-w-md text-muted">
            En Nubox, entra a <b>Ventas → Importar ventas electrónicas</b> y sube este archivo.{' '}
            {invoices === 1 ? 'Se crea 1 factura' : `Se crean ${invoices} facturas`}{' '}
            {lastFolio && invoices > 1 ? `(folios ${folio} al ${lastFolio})` : `(folio ${folio})`}.
          </p>
        </div>
      </Modal>
    );

  return (
    <Modal
      wide
      title={p ? `Archivo Nubox: factura a ${p.client}` : 'Archivo Nubox'}
      intro={`${orderNumbers.length} ${orderNumbers.length === 1 ? 'venta' : 'ventas'}: una factura por día y retail. Cada línea lleva el producto y, en la descripción, la OC y el retail.`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => download.mutate()}
            loading={download.isPending}
            disabled={!p || !invoices || blocking.length > 0 || missing.length > 0 || !folioOk || (sameDate && !fecha)}
          >
            <Download className="size-4" /> Descargar archivo Nubox
          </Button>
        </>
      }
    >
      {preview.isLoading || !receptor ? (
        <Loading />
      ) : p ? (
        <>
          {blocking.length > 0 && (
            <p className="flex gap-2 rounded-xl border border-berry-100 bg-berry-50 px-3 py-2.5 text-sm text-berry-700">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {blocking.join(' · ')}
            </p>
          )}
          {warnings.length > 0 && (
            <div className="flex gap-2 rounded-xl border border-sun-100 bg-sun-50 px-3 py-2.5 text-sm text-sun-700">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <ul className="space-y-0.5">
                {warnings.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid gap-3 rounded-xl border border-line bg-[#fafbfc] p-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-xs text-muted">Folio {invoices > 1 ? 'de la primera factura' : 'de la factura'}</span>
              <input
                value={folio}
                onChange={(e) => setFolio(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                placeholder="Ej. 1250"
                className={`mt-1 ${inputCls}`}
              />
              <span className="mt-1 block text-xs text-muted">
                El siguiente folio libre de factura en Nubox{lastFolio && invoices > 1 ? `; usará del ${folio} al ${lastFolio}` : ''}.
              </span>
            </label>
            <fieldset className="text-sm">
              <legend className="text-xs text-muted">Fecha de las facturas</legend>
              <label className="mt-1.5 flex items-center gap-2">
                <input type="radio" checked={!sameDate} onChange={() => setSameDate(false)} className="accent-brand-600" /> La fecha de las ventas de cada una
              </label>
              <label className="mt-1 flex flex-wrap items-center gap-2">
                <input type="radio" checked={sameDate} onChange={() => setSameDate(true)} className="accent-brand-600" /> Una fecha para todas
                {sameDate && (
                  <input
                    type="date"
                    value={fecha}
                    onChange={(e) => setFecha(e.target.value)}
                    className="h-8 rounded-lg border border-line bg-white px-2 text-sm"
                  />
                )}
              </label>
            </fieldset>
          </div>

          {/* Las facturas que salen del archivo */}
          <div className="overflow-hidden rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead className="bg-[#fafbfc] text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Folio</th>
                  <th className="px-3 py-2 font-medium">Fecha</th>
                  <th className="px-3 py-2 font-medium">Retail</th>
                  <th className="px-3 py-2 font-medium">Órdenes de compra</th>
                  <th className="px-3 py-2 text-right font-medium">Total con IVA</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g, i) => {
                  const net = g.lines.reduce((n, l) => n + l.net, 0);
                  const ocs = [...new Set(g.lines.map((l) => l.oc))];
                  return (
                    <tr key={`${g.date}|${g.origin}`} className="border-t border-line align-top">
                      <td className="px-3 py-2 tabular-nums">{folioOk ? Number(folio) + i : '—'}</td>
                      <td className="px-3 py-2">{dmy(sameDate ? fecha : g.date)}</td>
                      <td className="px-3 py-2 font-medium">{g.origin}</td>
                      <td className="px-3 py-2 text-xs text-muted">{ocs.join(', ')}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{clp(Math.round(net * 1.19))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <InvoicePreview receptor={receptor} lines={p.lines} net={p.net} vat={p.vat} total={p.total} onReceptor={set} disabled={download.isPending} />
          {missing.length > 0 && <p className="text-xs text-sun-700">Escribe los datos del cliente que faltan: Cuadra los recuerda para la próxima vez.</p>}
          <p className="text-xs text-muted">
            Precios netos por unidad, como pide Nubox; Nubox suma el IVA ({clp(p.vat)}). Total {clp(p.total)}.
          </p>
          <ErrorBox error={download.error} />
        </>
      ) : (
        <ErrorBox error={preview.error} />
      )}
    </Modal>
  );
}
