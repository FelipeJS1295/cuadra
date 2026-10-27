"use client";

import { useQuery } from "@tanstack/react-query";
import { Printer, Truck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type DispatchLine } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Empty, ErrorBox, Loading, todayCL } from "./ui";

const NO_DATE = "sin-fecha";

/** "2026-10-27" -> "27-10-2026" */
const dmyDash = (d: string) => d.split("-").reverse().join("-");
const weekday = (d: string) =>
  new Intl.DateTimeFormat("es-CL", { weekday: "short", timeZone: "UTC" })
    .format(new Date(`${d}T12:00:00Z`))
    .replace(".", "");

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
 * Se puede imprimir (sale solo la tabla, en horizontal).
 */
export function DispatchBoard({ onClose }: { onClose: () => void }) {
  const q = useQuery({
    queryKey: ["dispatch-board"],
    queryFn: api.dispatchBoard,
  });
  const [courier, setCourier] = useState<string>("");
  const today = todayCL();

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const lines = useMemo(
    () => (q.data ?? []).filter((l) => !courier || l.courier === courier),
    [q.data, courier],
  );
  const couriers = useMemo(
    () => [...new Set((q.data ?? []).map((l) => l.courier))].sort(),
    [q.data],
  );
  const { dates, groups, byDate, total } = useMemo(() => pivot(lines), [lines]);

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
            <h2 className="display text-lg font-semibold">
              Maestra de despachos
            </h2>
            <p className="mt-1 text-sm text-muted">
              Unidades por despachar según fecha límite y quién retira · órdenes
              pendientes y en preparación
              <span className="print-only"> · impresa el {dmyDash(today)}</span>
            </p>
          </div>
          <div className="no-print flex items-center gap-2">
            <button
              onClick={() => window.print()}
              disabled={!lines.length}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-45"
            >
              <Printer className="size-4" /> Imprimir
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-muted hover:bg-paper hover:text-ink"
              aria-label="Cerrar"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        <div className="space-y-4 px-6 py-5">
          {couriers.length > 1 && (
            <div className="no-print flex flex-wrap gap-1 rounded-xl bg-stone-100 p-1 sm:inline-flex">
              {["", ...couriers].map((c) => (
                <button
                  key={c || "todos"}
                  onClick={() => setCourier(c)}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-sm font-medium",
                    c === courier
                      ? "bg-white text-ink shadow-sm"
                      : "text-muted hover:text-ink",
                  )}
                >
                  {c || "Todos"}
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
              <table className="dispatch-table w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-[#eef1f5]">
                    <th className="sticky left-0 z-10 min-w-56 border-b border-line bg-[#eef1f5] px-3 py-2 text-left text-xs font-medium tracking-wide text-muted uppercase">
                      Producto
                    </th>
                    {dates.map((d) => (
                      <th
                        key={d}
                        className={cn(
                          "border-b border-l border-line px-2 py-2 text-center text-xs font-semibold whitespace-nowrap",
                          d === today
                            ? "bg-brand-50 text-brand-700"
                            : d !== NO_DATE && d < today
                              ? "text-berry-700"
                              : "text-ink",
                        )}
                      >
                        {d === NO_DATE ? (
                          "Sin fecha"
                        ) : (
                          <>
                            <span className="block text-[0.6875rem] font-normal text-muted capitalize">
                              {d === today
                                ? "hoy"
                                : d < today
                                  ? "atrasado"
                                  : weekday(d)}
                            </span>
                            {dmyDash(d)}
                          </>
                        )}
                      </th>
                    ))}
                    <th className="border-b border-l border-line px-3 py-2 text-center text-xs font-semibold whitespace-nowrap">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <GroupRows
                      key={g.courier}
                      g={g}
                      dates={dates}
                      today={today}
                    />
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-[#eef1f5] font-semibold">
                    <td className="sticky left-0 border-t border-line bg-[#eef1f5] px-3 py-2">
                      Total general
                    </td>
                    {dates.map((d) => (
                      <td
                        key={d}
                        className="figure border-t border-l border-line px-2 py-2 text-center"
                      >
                        {byDate.get(d) || ""}
                      </td>
                    ))}
                    <td className="figure border-t border-l border-line px-3 py-2 text-center">
                      {total}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {lines.length > 0 && (
            <p className="no-print text-xs text-muted">
              Retiran: Walmart, Falabella e Hites → Bluexpress · Paris → Starken
              · Ripley → Ripley. Las órdenes Fulfillment no aparecen (las
              despacha el retailer). Pasa el mouse sobre un número para ver sus
              órdenes.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function GroupRows({
  g,
  dates,
  today,
}: {
  g: Group;
  dates: string[];
  today: string;
}) {
  return (
    <>
      <tr className="dispatch-group bg-brand-600 text-white">
        <td className="sticky left-0 bg-brand-600 px-3 py-2 text-base font-semibold">
          {g.courier}
        </td>
        {dates.map((d) => (
          <td
            key={d}
            className="figure border-l border-white/20 px-2 py-2 text-center text-base font-semibold"
          >
            {g.byDate.get(d) || ""}
          </td>
        ))}
        <td className="figure border-l border-white/20 px-3 py-2 text-center text-base font-semibold">
          {g.total}
        </td>
      </tr>
      {g.products.map((p) => (
        <tr key={p.name} className="border-t border-line/70">
          <td className="sticky left-0 bg-white px-3 py-1.5 pl-5 font-medium">
            {p.name}
          </td>
          {dates.map((d) => {
            const n = p.byDate.get(d);
            return (
              <td
                key={d}
                title={
                  n ? `Órdenes: ${p.orders.get(d)!.join(", ")}` : undefined
                }
                className={cn(
                  "figure border-l border-line/70 px-2 py-1.5 text-center",
                  d === today && "bg-brand-50/60",
                  n &&
                    d !== NO_DATE &&
                    d < today &&
                    "font-semibold text-berry-700",
                )}
              >
                {n || ""}
              </td>
            );
          })}
          <td className="figure border-l border-line/70 px-3 py-1.5 text-center font-semibold">
            {p.total}
          </td>
        </tr>
      ))}
    </>
  );
}

function pivot(lines: DispatchLine[]) {
  const dates = [...new Set(lines.map((l) => l.date ?? NO_DATE))].sort(
    (a, b) => (a === NO_DATE ? 1 : b === NO_DATE ? -1 : a.localeCompare(b)),
  );
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
    p.orders.set(d, [
      ...(p.orders.get(d) ?? []),
      `${l.retailer} ${l.orderNumber ?? ""}`.trim(),
    ]);
    p.total += l.quantity;
    g.byDate.set(d, (g.byDate.get(d) ?? 0) + l.quantity);
    g.total += l.quantity;
    byDate.set(d, (byDate.get(d) ?? 0) + l.quantity);
    total += l.quantity;
  }
  const groups = [...map.values()].sort((a, b) => b.total - a.total);
  // Productos: primero los que se despachan antes
  const first = (p: Group["products"][number]) =>
    [...p.byDate.keys()].sort()[0] ?? "";
  for (const g of groups)
    g.products.sort(
      (a, b) =>
        first(a).localeCompare(first(b)) || a.name.localeCompare(b.name),
    );
  return { dates, groups, byDate, total };
}
