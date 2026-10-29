'use client';

import { useQuery } from '@tanstack/react-query';
import { Printer, Truck, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type DispatchLine } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Empty, ErrorBox, Loading, todayCL } from './ui';

const NO_DATE = 'sin-fecha';

/** "2026-10-27" -> "27-10-2026" */
const dmyDash = (d: string) => d.split('-').reverse().join('-');
const weekday = (d: string) => new Intl.DateTimeFormat('es-CL', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`)).replace('.', '');

/** Estilos del cuadro impreso (la hoja se arma aparte, sin el resto de la página) */
const PRINT_CSS = `
@page { size: landscape; margin: 8mm; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; }
body { font-family: Arial, Helvetica, sans-serif; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
table { border-collapse: collapse; font-size: 12px; }
th, td { border: 1px solid #9aa3ad; padding: 3px 7px; text-align: center; white-space: nowrap; }
th:first-child, td:first-child { text-align: left; white-space: normal; min-width: 180px; max-width: 300px; }
thead th { background: #eef1f5; font-weight: 700; }
thead th span { display: block; font-weight: 400; font-size: 10px; color: #555; text-transform: capitalize; }
.dispatch-group td { background: #2f5bd3; color: #fff; font-weight: 700; font-size: 13px; }
tfoot td { background: #eef1f5; font-weight: 700; }
`;

/**
 * Imprime solo el cuadro, en una hoja horizontal: se copia a un marco aparte y se achica
 * lo necesario para que quepa en una página (carta o A4).
 */
function printTable(table: HTMLTableElement) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1800px;height:1200px;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>Maestra de despachos</title><style>${PRINT_CSS}</style></head><body>${table.outerHTML}</body></html>`,
  );
  doc.close();
  const t = doc.querySelector('table')!;
  const box = doc.createElement('div');
  box.appendChild(t);
  doc.body.appendChild(box);
  // Área útil de una hoja horizontal (la menor entre carta y A4, con 8 mm de margen), en px,
  // con un 4% de holgura para que nunca pase a una segunda hoja
  const mm = 96 / 25.4;
  const { width, height } = t.getBoundingClientRect();
  // Si el cuadro es chico se agranda un poco (hasta 1,5x) para que se lea mejor de lejos
  const scale = Math.min(1.5, (263 * mm) / width, (193 * mm) / height) * 0.96;
  // Se achica con transform (el zoom no evita que el navegador corte la tabla en dos hojas)
  // y se recorta el alto al tamaño ya achicado, para que no salga una hoja en blanco.
  box.style.cssText = `transform: scale(${scale}); transform-origin: 0 0; width: ${Math.ceil(width)}px;`;
  doc.documentElement.style.cssText = doc.body.style.cssText = `height: ${Math.ceil(height * scale) + 2}px; overflow: hidden;`;
  const w = frame.contentWindow!;
  const done = () => setTimeout(() => frame.remove(), 500);
  w.addEventListener('afterprint', done);
  w.focus();
  w.print();
  // Safari no siempre avisa "afterprint"
  setTimeout(done, 60_000);
}

interface Group {
  courier: string;
  total: number;
  byDate: Map<string, number>;
  products: {
    name: string;
    total: number;
    byDate: Map<string, number>;
    orders: Map<string, string[]>;
  }[];
}

/**
 * Maestra de despachos: cuántas unidades de cada producto hay que tener listas para cada retiro,
 * agrupadas por quién retira (Bluexpress, Starken, Ripley…) y por fecha límite de despacho.
 * Se puede imprimir: sale solo el cuadro, en una hoja horizontal.
 */
export function DispatchBoard({ onClose }: { onClose: () => void }) {
  const q = useQuery({
    queryKey: ['dispatch-board'],
    queryFn: api.dispatchBoard,
  });
  const [courier, setCourier] = useState<string>('');
  const today = todayCL();

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const lines = useMemo(() => (q.data ?? []).filter((l) => !courier || l.courier === courier), [q.data, courier]);
  const couriers = useMemo(() => [...new Set((q.data ?? []).map((l) => l.courier))].sort(), [q.data]);
  const { dates, groups, byDate, total } = useMemo(() => pivot(lines), [lines]);
  const tableRef = useRef<HTMLTableElement>(null);

  return (
    <div
      className="print-root fixed inset-0 z-50 overflow-y-auto bg-graphite-900/45 p-3 backdrop-blur-[2px] sm:p-8"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Maestra de despachos"
    >
      <div className="print-area mx-auto w-full max-w-6xl rounded-2xl border border-line bg-white shadow-[0_24px_60px_-20px_rgba(15,20,30,0.35)]">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div>
            <h2 className="display text-lg font-semibold">Maestra de despachos</h2>
            <p className="mt-1 text-sm text-muted">
              Unidades por despachar según fecha límite y quién retira · órdenes pendientes y en preparación
              <span className="print-only"> · impresa el {dmyDash(today)}</span>
            </p>
          </div>
          <div className="no-print flex items-center gap-2">
            <button
              onClick={() => tableRef.current && printTable(tableRef.current)}
              disabled={!lines.length}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-45"
            >
              <Printer className="size-4" /> Imprimir
            </button>
            <button onClick={onClose} className="rounded-lg p-1.5 text-muted hover:bg-paper hover:text-ink" aria-label="Cerrar">
              <X className="size-5" />
            </button>
          </div>
        </div>

        <div className="space-y-4 px-6 py-5">
          {couriers.length > 1 && (
            <div className="no-print flex flex-wrap gap-1 rounded-xl bg-stone-100 p-1 sm:inline-flex">
              {['', ...couriers].map((c) => (
                <button
                  key={c || 'todos'}
                  onClick={() => setCourier(c)}
                  className={cn('rounded-lg px-3 py-1.5 text-sm font-medium', c === courier ? 'bg-white text-ink shadow-sm' : 'text-muted hover:text-ink')}
                >
                  {c || 'Todos'}
                </button>
              ))}
            </div>
          )}

          <ErrorBox error={q.error} />
          {q.isLoading ? (
            <Loading />
          ) : !lines.length ? (
            <Empty
              icon={<Truck className="size-6" />}
              title="No hay nada por despachar"
              text="Aquí aparecen los productos de las órdenes pendientes o en preparación."
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-line">
              <table ref={tableRef} className="dispatch-table w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-[#eef1f5]">
                    <th className="sticky left-0 z-10 min-w-56 border-b border-line bg-[#eef1f5] px-3 py-2 text-left text-xs font-medium tracking-wide text-muted uppercase">
                      Producto
                    </th>
                    {dates.map((d) => (
                      <th
                        key={d}
                        className={cn(
                          'border-b border-l border-line px-2 py-2 text-center text-xs font-semibold whitespace-nowrap',
                          d === today ? 'bg-brand-50 text-brand-700' : d !== NO_DATE && d < today ? 'text-berry-700' : 'text-ink',
                        )}
                      >
                        {d === NO_DATE ? (
                          'Sin fecha'
                        ) : (
                          <>
                            <span className="block text-[0.6875rem] font-normal text-muted capitalize">
                              {d === today ? 'hoy' : d < today ? 'atrasado' : weekday(d)}
                            </span>
                            {dmyDash(d)}
                          </>
                        )}
                      </th>
                    ))}
                    <th className="border-b border-l border-line px-3 py-2 text-center text-xs font-semibold whitespace-nowrap">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <GroupRows key={g.courier} g={g} dates={dates} today={today} />
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-[#eef1f5] font-semibold">
                    <td className="sticky left-0 border-t border-line bg-[#eef1f5] px-3 py-2">Total general</td>
                    {dates.map((d) => (
                      <td key={d} className="figure border-t border-l border-line px-2 py-2 text-center">
                        {byDate.get(d) || ''}
                      </td>
                    ))}
                    <td className="figure border-t border-l border-line px-3 py-2 text-center">{total}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {lines.length > 0 && (
            <p className="no-print text-xs text-muted">
              Retiran: Walmart, Falabella e Hites → Bluexpress · Paris → Starken · Ripley → Ripley. Las órdenes Fulfillment no aparecen (las despacha el
              retailer). Pasa el mouse sobre un número para ver sus órdenes.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function GroupRows({ g, dates, today }: { g: Group; dates: string[]; today: string }) {
  return (
    <>
      <tr className="dispatch-group bg-brand-600 text-white">
        <td className="sticky left-0 bg-brand-600 px-3 py-2 text-base font-semibold">{g.courier}</td>
        {dates.map((d) => (
          <td key={d} className="figure border-l border-white/20 px-2 py-2 text-center text-base font-semibold">
            {g.byDate.get(d) || ''}
          </td>
        ))}
        <td className="figure border-l border-white/20 px-3 py-2 text-center text-base font-semibold">{g.total}</td>
      </tr>
      {g.products.map((p) => (
        <tr key={p.name} className="border-t border-line/70">
          <td className="sticky left-0 bg-white px-3 py-1.5 pl-5 font-medium">{p.name}</td>
          {dates.map((d) => {
            const n = p.byDate.get(d);
            return (
              <td
                key={d}
                title={n ? `Órdenes: ${p.orders.get(d)!.join(', ')}` : undefined}
                className={cn(
                  'figure border-l border-line/70 px-2 py-1.5 text-center',
                  d === today && 'bg-brand-50/60',
                  n && d !== NO_DATE && d < today && 'font-semibold text-berry-700',
                )}
              >
                {n || ''}
              </td>
            );
          })}
          <td className="figure border-l border-line/70 px-3 py-1.5 text-center font-semibold">{p.total}</td>
        </tr>
      ))}
    </>
  );
}

function pivot(lines: DispatchLine[]) {
  const dates = [...new Set(lines.map((l) => l.date ?? NO_DATE))].sort((a, b) => (a === NO_DATE ? 1 : b === NO_DATE ? -1 : a.localeCompare(b)));
  const map = new Map<string, Group>();
  const byDate = new Map<string, number>();
  let total = 0;
  for (const l of lines) {
    const d = l.date ?? NO_DATE;
    const g: Group = map.get(l.courier) ?? {
      courier: l.courier,
      total: 0,
      byDate: new Map(),
      products: [],
    };
    map.set(l.courier, g);
    let p = g.products.find((x) => x.name === l.product);
    if (!p) {
      p = { name: l.product, total: 0, byDate: new Map(), orders: new Map() };
      g.products.push(p);
    }
    p.byDate.set(d, (p.byDate.get(d) ?? 0) + l.quantity);
    p.orders.set(d, [...(p.orders.get(d) ?? []), `${l.retailer} ${l.orderNumber ?? ''}`.trim()]);
    p.total += l.quantity;
    g.byDate.set(d, (g.byDate.get(d) ?? 0) + l.quantity);
    g.total += l.quantity;
    byDate.set(d, (byDate.get(d) ?? 0) + l.quantity);
    total += l.quantity;
  }
  const groups = [...map.values()].sort((a, b) => b.total - a.total);
  // Productos: primero los que se despachan antes
  const first = (p: Group['products'][number]) => [...p.byDate.keys()].sort()[0] ?? '';
  for (const g of groups) g.products.sort((a, b) => first(a).localeCompare(first(b)) || a.name.localeCompare(b.name));
  return { dates, groups, byDate, total };
}
