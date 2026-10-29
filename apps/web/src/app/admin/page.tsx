'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Copy, KeyRound, LogIn, MousePointerClick, PanelsTopLeft, ShieldAlert, Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSession } from '@/components/session';
import { Button, Card, dmy, Empty, ErrorBox, Field, inputCls, Loading, Modal, Page, Pill, Tabs, td, th } from '@/components/ui';
import { api, type ActivityEvent, type ActivityFilters, type ActivityKind, type AdminUser } from '@/lib/api';
import { cn } from '@/lib/cn';

type Tab = 'empresas' | 'usuarios' | 'actividad';

const ROLE: Record<string, string> = { DUENO: 'Dueño', ADMIN: 'Admin', OPERADOR: 'Operador', LECTURA: 'Lectura' };

const KIND: Record<ActivityKind, { label: string; icon: typeof LogIn; tone: string }> = {
  LOGIN: { label: 'Ingreso', icon: LogIn, tone: 'bg-money-50 text-money-700' },
  LOGIN_FALLIDO: { label: 'Ingreso fallido', icon: ShieldAlert, tone: 'bg-berry-50 text-berry-700' },
  PAGINA: { label: 'Página', icon: PanelsTopLeft, tone: 'bg-[#eef1f5] text-muted' },
  ACCION: { label: 'Acción', icon: MousePointerClick, tone: 'bg-brand-50 text-brand-700' },
};

/** Fecha que viene de Postgres ("2026-10-29 13:21:01.9+00") o ISO */
const parse = (iso: string) => new Date(iso.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));

/** Fecha y hora de Chile: "29/10/2026 10:21" */
const when = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('es-CL', {
        timeZone: 'America/Santiago',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(parse(iso))
    : '—';
const hour = (iso: string) => new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit' }).format(parse(iso));
const dayOf = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(parse(iso));
const longDay = (d: string) =>
  new Intl.DateTimeFormat('es-CL', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${d}T12:00:00Z`));

/** "hace 5 min", "hace 3 días" */
function ago(iso: string | null) {
  if (!iso) return 'nunca';
  const min = Math.round((Date.now() - parse(iso).getTime()) / 60000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ayer' : `hace ${d} días`;
}

export default function AdminPage() {
  const { user } = useSession();
  const [tab, setTab] = useState<Tab>('usuarios');
  const [filters, setFilters] = useState<ActivityFilters>({ days: 30 });
  if (!user.isSuperadmin) return <Page title="Sin acceso">Solo para el administrador del sistema.</Page>;

  const showActivity = (f: ActivityFilters) => {
    setFilters({ days: 30, ...f });
    setTab('actividad');
  };

  return (
    <Page title="Administración" intro="Empresas, usuarios y lo que hacen en Cuadra." wide>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'usuarios', label: 'Usuarios' },
          { id: 'actividad', label: 'Actividad' },
          { id: 'empresas', label: 'Empresas' },
        ]}
      />
      <div className="mt-5">
        {tab === 'empresas' && <Companies onActivity={(tenantId) => showActivity({ tenantId })} />}
        {tab === 'usuarios' && <Users onActivity={(f) => showActivity(f)} />}
        {tab === 'actividad' && <Activity filters={filters} setFilters={setFilters} />}
      </div>
    </Page>
  );
}

// ------------------------------------------------------------------ Usuarios

function Users({ onActivity }: { onActivity: (f: ActivityFilters) => void }) {
  const tenants = useQuery({ queryKey: ['admin-tenants'], queryFn: api.adminTenants });
  const [tenantId, setTenantId] = useState('');
  const [search, setSearch] = useState('');
  const users = useQuery({ queryKey: ['admin-users', tenantId], queryFn: () => api.adminUsers(tenantId || undefined) });
  const [pwd, setPwd] = useState<AdminUser | null>(null);
  const rows = (users.data ?? []).filter((u) => !search.trim() || `${u.name} ${u.email}`.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} className={cn(inputCls, 'w-64')} aria-label="Empresa">
          <option value="">Todas las empresas</option>
          {(tenants.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar nombre o correo" className={cn(inputCls, 'w-64')} />
        <span className="text-xs text-muted">Números de los últimos 30 días{tenantId ? ' (acciones y páginas en esta empresa)' : ''}</span>
      </div>
      <ErrorBox error={users.error} />
      <Card className="overflow-x-auto">
        {users.isLoading ? (
          <Loading />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-line">
              <tr>
                <th className={th}>Usuario</th>
                <th className={th}>Empresas</th>
                <th className={th}>Último ingreso</th>
                <th className={cn(th, 'text-right')}>Ingresos</th>
                <th className={cn(th, 'text-right')}>Días activo</th>
                <th className={cn(th, 'text-right')}>Páginas</th>
                <th className={cn(th, 'text-right')}>Acciones</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((u) => (
                <tr key={u.id} className={cn(!u.isActive && 'opacity-60')}>
                  <td className={td}>
                    <p className="font-medium">
                      {u.name}
                      {u.isSuperadmin && (
                        <Pill tone="azul" className="ml-1.5">
                          Admin sistema
                        </Pill>
                      )}
                      {!u.isActive && (
                        <Pill tone="gris" className="ml-1.5">
                          Desactivado
                        </Pill>
                      )}
                    </p>
                    <p className="text-xs text-muted">{u.email}</p>
                    {u.mustChangePassword && <p className="text-xs text-sun-700">Debe cambiar su clave al entrar</p>}
                  </td>
                  <td className={td}>
                    {u.companies.length ? (
                      <div className="flex flex-col gap-0.5">
                        {u.companies.map((c) => (
                          <span key={c.id} className="text-xs whitespace-nowrap">
                            {c.name} <span className="text-muted">· {ROLE[c.role] ?? c.role}</span>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-muted">Sin empresa</span>
                    )}
                  </td>
                  <td className={td}>
                    <p className="whitespace-nowrap">{ago(u.lastSeen ?? u.lastLoginAt)}</p>
                    <p className="text-xs whitespace-nowrap text-muted">{when(u.lastLoginAt)}</p>
                  </td>
                  <td className={cn(td, 'figure text-right')}>
                    {u.logins30}
                    {u.failed30 > 0 && (
                      <p className="text-xs text-berry-700" title="Intentos con clave equivocada">
                        {u.failed30} fallidos
                      </p>
                    )}
                  </td>
                  <td className={cn(td, 'figure text-right')}>{u.days30}</td>
                  <td className={cn(td, 'figure text-right')}>{u.pages30}</td>
                  <td className={cn(td, 'figure text-right')}>{u.actions30}</td>
                  <td className={cn(td, 'text-right whitespace-nowrap')}>
                    <Button size="sm" variant="ghost" onClick={() => onActivity({ userId: u.id, tenantId: tenantId || undefined })}>
                      Ver actividad
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setPwd(u)}>
                      <KeyRound className="size-4" /> Cambiar clave
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {users.data && !rows.length && <p className="px-4 py-6 text-center text-sm text-muted">No hay usuarios con ese filtro.</p>}
      </Card>
      {pwd && <PasswordDialog user={pwd} onClose={() => setPwd(null)} />}
    </div>
  );
}

/** Clave fácil de dictar: 3 letras, 4 números y 3 letras (sin letras que se confunden) */
function newPassword() {
  const L = 'abcdefghjkmnpqrstuvwxyz';
  const pick = (s: string, n: number) => Array.from(crypto.getRandomValues(new Uint32Array(n)), (x) => s[x % s.length]).join('');
  return `${pick(L, 3).replace(/^./, (c) => c.toUpperCase())}${pick('23456789', 4)}${pick(L, 3)}`;
}

function PasswordDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState(newPassword);
  const [mustChange, setMustChange] = useState(true);
  const [copied, setCopied] = useState(false);
  const save = useMutation({
    mutationFn: () => api.adminSetPassword(user.id, password, mustChange),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
  const copy = () => {
    void navigator.clipboard?.writeText(`Usuario: ${user.email}\nClave: ${password}`);
    setCopied(true);
  };

  if (save.isSuccess)
    return (
      <Modal title="Clave cambiada" onClose={onClose} footer={<Button onClick={onClose}>Listo</Button>}>
        <div className="flex items-center gap-2 rounded-xl bg-money-50 px-3 py-2.5 text-sm text-money-700">
          <CheckCircle2 className="size-4" /> {user.name} ya puede entrar con la clave nueva.
        </div>
        <div className="rounded-xl border border-line bg-[#fafbfc] px-4 py-3 font-mono text-sm">
          <p>Usuario: {user.email}</p>
          <p>Clave: {password}</p>
        </div>
        <Button variant="secondary" onClick={copy}>
          <Copy className="size-4" /> {copied ? 'Copiado' : 'Copiar para enviarle'}
        </Button>
        <p className="text-xs text-muted">
          {mustChange ? 'Al entrar, Cuadra le pedirá cambiarla por una propia. ' : ''}Si tenía la sesión abierta en otro equipo, se cerró.
        </p>
      </Modal>
    );

  return (
    <Modal
      title="Cambiar clave"
      intro={`${user.name} · ${user.email}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={password.length < 8}>
            <KeyRound className="size-4" /> Guardar clave
          </Button>
        </>
      }
    >
      <Field label="Clave nueva" hint="Mínimo 8 caracteres">
        <div className="flex gap-2">
          <input value={password} onChange={(e) => setPassword(e.target.value)} className={cn(inputCls, 'font-mono')} autoComplete="off" />
          <Button variant="secondary" onClick={() => setPassword(newPassword())} title="Generar otra">
            <Wand2 className="size-4" />
          </Button>
        </div>
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} className="mt-0.5 size-4 accent-brand-600" />
        <span>
          Pedirle que la cambie al entrar
          <span className="block text-xs text-muted">Recomendado: así solo él o ella conoce su clave.</span>
        </span>
      </label>
      {!user.isActive && <p className="text-xs text-sun-700">El usuario está desactivado: al guardar la clave queda activo de nuevo.</p>}
      <ErrorBox error={save.error} />
    </Modal>
  );
}

// ------------------------------------------------------------------ Actividad

function Activity({ filters, setFilters }: { filters: ActivityFilters; setFilters: (f: ActivityFilters) => void }) {
  const tenants = useQuery({ queryKey: ['admin-tenants'], queryFn: api.adminTenants });
  const users = useQuery({ queryKey: ['admin-users', filters.tenantId ?? ''], queryFn: () => api.adminUsers(filters.tenantId) });
  const summary = useQuery({ queryKey: ['admin-activity-summary', filters], queryFn: () => api.adminActivitySummary(filters) });
  const list = useInfiniteQuery({
    queryKey: ['admin-activity', filters],
    queryFn: ({ pageParam }) => api.adminActivity(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.length === 200 ? last[last.length - 1].at : undefined),
  });
  const events = useMemo(() => (list.data?.pages ?? []).flat(), [list.data]);
  const byDay = useMemo(() => {
    const m = new Map<string, ActivityEvent[]>();
    for (const e of events) m.set(dayOf(e.at), [...(m.get(dayOf(e.at)) ?? []), e]);
    return [...m.entries()];
  }, [events]);
  const set = (patch: Partial<ActivityFilters>) => setFilters({ ...filters, ...patch });
  const s = summary.data;
  const totals = s?.byDay.reduce((a, d) => ({ logins: a.logins + d.logins, actions: a.actions + d.actions, pages: a.pages + d.pages }), {
    logins: 0,
    actions: 0,
    pages: 0,
  });
  const maxDay = Math.max(1, ...(s?.byDay ?? []).map((d) => d.actions + d.pages));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={filters.tenantId ?? ''}
          onChange={(e) => set({ tenantId: e.target.value || undefined, userId: undefined })}
          className={cn(inputCls, 'w-56')}
          aria-label="Empresa"
        >
          <option value="">Todas las empresas</option>
          {(tenants.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select
          value={filters.userId ?? ''}
          onChange={(e) => set({ userId: e.target.value || undefined })}
          className={cn(inputCls, 'w-56')}
          aria-label="Usuario"
        >
          <option value="">Todos los usuarios</option>
          {(users.data ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} ({u.email})
            </option>
          ))}
        </select>
        <select
          value={filters.kind ?? ''}
          onChange={(e) => set({ kind: (e.target.value || undefined) as ActivityKind | undefined })}
          className={cn(inputCls, 'w-44')}
          aria-label="Tipo"
        >
          <option value="">Todo</option>
          <option value="LOGIN">Ingresos</option>
          <option value="LOGIN_FALLIDO">Ingresos fallidos</option>
          <option value="PAGINA">Páginas</option>
          <option value="ACCION">Acciones</option>
        </select>
        <select value={filters.days ?? 30} onChange={(e) => set({ days: Number(e.target.value) })} className={cn(inputCls, 'w-36')} aria-label="Período">
          <option value={1}>Hoy y ayer</option>
          <option value={7}>7 días</option>
          <option value={30}>30 días</option>
          <option value={90}>90 días</option>
          <option value={365}>Un año</option>
        </select>
      </div>

      {/* Resumen del período */}
      {s && totals && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="p-4">
            <p className="text-xs font-medium tracking-wide text-muted uppercase">En {s.days} días</p>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center">
              {[
                ['Ingresos', totals.logins],
                ['Páginas', totals.pages],
                ['Acciones', totals.actions],
              ].map(([l, n]) => (
                <div key={l as string}>
                  <p className="figure text-2xl font-semibold">{n}</p>
                  <p className="text-xs text-muted">{l}</p>
                </div>
              ))}
            </div>
            {s.byDay.length > 0 && (
              <div className="mt-4 flex h-16 items-end gap-0.5" aria-label="Uso por día">
                {s.byDay.map((d) => (
                  <div
                    key={d.day}
                    title={`${dmy(d.day)}: ${d.logins} ingresos, ${d.pages} páginas, ${d.actions} acciones`}
                    className="flex-1 rounded-t bg-brand-500/80"
                    style={{ height: `${Math.max(4, ((d.actions + d.pages) / maxDay) * 100)}%` }}
                  />
                ))}
              </div>
            )}
          </Card>
          <TopList title="Dónde entraron" rows={s.pages.map((p) => ({ name: p.name.replace(/^Abrió /, ''), n: p.n }))} />
          <TopList title="Qué hicieron" rows={s.actions.map((a) => ({ name: a.name, n: a.n, failed: a.failed }))} />
        </div>
      )}

      <ErrorBox error={list.error ?? summary.error} />
      {list.isLoading ? (
        <Loading />
      ) : !events.length ? (
        <Card>
          <Empty
            icon={<MousePointerClick className="size-6" />}
            title="Sin actividad"
            text="No hay actividad con esos filtros. La actividad se registra desde ahora en adelante."
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {byDay.map(([day, list]) => (
            <section key={day}>
              <h3 className="mb-1.5 text-sm font-semibold first-letter:uppercase">{longDay(day)}</h3>
              <Card className="divide-y divide-line">
                {list.map((e) => {
                  const k = KIND[e.kind];
                  const failed = (e.status ?? 0) >= 400;
                  return (
                    <div key={e.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                      <span className="figure w-11 shrink-0 pt-0.5 text-xs text-muted">{hour(e.at)}</span>
                      <span className={cn('grid size-7 shrink-0 place-items-center rounded-lg', k.tone)} title={k.label}>
                        <k.icon className="size-3.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className={cn('font-medium', e.kind === 'PAGINA' && 'font-normal text-ink/80')}>
                          {e.description}
                          {failed && e.kind === 'ACCION' && (
                            <Pill tone="rojo" className="ml-1.5">
                              <AlertTriangle className="size-3" /> falló
                            </Pill>
                          )}
                        </p>
                        <p className="text-xs text-muted">
                          {e.user ? (e.user.name ?? e.user.email) : 'Desconocido'}
                          {e.user?.name && e.user.email ? ` · ${e.user.email}` : ''}
                          {e.company ? ` · ${e.company.name}` : ''}
                          {e.device ? ` · ${e.device}` : ''}
                          {e.ip ? ` · IP ${e.ip}` : ''}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </Card>
            </section>
          ))}
          {list.hasNextPage && (
            <Button variant="secondary" onClick={() => list.fetchNextPage()} loading={list.isFetchingNextPage}>
              Ver más antiguo
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function TopList({ title, rows }: { title: string; rows: { name: string; n: number; failed?: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <Card className="p-4">
      <p className="text-xs font-medium tracking-wide text-muted uppercase">{title}</p>
      {!rows.length ? (
        <p className="mt-3 text-sm text-muted">Nada en este período.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {rows.slice(0, 8).map((r) => (
            <li key={r.name} className="text-sm">
              <div className="flex justify-between gap-2">
                <span className="truncate" title={r.name}>
                  {r.name}
                </span>
                <span className="figure shrink-0 font-medium">
                  {r.n}
                  {r.failed ? <span className="ml-1 text-xs text-berry-700">({r.failed} fallaron)</span> : null}
                </span>
              </div>
              <div className="mt-0.5 h-1 rounded-full bg-[#eef1f5]">
                <div className="h-1 rounded-full bg-brand-500" style={{ width: `${(r.n / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ Empresas

function Companies({ onActivity }: { onActivity: (tenantId: string) => void }) {
  const qc = useQueryClient();
  const tenants = useQuery({ queryKey: ['admin-tenants'], queryFn: api.adminTenants });
  const update = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { plan?: string; status?: string } }) => api.adminUpdateTenant(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-tenants'] }),
  });
  const enter = useMutation({
    mutationFn: api.adminEnter,
    onSuccess: () => {
      qc.clear();
      window.location.href = '/';
    },
  });
  const list = tenants.data ?? [];
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        {list.length} empresas usan Cuadra · {list.filter((t) => t.status === 'ACTIVA').length} activas
      </p>
      <ErrorBox error={tenants.error ?? update.error} />
      <Card>
        {tenants.isLoading ? (
          <Loading />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line">
                <tr>
                  <th className={th}>Empresa</th>
                  <th className={th}>Dueño</th>
                  <th className={cn(th, 'text-right')}>Ventas</th>
                  <th className={th}>Última venta</th>
                  <th className={th}>Plan</th>
                  <th className={th}>Estado</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.map((t) => (
                  <tr key={t.id}>
                    <td className={td}>
                      <p className="font-medium">{t.name}</p>
                      <p className="text-xs text-muted">
                        {t.taxId ?? 'sin RUT'} · desde {dmy(t.createdAt)} · {t.users} usuarios
                      </p>
                    </td>
                    <td className={cn(td, 'text-muted')}>{t.owner}</td>
                    <td className={cn(td, 'num text-right')}>{t.orders}</td>
                    <td className={cn(td, 'text-muted')}>{dmy(t.lastOrder)}</td>
                    <td className={td}>
                      <select
                        value={t.plan}
                        onChange={(e) => update.mutate({ id: t.id, data: { plan: e.target.value } })}
                        className="rounded-lg border border-line bg-white px-2 py-1 text-sm"
                      >
                        <option value="PRUEBA">Prueba</option>
                        <option value="BASICO">Básico</option>
                        <option value="PRO">Pro</option>
                      </select>
                    </td>
                    <td className={td}>
                      <button onClick={() => update.mutate({ id: t.id, data: { status: t.status === 'ACTIVA' ? 'SUSPENDIDA' : 'ACTIVA' } })}>
                        <Pill tone={t.status === 'ACTIVA' ? 'verde' : 'rojo'}>{t.status === 'ACTIVA' ? 'Activa' : 'Suspendida'}</Pill>
                      </button>
                    </td>
                    <td className={cn(td, 'text-right whitespace-nowrap')}>
                      <Button size="sm" variant="ghost" onClick={() => onActivity(t.id)}>
                        Actividad
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => enter.mutate(t.id)}>
                        <LogIn className="size-4" /> Entrar
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
