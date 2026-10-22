'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogIn } from 'lucide-react';
import { useSession } from '@/components/session';
import { Button, Card, dmy, ErrorBox, Loading, Page, Pill, td, th } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

export default function AdminPage() {
  const { user } = useSession();
  const qc = useQueryClient();
  const tenants = useQuery({ queryKey: ['admin-tenants'], queryFn: api.adminTenants, enabled: user.isSuperadmin });
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
  if (!user.isSuperadmin) return <Page title="Sin acceso">Solo para el administrador del sistema.</Page>;
  const list = tenants.data ?? [];
  return (
    <Page title="Empresas" intro={`${list.length} empresas usan Cuadra · ${list.filter((t) => t.status === 'ACTIVA').length} activas`}>
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
                      <select value={t.plan} onChange={(e) => update.mutate({ id: t.id, data: { plan: e.target.value } })} className="rounded-lg border border-line bg-white px-2 py-1 text-sm">
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
                    <td className={td}>
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
    </Page>
  );
}
