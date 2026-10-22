'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  Check,
  ChevronDown,
  Cog,
  FileText,
  Home,
  Landmark,
  LogOut,
  Package,
  PlugZap,
  Plus,
  Receipt,
  Shield,
  ShoppingBag,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { SessionProvider, useMe } from './session';
import { Loading } from './ui';

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/', label: 'Inicio', icon: Home },
  { href: '/ventas', label: 'Ventas', icon: ShoppingBag },
  { href: '/cobros', label: 'Cobros', icon: Wallet },
  { href: '/compras', label: 'Compras', icon: Receipt },
  { href: '/impuestos', label: 'Impuestos', icon: Landmark },
  { href: '/productos', label: 'Productos', icon: Package },
  { href: '/conexiones', label: 'Conexiones', icon: PlugZap },
];

/** Pantallas sin menú (entrar, registrarse) */
const BARE = ['/login', '/registro'];

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (BARE.includes(pathname)) return <>{children}</>;
  return <AppShell>{children}</AppShell>;
}

function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (me.data && !me.data.tenantId && !me.data.isSuperadmin && pathname !== '/empresa-nueva') router.replace('/empresa-nueva');
  }, [me.data, pathname, router]);

  if (me.isLoading || !me.data) return <Loading label="Abriendo Cuadra…" />;
  const user = me.data;
  return (
    <SessionProvider user={user}>
      <div className="min-h-screen">
        <header className="sticky top-0 z-40 border-b border-line bg-paper/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
            <Link href="/" className="flex items-center gap-2">
              <span className="grid size-9 place-items-center rounded-xl bg-brand-600 text-lg font-bold text-white">C</span>
              <span className="hidden text-lg font-semibold tracking-tight sm:block">Cuadra</span>
            </Link>
            <TenantSwitcher />
            <div className="ml-auto flex items-center gap-1">
              {user.isSuperadmin && (
                <Link href="/admin" className={cn('rounded-xl p-2 text-muted hover:bg-white', pathname.startsWith('/admin') && 'bg-white text-ink')} title="Administración del sistema">
                  <Shield className="size-5" />
                </Link>
              )}
              <Link href="/configuracion" className={cn('rounded-xl p-2 text-muted hover:bg-white', pathname.startsWith('/configuracion') && 'bg-white text-ink')} title="Configuración">
                <Cog className="size-5" />
              </Link>
              <UserMenu />
            </div>
          </div>
          {user.tenantId && (
            <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-3 pb-2 sm:px-5">
              {NAV.map((n) => {
                const active = n.href === '/' ? pathname === '/' : pathname.startsWith(n.href);
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={cn(
                      'flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition',
                      active ? 'bg-ink text-white' : 'text-muted hover:bg-white hover:text-ink',
                    )}
                  >
                    <n.icon className="size-4" /> {n.label}
                  </Link>
                );
              })}
            </nav>
          )}
        </header>
        {user.mustChangePassword && pathname !== '/configuracion' && (
          <div className="bg-sun-50 px-4 py-2 text-center text-sm text-sun-700">
            Estás usando una clave temporal.{' '}
            <Link href="/configuracion?tab=cuenta" className="font-medium underline">
              Cámbiala aquí
            </Link>
          </div>
        )}
        <main>{children}</main>
      </div>
    </SessionProvider>
  );
}

function useOutside(onOut: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onOut();
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onOut]);
  return ref;
}

function TenantSwitcher() {
  const me = useMe();
  const qc = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useOutside(() => setOpen(false));
  const sw = useMutation({
    mutationFn: api.switchTenant,
    onSuccess: () => {
      qc.clear();
      setOpen(false);
      router.push('/');
    },
  });
  const user = me.data!;
  if (!user.tenantId && !user.tenants.length) return null;
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 rounded-xl border border-line bg-white px-3 py-1.5 text-sm font-medium hover:bg-stone-50">
        <Building2 className="size-4 text-muted" />
        <span className="max-w-40 truncate">{user.tenantName ?? 'Elegir empresa'}</span>
        <ChevronDown className="size-3.5 text-muted" />
      </button>
      {open && (
        <div className="absolute left-0 mt-2 w-72 rounded-2xl border border-line bg-white p-2 shadow-xl">
          <p className="px-2 pb-1 text-xs font-medium text-muted uppercase">Tus empresas</p>
          {user.tenants.map((t) => (
            <button
              key={t.id}
              onClick={() => sw.mutate(t.id)}
              className="flex w-full items-center justify-between rounded-xl px-2 py-2 text-left text-sm hover:bg-stone-50"
            >
              <span className="truncate">{t.name}</span>
              {t.id === user.tenantId && <Check className="size-4 text-brand-600" />}
            </button>
          ))}
          <Link
            href="/empresa-nueva"
            onClick={() => setOpen(false)}
            className="mt-1 flex items-center gap-2 rounded-xl px-2 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50"
          >
            <Plus className="size-4" /> Agregar otra empresa
          </Link>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const ref = useOutside(() => setOpen(false));
  const logout = useMutation({ mutationFn: api.logout, onSuccess: () => (window.location.href = '/login') });
  const user = me.data!;
  const initials = user.name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="grid size-9 place-items-center rounded-full bg-ink text-sm font-semibold text-white" title={user.name}>
        {initials}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-64 rounded-2xl border border-line bg-white p-2 shadow-xl">
          <div className="px-2 py-1.5">
            <p className="text-sm font-medium">{user.name}</p>
            <p className="text-xs text-muted">{user.email}</p>
          </div>
          <Link href="/configuracion?tab=cuenta" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-xl px-2 py-2 text-sm hover:bg-stone-50">
            <FileText className="size-4" /> Mi cuenta
          </Link>
          <button onClick={() => logout.mutate()} className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-sm text-berry-700 hover:bg-berry-50">
            <LogOut className="size-4" /> Salir
          </button>
        </div>
      )}
    </div>
  );
}
