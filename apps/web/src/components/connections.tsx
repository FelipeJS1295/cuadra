'use client';

import { paymentTermsLabel } from '@cuadra/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, FileSpreadsheet, Landmark, Loader2, PlugZap, RefreshCw, Settings2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSession } from '@/components/session';
import { Button, Card, ErrorBox, Field, Help, inputCls, Loading, Modal, Pill, shortDate, todayCL } from '@/components/ui';
import { api, type PaymentRule, type RetailApiConnection, type RetailerMaster, type RetailSyncJob } from '@/lib/api';
import { cn } from '@/lib/cn';

/** Retailers y conexión con el SII (vive en Configuración → Conexiones) */
export function ConnectionsPanel() {
  const retailers = useQuery({ queryKey: ['retailers'], queryFn: api.listRetailers });
  const conns = useQuery({ queryKey: ['retail-connections'], queryFn: api.retailConnections });
  const sii = useQuery({ queryKey: ['sii-status'], queryFn: api.siiStatus });
  const [edit, setEdit] = useState<RetailerMaster | null>(null);
  const [connect, setConnect] = useState<RetailApiConnection | null>(null);

  return (
    <div>
      <div className="mb-5 max-w-2xl">
        <p className="text-muted">Con qué retailers vendes, cuánto te cobran, cuándo te pagan y cómo llegan tus ventas a Cuadra.</p>
        <Help>
          <p>
            <b>Por archivo</b>: descargas el reporte del portal del retailer y lo subes en Ventas o Cobros.
          </p>
          <p>
            <b>Por API</b>: Cuadra se conecta directo con el retailer y trae tus ventas solo. Necesitas las claves de API que te da cada retailer.
          </p>
          <p>La comisión y la forma de pago sirven para calcular cuánto te deben y cuándo.</p>
        </Help>
      </div>
      <Card className="mb-6 flex flex-wrap items-center gap-4 p-5">
        <span className={cn('grid size-11 place-items-center rounded-full', sii.data?.enabled ? 'bg-money-50 text-money-600' : 'bg-sun-50 text-sun-700')}>
          <Landmark className="size-5" />
        </span>
        <div className="min-w-48 flex-1">
          <p className="font-semibold">SII (boletas, facturas, notas de crédito y compras)</p>
          <p className="text-sm text-muted">
            {sii.data?.enabled
              ? `Conectado con ${sii.data.providerName}: ${[
                  sii.data.can.boletas && 'emites boletas',
                  sii.data.can.facturas && (sii.data.can.facturasDirectas ? 'facturas' : 'borradores de factura'),
                  sii.data.can.notasCredito && 'notas de crédito',
                  sii.data.can.compras && 'traes facturas de proveedores',
                  sii.data.can.cuadratura && 'comparas tus ventas con el SII',
                ]
                  .filter(Boolean)
                  .join(', ')
                  .replace(/, ([^,]*)$/, ' y $1')}.`
              : 'Sin conectar: elige API Gateway, SimpleAPI o Nubox. Mientras, las boletas las anotas a mano.'}
          </p>
        </div>
        <Link href="/configuracion?tab=sii" className="rounded-xl border border-line px-4 py-2 text-sm font-medium hover:bg-stone-50">
          {sii.data?.enabled ? 'Ver conexión' : 'Conectar el SII'}
        </Link>
      </Card>

      <h2 className="mb-3 text-base font-semibold">Tus retailers</h2>
      {retailers.isLoading && <Loading />}
      <div className="grid gap-4 md:grid-cols-2">
        {retailers.data?.map((r) => {
          const c = conns.data?.find((x) => x.provider === r.code);
          const apiOn = c?.status === 'OK';
          return (
            <Card key={r.id} className={cn('p-5', !r.isActive && 'opacity-60')}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-lg font-semibold">{r.name}</p>
                  <p className="text-sm text-muted">
                    Comisión {r.commissionPct ? `${r.commissionPct}%` : <span className="text-sun-700">sin definir</span>} ·{' '}
                    {paymentTermsLabel({ rule: r.paymentRule, days: r.paymentDays, weekday: r.paymentWeekday, base: r.paymentBase === 'DESPACHO' ? 'DESPACHO' : 'ORDEN' })}
                  </p>
                </div>
                <button onClick={() => setEdit(r)} className="rounded-xl p-2 text-muted hover:bg-stone-100" title="Editar condiciones">
                  <Settings2 className="size-5" />
                </button>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {apiOn ? (
                  <Pill tone="verde">
                    <PlugZap className="size-3.5" /> Conectado por API
                  </Pill>
                ) : (
                  <Pill>
                    <FileSpreadsheet className="size-3.5" /> Por archivo
                  </Pill>
                )}
                {r.orders > 0 && <span className="text-xs text-muted">{r.orders} ventas cargadas</span>}
                {c && (
                  <Button size="sm" variant={apiOn ? 'ghost' : 'secondary'} className="ml-auto" onClick={() => setConnect(c)}>
                    {apiOn ? 'Ver conexión' : 'Conectar por API'}
                  </Button>
                )}
              </div>
              {c && apiOn && <SyncNow c={c} />}
            </Card>
          );
        })}
      </div>
      {edit && <RetailerTerms r={edit} onClose={() => setEdit(null)} />}
      {connect && <ApiConnect c={connect} onClose={() => setConnect(null)} />}
    </div>
  );
}

function RetailerTerms({ r, onClose }: { r: RetailerMaster; onClose: () => void }) {
  const qc = useQueryClient();
  const { isAdmin } = useSession();
  const [f, setF] = useState({
    commissionPct: String(r.commissionPct ?? ''),
    paymentRule: r.paymentRule,
    paymentDays: String(r.paymentDays),
    paymentWeekday: r.paymentWeekday,
    paymentBase: r.paymentBase,
    taxId: r.taxId ?? '',
    isActive: r.isActive,
  });
  const save = useMutation({
    mutationFn: () =>
      api.updateRetailer(r.id, {
        commissionPct: f.commissionPct || '0',
        paymentRule: f.paymentRule,
        paymentDays: Number(f.paymentDays) || 0,
        paymentWeekday: f.paymentWeekday,
        paymentBase: f.paymentBase,
        taxId: f.taxId || null,
        isActive: f.isActive,
      }),
    onSuccess: () => {
      for (const k of ['retailers', 'receivables', 'home']) qc.invalidateQueries({ queryKey: [k] });
      onClose();
    },
  });
  return (
    <Modal
      title={`Condiciones con ${r.name}`}
      onClose={onClose}
      footer={
        isAdmin && (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button onClick={() => save.mutate()} loading={save.isPending}>
              Guardar
            </Button>
          </>
        )
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Comisión que te cobra (%)">
          <input value={f.commissionPct} onChange={(e) => setF({ ...f, commissionPct: e.target.value })} disabled={!isAdmin} className={inputCls} />
        </Field>
        <Field label="Cómo te paga">
          <select value={f.paymentRule} onChange={(e) => setF({ ...f, paymentRule: e.target.value as PaymentRule })} disabled={!isAdmin} className={inputCls}>
            <option value="QUINCENAL">Quincenal: cierra el 14 y fin de mes</option>
            <option value="HABILES_ENTREGA">Días hábiles después de la entrega</option>
            <option value="SEMANAL">Una vez por semana</option>
            <option value="DIAS">A días corridos</option>
          </select>
        </Field>
        {f.paymentRule === 'SEMANAL' ? (
          <Field label="Día en que paga" hint="Paga lo entregado al cliente la semana anterior">
            <select value={f.paymentWeekday} onChange={(e) => setF({ ...f, paymentWeekday: Number(e.target.value) })} disabled={!isAdmin} className={inputCls}>
              {['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'].map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field
            label={f.paymentRule === 'DIAS' ? 'Días corridos' : 'Días hábiles'}
            hint={
              f.paymentRule === 'QUINCENAL'
                ? 'Después del cierre de cada quincena'
                : f.paymentRule === 'HABILES_ENTREGA'
                  ? 'Después de que el cliente recibe el producto'
                  : undefined
            }
          >
            <input value={f.paymentDays} onChange={(e) => setF({ ...f, paymentDays: e.target.value })} disabled={!isAdmin} className={inputCls} />
          </Field>
        )}
        {f.paymentRule === 'DIAS' && (
          <Field label="Los días se cuentan desde">
            <select value={f.paymentBase} onChange={(e) => setF({ ...f, paymentBase: e.target.value as 'ORDEN' | 'DESPACHO' })} disabled={!isAdmin} className={inputCls}>
              <option value="ORDEN">La fecha de la venta</option>
              <option value="DESPACHO">La fecha de despacho</option>
            </select>
          </Field>
        )}
        <Field label="RUT del retailer" hint="Para reconocer sus facturas de comisión en el SII">
          <input value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value })} disabled={!isAdmin} className={inputCls} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} disabled={!isAdmin} className="size-4 accent-brand-600" />
        Vendo en este retailer
      </label>
      <ErrorBox error={save.error} />
    </Modal>
  );
}

/** Lo que hay que refrescar cuando llegan ventas nuevas */
const SALES_KEYS = ['retail-connections', 'retail-orders', 'retailers', 'sales', 'receivables', 'home', 'vat'];

/** Desde el 20 del mes pasado hasta hoy (igual que Ventas) */
function defaultRange() {
  const to = todayCL();
  const [y, m] = to.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 20));
  return { from: prev.toISOString().slice(0, 10), to };
}

/** Retailer conectado por API: cuándo se trajeron las ventas y botón para traerlas de nuevo */
function SyncNow({ c }: { c: RetailApiConnection }) {
  const qc = useQueryClient();
  const { canEdit } = useSession();
  const [job, setJob] = useState<RetailSyncJob | null>(null);
  const start = useMutation({
    mutationFn: () => {
      const { from, to } = defaultRange();
      return api.syncRetailOrders(c.provider, from, to);
    },
    onSuccess: setJob,
  });
  useEffect(() => {
    if (!job || job.status !== 'RUNNING') return;
    const t = setTimeout(async () => {
      const next = await api.retailJob(job.id).catch(() => ({ ...job, status: 'ERROR' as const, message: 'Se perdió el avance' }));
      setJob(next);
      if (next.status !== 'RUNNING') for (const k of SALES_KEYS) qc.invalidateQueries({ queryKey: [k] });
    }, 1500);
    return () => clearTimeout(t);
  }, [job, qc]);
  const running = start.isPending || job?.status === 'RUNNING';
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs text-muted">
      {running ? (
        <span className="flex items-center gap-1.5 text-ink">
          <Loader2 className="size-3.5 animate-spin" /> {job?.message ?? 'Conectando…'}
        </span>
      ) : job ? (
        <span className={job.status === 'ERROR' ? 'text-berry-700' : 'text-money-700'}>{job.message}</span>
      ) : (
        <span>{c.lastOrdersSyncAt ? `Ventas traídas el ${shortDate(c.lastOrdersSyncAt)}` : 'Aún no se traen ventas'}</span>
      )}
      <span className="ml-auto flex items-center gap-3">
        <Link href={`/ventas?retailer=${c.provider}`} className="font-medium text-brand-700 hover:underline">
          Ver ventas
        </Link>
        {canEdit && (
          <button onClick={() => start.mutate()} disabled={running} className="inline-flex items-center gap-1 font-medium text-ink hover:underline disabled:opacity-50">
            <RefreshCw className={cn('size-3.5', running && 'animate-spin')} /> Traer ahora
          </button>
        )}
      </span>
      <ErrorBox error={start.error} />
    </div>
  );
}

function ApiConnect({ c, onClose }: { c: RetailApiConnection; onClose: () => void }) {
  const qc = useQueryClient();
  const { isAdmin } = useSession();
  const [settings, setSettings] = useState(c.settings);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [job, setJob] = useState<RetailSyncJob | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      await api.saveRetailConnection(c.provider, { enabled: true, settings, secrets });
      return api.testRetailConnection(c.provider);
    },
    onSuccess: (r) => {
      setJob(r.job ?? null);
      qc.invalidateQueries({ queryKey: ['retail-connections'] });
    },
  });
  useEffect(() => {
    if (!job || job.status !== 'RUNNING') return;
    const t = setTimeout(async () => {
      const next = await api.retailJob(job.id).catch(() => ({ ...job, status: 'ERROR' as const, message: 'Se perdió el avance' }));
      setJob(next);
      if (next.status !== 'RUNNING') for (const k of SALES_KEYS) qc.invalidateQueries({ queryKey: [k] });
    }, 1500);
    return () => clearTimeout(t);
  }, [job, qc]);
  const disconnect = useMutation({
    mutationFn: () => api.disconnectRetail(c.provider),
    onSuccess: () => {
      for (const k of SALES_KEYS) qc.invalidateQueries({ queryKey: [k] });
    },
  });
  // Campos avanzados (URL, rutas) escondidos para no confundir
  const basic = c.fields.filter((f) => !/url|path/i.test(f.key));
  return (
    <Modal wide title={`Conectar ${c.label} por API`} intro={c.howTo} onClose={onClose}>
      <div className="grid gap-4 sm:grid-cols-2">
        {basic.map((f) => (
          <Field key={f.key} label={f.label} hint={f.secret && c.secrets[f.key] ? `Guardada (${c.secrets[f.key]})` : f.help}>
            {f.secret ? (
              <input type="password" autoComplete="new-password" value={secrets[f.key] ?? ''} onChange={(e) => setSecrets((x) => ({ ...x, [f.key]: e.target.value }))} disabled={!isAdmin} className={inputCls} />
            ) : (
              <input value={settings[f.key] ?? ''} onChange={(e) => setSettings((x) => ({ ...x, [f.key]: e.target.value }))} placeholder={f.placeholder} disabled={!isAdmin} className={inputCls} />
            )}
          </Field>
        ))}
      </div>
      {c.provider === 'MERCADOLIBRE' && (
        <p className="text-sm">
          {settings.clientId && settings.redirectUri ? (
            <a
              href={`https://auth.mercadolibre.cl/authorization?response_type=code&client_id=${encodeURIComponent(settings.clientId)}&redirect_uri=${encodeURIComponent(settings.redirectUri)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline"
            >
              Autorizar en Mercado Libre <ArrowRight className="size-4" />
            </a>
          ) : (
            <span className="text-muted">Escribe el App ID y la URL de redirección para ver el enlace de autorización.</span>
          )}
        </p>
      )}
      {isAdmin && (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            <PlugZap className="size-4" /> Conectar y traer ventas
          </Button>
          {(c.enabled || c.status === 'OK') && !disconnect.isSuccess && (
            <Button
              variant="ghost"
              className="ml-auto text-berry-700 hover:bg-berry-50"
              loading={disconnect.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    `¿Desconectar ${c.label} por API? Las ventas que llegaron por API se quitan de Ventas (menos las que ya tienen boleta o factura). Después subes el reporte de ventas por archivo.`,
                  )
                )
                  disconnect.mutate();
              }}
            >
              Desconectar y usar archivo
            </Button>
          )}
        </div>
      )}
      {disconnect.data && (
        <p className="rounded-xl bg-money-50 p-3 text-sm text-money-700">
          {c.label} quedó por archivo. Se quitaron {disconnect.data.removed} {disconnect.data.removed === 1 ? 'línea' : 'líneas'} de venta que llegaron por API
          {disconnect.data.kept ? ` (se dejaron ${disconnect.data.kept} órdenes que ya tienen boleta o factura)` : ''}. Ahora sube el reporte de ventas en Ventas → Subir ventas.
        </p>
      )}
      <ErrorBox error={disconnect.error} />
      <ErrorBox error={save.error} />
      {save.data && (
        <div className={cn('space-y-1 rounded-xl p-4 text-sm', save.data.ok ? 'bg-money-50 text-money-700' : 'bg-berry-50 text-berry-700')}>
          <p className="flex items-center gap-2 font-medium">
            {save.data.ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />} {save.data.message}
          </p>
          {job && (
            <p className="flex items-center gap-2 text-ink">
              {job.status === 'RUNNING' && <Loader2 className="size-4 animate-spin" />} {job.message}
            </p>
          )}
          {job?.status === 'DONE' && job.count > 0 && (
            <Link href={`/ventas?retailer=${c.provider}`} className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">
              Ver las ventas <ArrowRight className="size-4" />
            </Link>
          )}
        </div>
      )}
    </Modal>
  );
}
