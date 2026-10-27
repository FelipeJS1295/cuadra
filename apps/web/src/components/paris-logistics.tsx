'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, CheckCircle2, ExternalLink, Printer, Truck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, type PickupInput, type PickupSize, type SaleRow } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button, dmy, ErrorBox, Field, inputCls, Loading, Modal, Pill, todayCL } from './ui';

const SIZES: { id: PickupSize; label: string; dims: string }[] = [
  { id: 'xs', label: 'Sobre', dims: '20×20×1 cm' },
  { id: 's', label: 'Pequeño', dims: '10×15×5 cm' },
  { id: 'm', label: 'Mediano', dims: '20×30×10 cm' },
  { id: 'l', label: 'Grande', dims: '40×60×30 cm' },
  { id: 'c', label: 'Más grande', dims: 'Otras medidas' },
];

const shift = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Siguiente día hábil (lunes a viernes) */
function nextWorkday(d: string) {
  let x = shift(d, 1);
  while ([0, 6].includes(new Date(`${x}T12:00:00Z`).getUTCDay())) x = shift(x, 1);
  return x;
}

const pickupTone = (code: string | null, name: string | null) => {
  const s = `${code ?? ''} ${name ?? ''}`.toLowerCase();
  if (/done|efectuad|realizad|retirad/.test(s)) return 'verde' as const;
  if (/cancel|fallid|fail|no retir/.test(s)) return 'rojo' as const;
  return 'azul' as const;
};

/**
 * Retiros de Envíame para Paris (la "cita" con el courier): los agendados y el formulario de
 * "Crear retiro diario" igual que en app.enviame.io. Cuadra recuerda courier, bodega y contacto.
 */
export function ParisPickups({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const today = todayCL();
  const setup = useQuery({ queryKey: ['enviame-setup'], queryFn: api.enviameSetup });
  const list = useQuery({ queryKey: ['enviame-pickups'], queryFn: () => api.enviamePickups(shift(today, -3), shift(today, 10)) });
  const board = useQuery({ queryKey: ['dispatch-board'], queryFn: api.dispatchBoard });
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState<PickupInput>({
    carrierCode: '',
    warehouseCode: '',
    qty: 0,
    weight: 0,
    size: 'm',
    pickupDate: nextWorkday(today),
    rangeTime: 'PM',
    contactName: '',
    contactPhone: '',
  });
  const [qtyTouched, setQtyTouched] = useState(false);
  const set = <K extends keyof PickupInput>(k: K, v: PickupInput[K]) => setF((x) => ({ ...x, [k]: v }));

  // Rellena con lo último usado (o con el contacto de la bodega)
  useEffect(() => {
    const s = setup.data;
    if (!s) return;
    const w = s.warehouses.find((x) => x.code === s.last.warehouseCode) ?? s.warehouses[0];
    setF((x) => ({
      ...x,
      carrierCode: s.last.carrierCode && s.carriers.some((c) => c.code === s.last.carrierCode) ? s.last.carrierCode : (s.carriers[0]?.code ?? ''),
      warehouseCode: w?.code ?? '',
      contactName: s.last.contactName ?? w?.contactName ?? '',
      contactPhone: s.last.contactPhone ?? w?.contactPhone ?? '',
      rangeTime: s.last.rangeTime ?? x.rangeTime,
      size: s.last.size ?? x.size,
    }));
  }, [setup.data]);

  // Unidades de Paris por despachar ese día (sugerencia de bultos)
  const units = useMemo(
    () => (board.data ?? []).filter((l) => l.retailerCode === 'CENCOSUD' && l.date === f.pickupDate).reduce((n, l) => n + l.quantity, 0),
    [board.data, f.pickupDate],
  );
  useEffect(() => {
    if (!qtyTouched) setF((x) => ({ ...x, qty: units }));
  }, [units, qtyTouched]);

  const create = useMutation({
    mutationFn: () => api.createPickup(f),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enviame-pickups'] });
      qc.invalidateQueries({ queryKey: ['enviame-setup'] });
      setCreating(false);
    },
  });

  const lowQty = f.qty > 0 && f.qty < 6 && f.size !== 'c';
  const ready =
    f.carrierCode &&
    f.warehouseCode &&
    f.qty > 0 &&
    f.weight > 0 &&
    f.contactName.trim() &&
    f.contactPhone.trim().length >= 8 &&
    (f.size !== 'c' || f.customSize?.trim());

  if (setup.isLoading)
    return (
      <Modal title="Retiros Paris (Envíame)" onClose={onClose}>
        <Loading />
      </Modal>
    );
  if (setup.error)
    return (
      <Modal title="Retiros Paris (Envíame)" onClose={onClose} footer={<Button onClick={onClose}>Cerrar</Button>}>
        <ErrorBox error={setup.error} />
      </Modal>
    );

  return (
    <Modal
      wide
      title="Retiros Paris (Envíame)"
      intro="El courier pasa a buscar los paquetes a tu bodega. Se agenda en Envíame igual que en su portal."
      onClose={onClose}
      footer={
        creating ? (
          <>
            <Button variant="secondary" onClick={() => setCreating(false)} disabled={create.isPending}>
              Volver
            </Button>
            <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!ready}>
              <CalendarPlus className="size-4" /> Crear retiro
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cerrar
            </Button>
            <Button onClick={() => setCreating(true)}>
              <CalendarPlus className="size-4" /> Agendar retiro
            </Button>
          </>
        )
      }
    >
      {creating ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Courier">
            <select value={f.carrierCode} onChange={(e) => set('carrierCode', e.target.value)} className={inputCls}>
              {!setup.data!.carriers.length && <option value="">Sin couriers en Envíame</option>}
              {setup.data!.carriers.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name || c.code}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Lugar de retiro / bodega">
            <select value={f.warehouseCode} onChange={(e) => set('warehouseCode', e.target.value)} className={inputCls}>
              {!setup.data!.warehouses.length && <option value="">Sin bodegas en Envíame</option>}
              {setup.data!.warehouses.map((w) => (
                <option key={w.code} value={w.code}>
                  {w.name}
                  {w.address ? ` · ${w.address}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Fecha de retiro">
            <input type="date" min={today} value={f.pickupDate} onChange={(e) => set('pickupDate', e.target.value)} className={inputCls} />
          </Field>
          <Field label="Rango horario">
            <select value={f.rangeTime} onChange={(e) => set('rangeTime', e.target.value as 'AM' | 'PM')} className={inputCls}>
              <option value="AM">AM (mañana)</option>
              <option value="PM">PM (tarde)</option>
            </select>
          </Field>
          <Field
            label="Cantidad de bultos"
            hint={units ? `${units} ${units === 1 ? 'unidad' : 'unidades'} de Paris para despachar ese día` : 'Sin ventas de Paris para ese día'}
          >
            <input
              type="number"
              min={1}
              value={f.qty || ''}
              onChange={(e) => {
                setQtyTouched(true);
                set('qty', Number(e.target.value));
              }}
              className={inputCls}
            />
          </Field>
          <Field label="Peso total (kg)">
            <input type="number" min={1} value={f.weight || ''} onChange={(e) => set('weight', Number(e.target.value))} className={inputCls} />
          </Field>
          <div className="sm:col-span-2">
            <p className="mb-1.5 text-[0.8125rem] font-medium text-ink/85">Volumen promedio (o el del bulto más grande)</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {SIZES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => set('size', s.id)}
                  className={cn(
                    'rounded-xl border px-3 py-2 text-left text-sm transition-colors',
                    f.size === s.id ? 'border-brand-600 bg-brand-50 ring-2 ring-brand-100' : 'border-line hover:border-line-strong',
                  )}
                >
                  <span className="block font-medium">{s.label}</span>
                  <span className="text-xs text-muted">{s.dims}</span>
                </button>
              ))}
            </div>
            {f.size === 'c' && (
              <input
                value={f.customSize ?? ''}
                onChange={(e) => set('customSize', e.target.value)}
                placeholder="Medidas, ej: 200x90x80 cm"
                className={cn(inputCls, 'mt-2')}
              />
            )}
          </div>
          <Field label="Nombre contacto bodega">
            <input value={f.contactName} onChange={(e) => set('contactName', e.target.value)} className={inputCls} />
          </Field>
          <Field label="Teléfono de contacto">
            <input value={f.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} placeholder="+56912345678" className={inputCls} />
          </Field>
          {lowQty && (
            <p className="text-xs text-sun-700 sm:col-span-2">
              Envíame pide mínimo 6 bultos para un retiro (o un producto grande: elige &quot;Más grande&quot;). Con menos, lleva los paquetes al punto del
              courier.
            </p>
          )}
          <div className="sm:col-span-2">
            <ErrorBox error={create.error} />
          </div>
        </div>
      ) : (
        <>
          {create.isSuccess && (
            <div className="anim-rise flex items-center gap-2 rounded-xl bg-money-50 px-3 py-2.5 text-sm text-money-700">
              <CheckCircle2 className="size-4" /> Retiro agendado en Envíame{create.data?.id ? ` (N° ${create.data.id})` : ''}.
            </div>
          )}
          {list.isLoading ? (
            <Loading />
          ) : list.error ? (
            <ErrorBox error={list.error} />
          ) : !list.data?.length ? (
            <div className="flex flex-col items-center py-6 text-center text-sm text-muted">
              <Truck className="mb-2 size-6" />
              No hay retiros agendados entre el {dmy(shift(today, -3))} y el {dmy(shift(today, 10))}.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-line">
              <table className="w-full text-sm">
                <thead className="bg-[#f4f6f9] text-left text-xs text-muted">
                  <tr>
                    {['Fecha', 'Horario', 'Courier', 'Bultos', 'Estado'].map((h) => (
                      <th key={h} className="px-3 py-2 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.data.map((p) => (
                    <tr key={p.id} className={cn('border-t border-line', p.date === today && 'bg-brand-50/40')}>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {dmy(p.date)}
                        {p.date === today && <span className="ml-1.5 text-xs font-medium text-brand-700">hoy</span>}
                      </td>
                      <td className="px-3 py-2">{p.rangeTime ?? '—'}</td>
                      <td className="px-3 py-2">{p.carrier ?? '—'}</td>
                      <td className="figure px-3 py-2">{p.qty ?? '—'}</td>
                      <td className="px-3 py-2">
                        <Pill tone={pickupTone(p.statusCode, p.status)}>{p.status ?? '—'}</Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/** Etiquetas de Envíame para las ventas de Paris seleccionadas, en un solo PDF */
export function ParisLabels({ sales, onClose }: { sales: SaleRow[]; onClose: () => void }) {
  const orders = [...new Set(sales.filter((s) => s.retailerCode === 'CENCOSUD' && s.orderNumber).map((s) => s.orderNumber!))];
  const [url, setUrl] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => api.parisLabels(orders),
    onSuccess: (r) => {
      const u = URL.createObjectURL(r.pdf);
      setUrl(u);
      window.open(u, '_blank');
    },
  });
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  return (
    <Modal
      title="Etiquetas Paris"
      intro={`${orders.length} ${orders.length === 1 ? 'orden' : 'órdenes'} de Paris`}
      onClose={onClose}
      footer={
        run.data ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Listo
            </Button>
            <a href={url!} target="_blank" rel="noreferrer">
              <Button>
                <ExternalLink className="size-4" /> Abrir PDF
              </Button>
            </a>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button onClick={() => run.mutate()} loading={run.isPending} disabled={!orders.length}>
              <Printer className="size-4" /> Generar etiquetas
            </Button>
          </>
        )
      }
    >
      {run.data ? (
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2 rounded-xl bg-money-50 px-3 py-2.5 text-money-700">
            <CheckCircle2 className="size-4" /> {run.data.count} {run.data.count === 1 ? 'etiqueta lista' : 'etiquetas listas'} en un PDF. Quedan en el
            manifiesto de Envíame.
          </div>
          {run.data.missing.length > 0 && (
            <p className="text-sun-700">
              Envíame no tiene envío para: <b>{run.data.missing.join(', ')}</b>. Revisa en Envíame o usa &quot;Forzar actualización de Envíame&quot; en el
              Seller Center de Paris.
            </p>
          )}
        </div>
      ) : (
        <>
          <p className="text-sm text-muted">
            Cuadra busca cada orden en Envíame e imprime su etiqueta. Las que ya se imprimieron se vuelven a descargar. El envío tiene que estar &quot;Listo
            para despacho&quot;.
          </p>
          <p className="text-xs break-words text-muted">{orders.join(' · ')}</p>
          {sales.some((s) => s.retailerCode !== 'CENCOSUD') && <p className="text-xs text-sun-700">Las ventas que no son de Paris no se incluyen.</p>}
          <ErrorBox error={run.error} />
        </>
      )}
    </Modal>
  );
}
