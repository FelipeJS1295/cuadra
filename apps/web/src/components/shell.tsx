'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  Check,
  ChevronsUpDown,
  Cog,
  Home,
  Landmark,
  LogOut,
  Menu,
  Package,
  PlugZap,
  Plus,
  Receipt,
  Shield,
  ShoppingBag,
  UserRound,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Landing } from './landing';
import { Logo } from './logo';
import { SessionProvider, useMe } from './session';
import { Loading } from './ui';

const NAV: { href: string; label: string; icon: LucideIcon; group: 'dia' | 'admin' }[] = [
  { href: '/', label: 'Inicio', icon: Home, group: 'dia' },
  { href: '/ventas', label: 'Ventas', icon: ShoppingBag, group: 'dia' },
  { href: '/cobros', label: 'Cobros', icon: Wallet, group: 'dia' },
  { href: '/compras', label: 'Compras', icon: Receipt, group: 'dia' },
  { href: '/impuestos', label: 'Impuestos', icon: Landmark, group: 'dia' },
  { href: '/productos', label: 'Productos', icon: Package, group: 'admin' },
  { href: '/conexiones', label: 'Conexiones', icon: PlugZap, group: 'admin' },
  { href: '/configuracion', label: 'Configuración', icon: Cog, group: 'admin' },
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
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    if (me.data && !me.data.tenantId && !me.data.isSuperadmin && pathname !== '/empresa-nueva') router.replace('/empresa-nueva');
  }, [me.data, pathname, router]);
  // Al navegar se cierra el menú en el celular
  useEffect(() => setMenu(false), [pathname]);

  // Sin sesión en la portada: la página de presentación de Cuadra
  const unauthenticated = me.isError && (me.error as { status?: number }).status === 401;
  if (pathname === '/' && unauthenticated) return <Landing />;
  // Sin sesión en otra página: al login (por si el aviso de la API no alcanzó a redirigir)
  if (unauthenticated) {
    if (typeof window !== 'undefined') window.location.href = '/login';
    return <Loading label="Abriendo Cuadra…" />;
  }
  if (me.isError)
    return (
      <div className="grid min-h-screen place-items-center p-6">
        <div className="max-w-sm text-center">
          <Logo className="justify-center" />
          <p className="mt-6 font-medium">No pudimos conectar con Cuadra</p>
          <p className="mt-1 text-sm text-muted">{me.error instanceof Error ? me.error.message : 'El servidor no respondió.'} Revisa tu conexión e intenta de nuevo.</p>
          <button onClick={() => me.refetch()} className="mt-5 h-9 rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700">
            Reintentar
          </button>
        </div>
      </div>
    );
  if (me.isLoading || !me.data) return <Loading label="Abriendo Cuadra…" />;
  const user = me.data;
  return (
    <SessionProvider user={user}>
      <div className="min-h-screen lg:pl-[248px]">
        {/* Barra superior en el celular */}
        <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-graphite-700 bg-graphite-900 px-4 py-3 text-white lg:hidden">
          <button onClick={() => setMenu(true)} className="-ml-1 rounded-lg p-1.5 hover:bg-white/10" aria-label="Abrir menú">
            <Menu className="size-5" />
          </button>
          <Logo dark />
          <span className="ml-auto max-w-[45%] truncate text-sm text-white/70">{user.tenantName}</span>
        </header>

        {menu && <div className="fixed inset-0 z-40 bg-graphite-900/50 lg:hidden" onClick={() => setMenu(false)} />}
        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-50 flex w-[248px] flex-col bg-graphite-900 text-white transition-transform lg:translate-x-0',
            menu ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <div className="flex items-center justify-between px-5 pt-5 pb-4">
            <Link href="/">
              <Logo dark />
            </Link>
            <button onClick={() => setMenu(false)} className="rounded-lg p-1 text-white/60 hover:bg-white/10 lg:hidden" aria-label="Cerrar menú">
              <X className="size-5" />
            </button>
          </div>
          <div className="px-3">
            <TenantSwitcher />
          </div>

          {user.tenantId && (
            <nav className="mt-5 flex-1 overflow-y-auto px-3" aria-label="Secciones">
              <NavGroup items={NAV.filter((n) => n.group === 'dia')} pathname={pathname} />
              <p className="mt-6 mb-1.5 px-3 text-xs text-white/40">Ajustes</p>
              <NavGroup items={NAV.filter((n) => n.group === 'admin')} pathname={pathname} />
              {user.isSuperadmin && (
                <NavGroup items={[{ href: '/admin', label: 'Administración', icon: Shield, group: 'admin' }]} pathname={pathname} />
              )}
            </nav>
          )}
          {!user.tenantId && <div className="flex-1" />}

          <UserMenu />
        </aside>

        {user.mustChangePassword && pathname !== '/configuracion' && (
          <div className="border-b border-sun-100 bg-sun-50 px-4 py-2 text-center text-sm text-sun-700">
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

function NavGroup({ items, pathname }: { items: typeof NAV; pathname: string }) {
  return (
    <ul className="space-y-0.5">
      {items.map((n) => {
        const active = n.href === '/' ? pathname === '/' : pathname.startsWith(n.href);
        return (
          <li key={n.href}>
            <Link
              href={n.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative flex items-center gap-3 rounded-lg px-3 py-2 text-[0.875rem] transition-colors',
                active ? 'bg-white/[0.08] font-medium text-white' : 'text-white/65 hover:bg-white/[0.04] hover:text-white',
              )}
            >
              {active && <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-brand-500" />}
              <n.icon className={cn('size-[18px]', active ? 'text-white' : 'text-white/50')} strokeWidth={1.75} />
              {n.label}
            </Link>
          </li>
        );
      })}
    </ul>
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
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-2 text-left hover:bg-white/[0.08]"
        aria-expanded={open}
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-white/10 text-xs font-semibold">
          {(user.tenantName ?? '?').slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{user.tenantName ?? 'Elegir empresa'}</span>
          <span className="block text-xs text-white/45">{user.businessMode === 'FABRICANTE' ? 'Fabricante' : 'Revendedor'}</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-white/40" />
      </button>
      {open && (
        <div className="absolute inset-x-0 z-10 mt-1.5 rounded-xl border border-line bg-white p-1.5 text-ink shadow-[0_16px_40px_-12px_rgba(15,20,30,0.35)]">
          <p className="px-2 pt-1 pb-1.5 text-xs text-muted">Tus empresas</p>
          {user.tenants.map((t) => (
            <button
              key={t.id}
              onClick={() => sw.mutate(t.id)}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-paper"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Building2 className="size-4 shrink-0 text-muted" />
                <span className="truncate">{t.name}</span>
              </span>
              {t.id === user.tenantId && <Check className="size-4 text-brand-600" />}
            </button>
          ))}
          <Link
            href="/empresa-nueva"
            onClick={() => setOpen(false)}
            className="mt-1 flex items-center gap-2 rounded-lg border-t border-line px-2 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50"
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
  const logout = useMutation({ mutationFn: api.logout, onSuccess: () => (window.location.href = '/') });
  const user = me.data!;
  const initials = user.name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <div ref={ref} className="relative border-t border-white/10 p-3">
      {open && (
        <div className="absolute inset-x-3 bottom-full mb-1.5 rounded-xl border border-line bg-white p-1.5 text-ink shadow-[0_16px_40px_-12px_rgba(15,20,30,0.35)]">
          <Link href="/configuracion?tab=cuenta" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-paper">
            <UserRound className="size-4 text-muted" /> Mi cuenta
          </Link>
          <button onClick={() => logout.mutate()} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-berry-700 hover:bg-berry-50">
            <LogOut className="size-4" /> Cerrar sesión
          </button>
        </div>
      )}
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.06]" aria-expanded={open}>
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-600 text-xs font-semibold">{initials}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{user.name}</span>
          <span className="block truncate text-xs text-white/45">{user.email}</span>
        </span>
      </button>
    </div>
  );
}
