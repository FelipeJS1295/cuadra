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
import { NotificationsBell } from './notifications-bell';
import { SessionProvider, useMe } from './session';
import { Loading } from './ui';

const NAV: { href: string; label: string; icon: LucideIcon; group: 'dia' | 'admin' }[] = [
  { href: '/', label: 'Inicio', icon: Home, group: 'dia' },
  { href: '/ventas', label: 'Ventas', icon: ShoppingBag, group: 'dia' },
  { href: '/cobros', label: 'Cobros', icon: Wallet, group: 'dia' },
  { href: '/compras', label: 'Compras', icon: Receipt, group: 'dia' },
  { href: '/impuestos', label: 'Impuestos', icon: Landmark, group: 'dia' },
  { href: '/productos', label: 'Productos', icon: Package, group: 'admin' },
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
  const items = [...NAV, ...(user.isSuperadmin ? [{ href: '/admin', label: 'Administración', icon: Shield, group: 'admin' as const }] : [])];
  const main = items.filter((n) => n.href !== '/configuracion' && n.href !== '/admin');
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  return (
    <SessionProvider user={user}>
      <div className="min-h-screen">
        <header className="sticky top-0 z-40 bg-graphite-900 text-white">
          <div className="mx-auto flex h-12 max-w-[1680px] items-center gap-2 px-3 sm:px-5">
            <button onClick={() => setMenu(!menu)} className="rounded-md p-1.5 text-white/80 hover:bg-white/10 lg:hidden" aria-label="Menú" aria-expanded={menu}>
              {menu ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
            <Link href="/" className="mr-3 shrink-0" aria-label="Inicio">
              <Logo dark />
            </Link>

            {user.tenantId && (
              <nav className="hidden h-full items-stretch lg:flex" aria-label="Secciones">
                {main.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    aria-current={isActive(n.href) ? 'page' : undefined}
                    className={cn(
                      'relative flex items-center px-3 text-[0.8125rem] transition-colors',
                      isActive(n.href) ? 'font-medium text-white' : 'text-white/60 hover:text-white',
                    )}
                  >
                    {n.label}
                    {isActive(n.href) && <span aria-hidden className="absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-brand-500" />}
                  </Link>
                ))}
              </nav>
            )}

            <div className="ml-auto flex items-center gap-1">
              <TenantSwitcher />
              {user.tenantId && <NotificationsBell />}
              {user.isSuperadmin && (
                <Link
                  href="/admin"
                  title="Administración"
                  className={cn('hidden rounded-md p-1.5 hover:bg-white/10 lg:block', isActive('/admin') ? 'text-white' : 'text-white/60')}
                >
                  <Shield className="size-[18px]" strokeWidth={1.75} />
                </Link>
              )}
              <Link
                href="/configuracion"
                title="Configuración"
                className={cn('hidden rounded-md p-1.5 hover:bg-white/10 lg:block', isActive('/configuracion') ? 'text-white' : 'text-white/60')}
              >
                <Cog className="size-[18px]" strokeWidth={1.75} />
              </Link>
              <UserMenu />
            </div>
          </div>

          {/* Celular: el menú se despliega bajo la barra */}
          {menu && (
            <nav className="border-t border-white/10 px-3 pt-2 pb-3 lg:hidden" aria-label="Secciones">
              {items.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm',
                    isActive(n.href) ? 'bg-white/[0.08] font-medium text-white' : 'text-white/70 hover:bg-white/[0.04]',
                  )}
                >
                  <n.icon className="size-4" strokeWidth={1.75} /> {n.label}
                </Link>
              ))}
            </nav>
          )}
        </header>

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
        className="flex max-w-[220px] items-center gap-2 rounded-md px-2 py-1 text-left text-[0.8125rem] text-white/85 hover:bg-white/10"
        aria-expanded={open}
        title="Cambiar de empresa"
      >
        <Building2 className="size-4 shrink-0 text-white/50" strokeWidth={1.75} />
        <span className="truncate">{user.tenantName ?? 'Elegir empresa'}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-white/40" />
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1.5 w-72 rounded-xl border border-line bg-white p-1.5 text-ink shadow-[0_16px_40px_-12px_rgba(15,20,30,0.35)]">
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
    <div ref={ref} className="relative ml-1">
      <button
        onClick={() => setOpen(!open)}
        className="grid size-7 place-items-center rounded-full bg-brand-600 text-[0.6875rem] font-semibold text-white ring-2 ring-transparent hover:ring-white/20"
        aria-expanded={open}
        title={user.name}
      >
        {initials}
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-2 w-64 rounded-xl border border-line bg-white p-1.5 text-ink shadow-[0_16px_40px_-12px_rgba(15,20,30,0.35)]">
          <div className="border-b border-line px-2 pt-1 pb-2">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-muted">{user.email}</p>
          </div>
          <Link href="/configuracion?tab=cuenta" onClick={() => setOpen(false)} className="mt-1 flex items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-paper">
            <UserRound className="size-4 text-muted" /> Mi cuenta
          </Link>
          <Link href="/configuracion" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-paper">
            <Cog className="size-4 text-muted" /> Configuración
          </Link>
          <button onClick={() => logout.mutate()} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-berry-700 hover:bg-berry-50">
            <LogOut className="size-4" /> Cerrar sesión
          </button>
        </div>
      )}
    </div>
  );
}
