'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, FileSpreadsheet, Landmark, Loader2, PlugZap, RefreshCw, Settings2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSession } from '@/components/session';
import { Button, Card, ErrorBox, Field, inputCls, Loading, Modal, Page, Pill, shortDate, todayCL } from '@/components/ui';
import { api, type RetailApiConnection, type RetailerMaster, type RetailSyncJob } from '@/lib/api';
import { cn } from '@/lib/cn';

export default function ConnectionsPage() {
  const retailers = useQuery({ queryKey: ['retailers'], queryFn: api.listRetailers });
  const conns = useQuery({ queryKey: ['retail-connections'], queryFn: api.retailConnections });
  const sii = useQuery({ queryKey: ['sii-status'], queryFn: api.siiStatus });
  const [edit, setEdit] = useState<RetailerMaster | null>(null);
  const [connect, setConnect] = useState<RetailApiConnection | null>(null);

  return (
    <Page
      title="Conexiones"
      intro="Con qué retailers vendes, cuánto te cobran y cómo llegan tus ventas a Cuadra."
      help={
        <>
          <p>
            <b>Por archivo</b>: descargas el reporte del portal del retailer y lo subes en Ventas o Cobros.
          </p>
          <p>
            <b>Por API</b>: Cuadra se conecta directo con el retailer y trae tus ventas solo. Necesitas las claves de API que te da cada retailer.
          </p>
          <p>La comisión y los días de pago sirven para calcular cuánto te deben y cuándo.</p>
        </>
      }
    >
      <Card className="mb-6 flex flex-wrap items-center gap-4 p-5">
        <span className={cn('grid size-11 place-items-center rounded-full', sii.data?.enabled ? 'bg-brand-50 text-brand-600' : 'bg-sun-50 text-sun-700')}>
          <Landmark className="size-5" />
        </span>
        <div className="min-w-48 flex-1">
          <p className="font-semibold">SII (boletas, notas de crédito y compras)</p>
          <p className="text-sm text-muted">
            {sii.data?.enabled
              ? `Conectado con ${sii.data.providerName}: ${[
                  sii.data.can.boletas && 'emites boletas',
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

      <h2 className="mb-3 text-lg font-semibold">Tus retailers</h2>
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
                    Comisión {r.commissionPct ? `${r.commissionPct}%` : <span className="text-sun-700">sin definir</span>} · paga a {r.paymentDays} días
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
    </Page>
  );
}

function RetailerTerms({ r, onClose }: { r: RetailerMaster; onClose: () => void }) {
  const qc = useQueryClient();
  const { isAdmin } = useSession();
  const [f, setF] = useState({ commissionPct: String(r.commissionPct ?? ''), paymentDays: String(r.paymentDays), paymentBase: r.paymentBase, taxId: r.taxId ?? '', isActive: r.isActive });
  const save = useMutation({
    mutationFn: () => api.updateRetailer(r.id, { commissionPct: f.commissionPct || '0', paymentDays: Number(f.paymentDays) || 0, paymentBase: f.paymentBase, taxId: f.taxId || null, isActive: f.isActive }),
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
        <Field label="Días en que te paga">
          <input value={f.paymentDays} onChange={(e) => setF({ ...f, paymentDays: e.target.value })} disabled={!isAdmin} className={inputCls} />
        </Field>
        <Field label="Los días se cuentan desde">
          <select value={f.paymentBase} onChange={(e) => setF({ ...f, paymentBase: e.target.value as 'ORDEN' | 'DESPACHO' })} disabled={!isAdmin} className={inputCls}>
            <option value="ORDEN">La fecha de la venta</option>
            <option value="DESPACHO">La fecha de despacho</option>
          </select>
        </Field>
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
        <span className={job.status === 'ERROR' ? 'text-berry-700' : 'text-brand-700'}>{job.message}</span>
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
      {isAdmin && (
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          <PlugZap className="size-4" /> Conectar y traer ventas
        </Button>
      )}
      <ErrorBox error={save.error} />
      {save.data && (
        <div className={cn('space-y-1 rounded-xl p-4 text-sm', save.data.ok ? 'bg-brand-50 text-brand-700' : 'bg-berry-50 text-berry-700')}>
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
