'use client';

import { useState } from 'react';
import type { FacturaReceptor, InvoiceLine } from '@/lib/api';
import { cn } from '@/lib/cn';
import { clp } from './ui';

const FIELDS: { key: keyof FacturaReceptor; label: string; max: number }[] = [
  { key: 'name', label: 'Cliente', max: 100 },
  { key: 'rut', label: 'RUT', max: 12 },
  { key: 'activity', label: 'Giro', max: 40 },
  { key: 'address', label: 'Dirección', max: 70 },
  { key: 'commune', label: 'Comuna', max: 20 },
];

/**
 * Factura como se va a emitir, en el formato de una planilla: cliente y RUT arriba; código,
 * descripción (producto, OC y retail donde se vendió) y monto neto; y abajo neto, IVA y total.
 * Los datos del cliente que falten se escriben ahí mismo.
 */
export function InvoicePreview({
  receptor,
  lines,
  net,
  vat,
  total,
  onReceptor,
  disabled,
}: {
  receptor: FacturaReceptor;
  lines: InvoiceLine[];
  net: number;
  vat: number;
  total: number;
  onReceptor?: (field: keyof FacturaReceptor, value: string) => void;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const missing = FIELDS.filter((f) => !receptor[f.key]?.trim());
  const cell = 'border-line px-3 py-1.5';
  return (
    <div className="space-y-3 text-[0.8125rem]">
      {/* Cliente */}
      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full">
          <tbody>
            {FIELDS.map((f, i) => {
              const empty = !receptor[f.key]?.trim();
              const edit = onReceptor && (editing || empty);
              return (
                <tr key={f.key} className={cn(i > 0 && 'border-t border-line')}>
                  <th className={cn(cell, 'w-28 bg-[#f4f6f9] text-left font-medium whitespace-nowrap text-muted')}>{f.label}</th>
                  <td className={cn(cell, 'border-l', empty && 'bg-sun-50/60')}>
                    {edit ? (
                      <input
                        value={receptor[f.key] ?? ''}
                        onChange={(e) => onReceptor!(f.key, e.target.value)}
                        disabled={disabled}
                        maxLength={f.max}
                        placeholder={empty ? `Falta ${f.label.toLowerCase()}` : undefined}
                        aria-label={f.label}
                        className={cn(
                          'w-full rounded-md border bg-white px-2 py-1 outline-none focus:border-brand-500',
                          empty ? 'border-sun-500' : 'border-line',
                          f.key === 'name' && 'font-semibold',
                        )}
                      />
                    ) : (
                      <span className={cn(f.key === 'name' && 'font-semibold')}>{receptor[f.key]}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {onReceptor && !editing && !missing.length && !disabled && (
          <button onClick={() => setEditing(true)} className="w-full border-t border-line bg-[#fafbfc] px-3 py-1 text-left text-xs font-medium text-brand-700 hover:underline">
            Cambiar datos del cliente
          </button>
        )}
      </div>

      {/* Detalle */}
      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full">
          <thead>
            <tr className="bg-[#f4f6f9] text-left text-xs font-medium text-muted">
              <th className={cn(cell, 'w-32')}>Código</th>
              <th className={cn(cell, 'border-l')}>Descripción</th>
              <th className={cn(cell, 'w-32 border-l text-right')}>Monto</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-t border-line align-top">
                <td className={cn(cell, 'font-mono text-xs')}>{l.code ?? '—'}</td>
                <td className={cn(cell, 'border-l')}>
                  <p className="font-medium">{l.name}</p>
                  <p className="text-xs text-muted">OC {l.oc}</p>
                  {l.origin && <p className="text-xs text-muted">Cliente {l.origin}</p>}
                </td>
                <td className={cn(cell, 'border-l text-right')}>
                  {l.unitNet ? <span className="figure">{clp(l.net)}</span> : <span className="text-berry-700">sin precio</span>}
                  {l.quantity > 1 && l.unitNet ? (
                    <p className="figure text-xs text-muted">
                      {l.quantity} × {clp(l.unitNet)}
                    </p>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {[
              ['Neto', net],
              ['IVA 19%', vat],
              ['Total', total],
            ].map(([label, value], i) => (
              <tr key={label as string} className={cn('border-t border-line', i === 2 && 'bg-[#f4f6f9] font-semibold')}>
                <td className={cell} />
                <td className={cn(cell, 'border-l text-right text-muted', i === 2 && 'text-ink')}>{label}</td>
                <td className={cn(cell, 'figure border-l text-right')}>{clp(value as number)}</td>
              </tr>
            ))}
          </tfoot>
        </table>
      </div>
    </div>
  );
}
