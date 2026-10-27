'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, PackageCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, type AppNotification } from '@/lib/api';
import { cn } from '@/lib/cn';

/** "hace 5 min", "ayer"… */
function ago(iso: string) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ayer' : `hace ${d} días`;
}

/** Campana del menú: avisos de la empresa (ej. un cliente te envió ventas) */
export function NotificationsBell() {
  const qc = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ['notifications'], queryFn: api.notifications, refetchInterval: 60_000, retry: false });
  const read = useMutation({
    mutationFn: (ids?: string[]) => api.readNotifications(ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const unread = q.data?.unread ?? 0;
  const items = q.data?.items ?? [];
  const go = (n: AppNotification) => {
    if (!n.readAt) read.mutate([n.id]);
    setOpen(false);
    if (n.link) router.push(n.link);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={cn('relative rounded-md p-1.5 hover:bg-white/10', open || unread ? 'text-white' : 'text-white/60')}
        aria-label={unread ? `Avisos: ${unread} sin leer` : 'Avisos'}
        aria-expanded={open}
        title="Avisos"
      >
        <Bell className="size-[18px]" strokeWidth={1.75} />
        {unread > 0 && (
          <span className="anim-pop absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-berry-500 px-1 text-[10px] leading-4 font-semibold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-2 w-80 overflow-hidden rounded-xl border border-line bg-white text-ink shadow-[0_16px_40px_-12px_rgba(15,20,30,0.35)]">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <p className="text-sm font-medium">Avisos</p>
            {unread > 0 && (
              <button onClick={() => read.mutate(undefined)} className="text-xs font-medium text-brand-700 hover:underline">
                Marcar todo como leído
              </button>
            )}
          </div>
          {!items.length ? (
            <p className="px-3 py-6 text-center text-sm text-muted">No tienes avisos.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-line overflow-y-auto">
              {items.map((n) => (
                <li key={n.id}>
                  <button onClick={() => go(n)} className={cn('flex w-full gap-3 px-3 py-2.5 text-left hover:bg-paper', !n.readAt && 'bg-brand-50/50')}>
                    <span className={cn('mt-0.5 grid size-7 shrink-0 place-items-center rounded-full', n.readAt ? 'bg-stone-100 text-muted' : 'bg-brand-100 text-brand-700')}>
                      <PackageCheck className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-sm', !n.readAt && 'font-medium')}>{n.title}</span>
                      {n.body && <span className="mt-0.5 block text-xs text-muted">{n.body}</span>}
                      <span className="mt-0.5 block text-[11px] text-muted">{ago(n.createdAt)}</span>
                    </span>
                    {!n.readAt && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-600" aria-label="Sin leer" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
