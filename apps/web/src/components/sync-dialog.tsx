'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Check, Plug, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ORDER_STATE_INFO, type OrderState } from '@cuadra/shared';
import { api, type RetailApiConnection, type RetailProviderCode, type RetailSyncJob } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button, clp, dmy, Loading, Modal, Pill, todayCL } from './ui';

/** Lo que hay que refrescar cuando llegan ventas nuevas */
const SALES_KEYS = ['retail-connections', 'retail-orders', 'retailers', 'sales', 'receivables', 'home', 'vat'];

/** Desde el 20 del mes pasado hasta hoy (lo que cubre la liquidación que viene) */
function defaultRange() {
  const to = todayCL();
  const [y, m] = to.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 20));
  return { from: prev.toISOString().slice(0, 10), to };
}

type Stage = NonNullable<RetailSyncJob['stage']>;

const BASE_STEPS: { stage: Stage; label: string }[] = [
  { stage: 'CONECTANDO', label: 'Conectar' },
  { stage: 'BUSCANDO', label: 'Buscar ventas' },
  { stage: 'GUARDANDO', label: 'Guardar' },
  { stage: 'LIQUIDACION', label: 'Liquidación' },
];
/** Retailers donde se puede consultar si ya tienen la boleta de cada orden */
const CHECKS_RECEIPTS: RetailProviderCode[] = ['CENCOSUD', 'RIPLEY'];
const stepsOf = (provider: RetailProviderCode) =>
  CHECKS_RECEIPTS.includes(provider) ? [...BASE_STEPS, { stage: 'BOLETAS' as Stage, label: 'Boletas' }] : BASE_STEPS;
/** Pasos en orden, terminando en LISTO */
const orderOf = (provider: RetailProviderCode): Stage[] => [...stepsOf(provider).map((s) => s.stage), 'LISTO'];
const STAGE_TEXT: Record<Stage, (label: string) => string> = {
  CONECTANDO: (l) => `Conectando con ${l}…`,
  BUSCANDO: (l) => `Buscando ventas en ${l}…`,
  GUARDANDO: () => 'Guardando las órdenes…',
  LIQUIDACION: () => 'Trayendo la liquidación…',
  BOLETAS: (l) => `Revisando qué boletas tiene ${l}…`,
  LISTO: () => 'Listo',
  ERROR: () => 'Error',
};

interface Row {
  c: RetailApiConnection;
  job: RetailSyncJob | null;
  /** No se pudo ni empezar (p. ej. ya había una sincronización con otro rango) */
  error?: string;
  /**
   * Paso que se muestra (0 conectar … 4 listo). Avanza de a uno con una pausa corta, para que
   * se alcance a ver cada paso aunque el retailer responda al instante.
   */
  shown: number;
}

const failed = (r: Row) => !!r.error || r.job?.status === 'ERROR';
const finishedJob = (r: Row) => !!r.error || (r.job != null && r.job.status !== 'RUNNING');
/** Hasta qué paso se puede mostrar según lo que informa la API */
const last = (r: Row) => orderOf(r.c.provider).length - 1;
const target = (r: Row) => (failed(r) ? r.shown : finishedJob(r) ? last(r) : Math.max(0, orderOf(r.c.provider).indexOf(r.job?.stage ?? 'CONECTANDO')));
const done = (r: Row) => failed(r) || (finishedJob(r) && r.shown >= last(r));

/**
 * Trae las ventas de todos los retailers conectados por API, mostrando en vivo en qué va cada uno
 * (conectando, buscando ventas, guardando, liquidación) y al final un resumen de lo que llegó.
 */
export function SyncDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const conns = useQuery({ queryKey: ['retail-connections'], queryFn: api.retailConnections });
  const [rows, setRows] = useState<Row[] | null>(null);
  const range = useMemo(defaultRange, []);
  const started = useRef(false);

  const active = useMemo(() => (conns.data ?? []).filter((c) => c.enabled && c.configured), [conns.data]);

  // Ventas que llegaron de clientes de Cuadra (ej. Jamaroff): se actualizan las que ya están
  const clients = useQuery({ queryKey: ['b2b-clients'], queryFn: api.b2bClients });
  const hasClients = (clients.data?.length ?? 0) > 0;
  const refresh = useMutation({ mutationFn: api.b2bRefresh });
  const clientsStarted = useRef(false);
  useEffect(() => {
    if (hasClients && !clientsStarted.current) {
      clientsStarted.current = true;
      refresh.mutate();
    }
  }, [hasClients, refresh]);
  const clientsDone = !hasClients || refresh.isSuccess || refresh.isError;

  const patch = useCallback((provider: RetailProviderCode, p: Partial<Row>) => setRows((rs) => rs && rs.map((r) => (r.c.provider === provider ? { ...r, ...p } : r))), []);

  // Arranca todas a la vez apenas se sabe qué retailers están conectados
  useEffect(() => {
    if (!conns.data || started.current) return;
    started.current = true;
    setRows(active.map((c) => ({ c, job: null, shown: 0 })));
    active.forEach((c, i) => {
      // Un pequeño desfase para que se note cada conexión
      setTimeout(() => {
        api
          .syncRetailOrders(c.provider, range.from, range.to)
          .then((job) => patch(c.provider, { job }))
          .catch((e: unknown) => patch(c.provider, { error: e instanceof Error ? e.message : 'No se pudo iniciar' }));
      }, i * 250);
    });
  }, [conns.data, active, range, patch]);

  // Pregunta por el avance de las que siguen corriendo
  const running = rows?.filter((r) => r.job?.status === 'RUNNING') ?? [];
  const runningKey = running.map((r) => `${r.job!.id}:${r.job!.message}:${r.job!.stage}`).join('|');
  useEffect(() => {
    if (!running.length) return;
    const t = setTimeout(() => {
      for (const r of running)
        api
          .retailJob(r.job!.id)
          .then((job) => patch(r.c.provider, { job }))
          .catch(() => patch(r.c.provider, { job: { ...r.job!, status: 'ERROR', stage: 'ERROR', message: 'Se perdió el avance' } }));
    }, 1100);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningKey]);

  // Avanza de a un paso lo que se muestra
  const behind = rows?.some((r) => !failed(r) && r.shown < target(r)) ?? false;
  useEffect(() => {
    if (!behind) return;
    const t = setTimeout(() => setRows((rs) => rs && rs.map((r) => (!failed(r) && r.shown < target(r) ? { ...r, shown: r.shown + 1 } : r))), 520);
    return () => clearTimeout(t);
  }, [behind, rows]);

  const nothing = rows != null && rows.length === 0 && !clients.isLoading && !hasClients;
  const finished = rows != null && (rows.length > 0 || hasClients) && rows.every(done) && clientsDone;
  const close = () => {
    for (const k of SALES_KEYS) qc.invalidateQueries({ queryKey: [k] });
    onClose();
  };
  // Al terminar se refresca Ventas aunque no se cierre todavía
  useEffect(() => {
    if (finished) for (const k of SALES_KEYS) qc.invalidateQueries({ queryKey: [k] });
  }, [finished, qc]);

  return (
    <Modal
      wide
      title={finished ? 'Ventas actualizadas' : 'Actualizando ventas'}
      intro={
        <>
          Del {dmy(range.from)} al {dmy(range.to)}
          {rows && rows.length > 0 && !finished && ' · puedes cerrar esta ventana, sigue en segundo plano'}
        </>
      }
      onClose={close}
      footer={
        finished || nothing ? (
          <Button onClick={close}>
            {nothing ? 'Cerrar' : 'Ver ventas'} <ArrowRight className="size-4" />
          </Button>
        ) : (
          <Button variant="secondary" onClick={close}>
            Seguir en segundo plano
          </Button>
        )
      }
    >
      {conns.isLoading || clients.isLoading || !rows ? (
        <Loading label="Revisando tus conexiones…" />
      ) : nothing ? (
        <div className="flex flex-col items-center py-6 text-center">
          <div className="grid size-11 place-items-center rounded-full bg-paper text-muted">
            <Plug className="size-5" />
          </div>
          <p className="mt-3 font-medium">No tienes retailers conectados por API</p>
          <p className="mt-1 max-w-sm text-sm text-muted">Conecta Falabella, Paris, Walmart, Ripley o Mercado Libre para traer las ventas con un clic. Mientras, puedes subirlas en Excel.</p>
          <Link href="/configuracion?tab=conexiones" onClick={onClose} className="mt-4 text-sm font-medium text-brand-700 hover:underline">
            Ir a Conexiones
          </Link>
        </div>
      ) : (
        <>
          {finished && <Summary rows={rows} />}
          <ul className="grid gap-px overflow-hidden rounded-xl border border-line bg-line">
            {rows.map((r, i) => (
              <RetailerRow key={r.c.provider} row={r} index={i} />
            ))}
            {hasClients && (
              <ClientsRow
                names={clients.data!.map((c) => c.name)}
                index={rows.length}
                state={refresh.isError ? 'error' : refresh.isSuccess ? 'ok' : 'run'}
                result={refresh.data?.clients}
                error={refresh.error instanceof Error ? refresh.error.message : null}
              />
            )}
          </ul>
        </>
      )}
    </Modal>
  );
}

/** Un retailer: los pasos, el mensaje en vivo y, al final, lo que trajo */
function RetailerRow({ row, index }: { row: Row; index: number }) {
  const { c, job } = row;
  const isDone = done(row);
  const isError = failed(row);
  const at = row.shown;
  const steps = stepsOf(c.provider);
  const stage = orderOf(c.provider)[at];
  // Mientras se ponen al día los pasos, el texto acompaña al paso que se ve
  const caughtUp = at >= target(row);
  const message =
    row.error ??
    (isError
      ? job!.message
      : isDone
        ? (job?.message.replace(/^[^:]*:\s*/, '') ?? '')
        : caughtUp && job
          ? job.message
          : STAGE_TEXT[stage](c.label));
  // Mientras busca, el número de órdenes leídas viene en el mensaje ("Falabella: 23 órdenes leídas…")
  const live = !isDone && stage === 'BUSCANDO' ? Number(message.match(/(\d[\d.]*)\s*órdenes?/)?.[1]?.replace(/\./g, '')) || null : null;
  const r = isDone ? job?.result : undefined;
  return (
    <li className="anim-rise bg-white px-4 py-3.5" style={{ animationDelay: `${index * 80}ms` }}>
      <div className="flex items-center gap-3">
        <StatusDot state={isError ? 'error' : isDone ? 'ok' : 'run'} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <p className="font-medium">{c.label}</p>
            {r && !isError && (
              <span className="anim-rise text-xs text-muted">
                {r.orders === 0 ? 'Sin órdenes en el periodo' : `${r.orders} ${r.orders === 1 ? 'orden' : 'órdenes'} · ${clp(r.amount)}`}
              </span>
            )}
          </div>
          <p className={cn('mt-0.5 truncate text-[0.8125rem]', isError ? 'text-berry-700' : isDone ? 'text-muted' : 'text-ink')} title={message}>
            {message}
          </p>
        </div>
        {live != null && (
          <span key={live} className="anim-pop figure shrink-0 text-lg font-semibold text-brand-700">
            {live}
          </span>
        )}
        {r?.receipts && r.receipts.missing > 0 && (
          <Pill tone="ambar" className="anim-pop shrink-0">
            {r.receipts.missing} sin boleta en {c.label}
          </Pill>
        )}
        {r && !isError && r.newOrders > 0 && (
          <Pill tone="azul" className="anim-pop shrink-0">
            +{r.newOrders} nuevas
          </Pill>
        )}
      </div>

      {/* Pasos */}
      {!isError && !isDone && (
        <div className="mt-3 flex items-center gap-1.5 pl-9">
          {steps.map((s, i) => {
            const state = isDone || at > i ? 'done' : at === i ? 'now' : 'next';
            return (
              <div key={s.stage} className="min-w-0 flex-1">
                <div className="relative h-1 overflow-hidden rounded-full bg-stone-200">
                  <div className={cn('absolute inset-0 rounded-full bg-brand-600 transition-transform duration-500 ease-out', state === 'done' ? 'translate-x-0' : '-translate-x-full')} />
                  {state === 'now' && <div className="anim-sweep absolute inset-y-0 left-0 w-2/5 rounded-full bg-brand-500/70" />}
                </div>
                <p className={cn('mt-1 truncate text-[0.6875rem]', state === 'next' ? 'text-muted/70' : state === 'now' ? 'font-medium text-ink' : 'text-muted')}>{s.label}</p>
              </div>
            );
          })}
        </div>
      )}
    </li>
  );
}

/** Ventas recibidas de clientes de Cuadra: se actualizan las que ya llegaron (no se traen nuevas) */
function ClientsRow({
  names,
  index,
  state,
  result,
  error,
}: {
  names: string[];
  index: number;
  state: 'run' | 'ok' | 'error';
  result?: { client: string; lines: number; updated: number; cancelled: number; missing: number }[];
  error: string | null;
}) {
  return (
    <li className="anim-rise bg-white px-4 py-3.5" style={{ animationDelay: `${index * 80}ms` }}>
      <div className="flex items-center gap-3">
        <StatusDot state={state} />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {names.join(', ')} <span className="text-xs font-normal text-muted">· clientes de Cuadra</span>
          </p>
          {state === 'run' ? (
            <p className="mt-0.5 text-[0.8125rem] text-ink">Actualizando las ventas que te enviaron…</p>
          ) : state === 'error' ? (
            <p className="mt-0.5 text-[0.8125rem] text-berry-700">{error}</p>
          ) : (
            (result ?? []).map((r) => (
              <p key={r.client} className="mt-0.5 text-[0.8125rem] text-muted">
                {r.client}: {r.lines} {r.lines === 1 ? 'venta revisada' : 'ventas revisadas'}
                {r.updated > 0 ? ` · ${r.updated} con cambios` : ' · sin cambios'}
                {r.cancelled > 0 && <span className="text-berry-700"> · {r.cancelled} cancelada{r.cancelled === 1 ? '' : 's'} por el cliente</span>}
                {r.missing > 0 && ` · ${r.missing} ya no están en su cuenta`}
              </p>
            ))
          )}
        </div>
      </div>
    </li>
  );
}

function StatusDot({ state }: { state: 'run' | 'ok' | 'error' }) {
  if (state === 'ok')
    return (
      <span className="anim-pop grid size-6 shrink-0 place-items-center rounded-full bg-money-600 text-white">
        <Check className="size-3.5" strokeWidth={3} />
      </span>
    );
  if (state === 'error')
    return (
      <span className="anim-pop grid size-6 shrink-0 place-items-center rounded-full bg-berry-50 text-berry-600">
        <AlertTriangle className="size-3.5" />
      </span>
    );
  return (
    <span className="relative grid size-6 shrink-0 place-items-center">
      <span className="anim-ping absolute size-3 rounded-full bg-brand-500" />
      <RefreshCw className="relative size-4 animate-spin text-brand-600 [animation-duration:1.6s]" />
    </span>
  );
}

/** Resumen de todo lo que llegó */
function Summary({ rows }: { rows: Row[] }) {
  const results = rows.map((r) => r.job?.result).filter((r) => r != null);
  const sum = (k: 'orders' | 'newOrders' | 'inSales' | 'fromFile' | 'settled' | 'amount' | 'cancelled') => results.reduce((a, r) => a + r[k], 0);
  const errors = rows.filter(failed).length;
  const byState: Partial<Record<OrderState, number>> = {};
  for (const r of results) for (const [k, n] of Object.entries(r.byState)) byState[k as OrderState] = (byState[k as OrderState] ?? 0) + n;
  const fromFile = sum('fromFile');
  const cancelled = sum('cancelled');
  // Boletas revisadas en los retailers que lo permiten
  const checked = rows.filter((r) => r.job?.result?.receipts?.checked);
  const missing = checked.filter((r) => r.job!.result!.receipts!.missing > 0);
  return (
    <div className="anim-rise space-y-3">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
        <Figure label="Órdenes traídas" value={sum('orders')} />
        <Figure label="Nuevas" value={sum('newOrders')} accent />
        <Figure label="Monto vendido" value={sum('amount')} money />
        <Figure label="Movimientos de liquidación" value={sum('settled')} />
      </div>
      {Object.keys(byState).length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {(Object.entries(byState) as [OrderState, number][])
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => (
              <Pill key={k} tone={ORDER_STATE_INFO[k].tone}>
                {n} {ORDER_STATE_INFO[k].label.toLowerCase()}
              </Pill>
            ))}
        </div>
      )}
      <p className="text-[0.8125rem] text-muted">
        {sum('inSales')} quedaron en Ventas
        {fromFile > 0 && ` · ${fromFile} ya las tenías cargadas desde Excel`}
        {cancelled > 0 && ` · las ${cancelled} canceladas no suman al monto`}
        {errors > 0 && <span className="text-berry-700"> · {errors === 1 ? '1 retailer no respondió' : `${errors} retailers no respondieron`}, revisa el detalle abajo</span>}
      </p>
      {checked.length > 0 && (
        <div className={cn('rounded-xl border px-4 py-3 text-[0.8125rem]', missing.length ? 'border-sun-100 bg-sun-50' : 'border-money-100 bg-money-50')}>
          <p className="font-medium text-ink">Boletas en los retailers</p>
          <ul className="mt-1 space-y-0.5">
            {checked.map((r) => {
              const rc = r.job!.result!.receipts!;
              return (
                <li key={r.c.provider} className="text-muted">
                  <span className="text-ink">{r.c.label}:</span>{' '}
                  {rc.inRetail > 0 && <span className="text-money-700">{rc.inRetail} ya {rc.inRetail === 1 ? 'la tiene' : 'las tiene'}</span>}
                  {rc.inRetail > 0 && rc.missing > 0 && ' · '}
                  {rc.missing > 0 && (
                    <span className="font-medium text-sun-700">
                      {rc.missing} {rc.missing === 1 ? 'boleta que aún no tiene' : 'boletas que aún no tiene'}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {missing.length > 0 && <p className="mt-1.5 text-xs text-muted">Las verás en Ventas con el filtro "Falta en retail".</p>}
        </div>
      )}
    </div>
  );
}

/** Número que sube desde 0 hasta su valor */
function Figure({ label, value, money, accent }: { label: string; value: number; money?: boolean; accent?: boolean }) {
  const shown = useCountUp(value);
  return (
    <div className="bg-white px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={cn('figure mt-1 text-xl font-semibold', accent && value > 0 && 'text-brand-700', money && 'text-money-700')}>{money ? clp(shown) : shown.toLocaleString('es-CL')}</p>
    </div>
  );
}

function useCountUp(target: number, ms = 900) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setV(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setV(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}
