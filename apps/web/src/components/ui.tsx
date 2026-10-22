'use client';

import { AlertTriangle, ChevronDown, HelpCircle, Loader2, X } from 'lucide-react';
import Link from 'next/link';
import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/* ------------------------------------------------------------------ formatos */

export const clp = (n: number | null | undefined) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const abs = `$${Math.abs(Math.round(n)).toLocaleString('es-CL')}`;
  return n < 0 ? `-${abs}` : abs;
};

/** "2026-10-05" -> "05/10/2026" */
export const dmy = (d: string | null | undefined) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '—');

/** "2026-10-05" -> "5 oct" */
export function shortDate(d: string | null | undefined) {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('es-CL', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export const todayCL = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** "2026-10" -> "octubre 2026" */
export const monthLabel = (m: string) => {
  const [y, mm] = m.split('-').map(Number);
  return `${MONTHS[mm - 1]} ${y}`;
};
export const addMonths = (m: string, n: number) => {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mm - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
export const monthRange = (m: string) => {
  const [y, mm] = m.split('-').map(Number);
  const last = new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10);
  const today = todayCL();
  return { from: `${m}-01`, to: last < today ? last : today };
};

/** "12.500" / "$ 12500" -> 12500 */
export function parseAmount(text: string): number | null {
  const clean = text.replace(/[$\s.]/g, '').replace(',', '.');
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}
/** Mientras se escribe: "12500" -> "12.500" */
export const typingAmount = (v: string) => {
  const d = v.replace(/[^\d]/g, '');
  return d ? Number(d).toLocaleString('es-CL') : '';
};

/* ------------------------------------------------------------------ piezas */

export function Page({
  title,
  intro,
  help,
  actions,
  wide,
  children,
}: {
  title: string;
  intro?: ReactNode;
  help?: ReactNode;
  actions?: ReactNode;
  /** Usa todo el ancho de la pantalla (tablas con muchas columnas) */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`mx-auto w-full px-4 py-8 sm:px-6 ${wide ? 'max-w-[1680px]' : 'max-w-6xl'}`}>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          {intro && <p className="mt-1.5 text-base text-muted">{intro}</p>}
          {help && <Help>{help}</Help>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

/** "¿Cómo funciona?" desplegable, para explicar sin ensuciar la pantalla */
export function Help({ children, label = '¿Cómo funciona?' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-sm font-medium text-sky-700 hover:underline">
        <HelpCircle className="size-4" /> {label}
        <ChevronDown className={cn('size-3.5 transition', open && 'rotate-180')} />
      </button>
      {open && <div className="mt-2 space-y-1.5 rounded-xl bg-sky-50 px-4 py-3 text-sm leading-relaxed text-ink">{children}</div>}
    </div>
  );
}

export function Card({ children, className, ...props }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={cn('rounded-2xl border border-line bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]', className)}>
      {children}
    </div>
  );
}

type Tone = 'verde' | 'ambar' | 'rojo' | 'azul' | 'gris';
const TONES: Record<Tone, string> = {
  verde: 'bg-brand-50 text-brand-700',
  ambar: 'bg-sun-50 text-sun-700',
  rojo: 'bg-berry-50 text-berry-700',
  azul: 'bg-sky-50 text-sky-700',
  gris: 'bg-stone-100 text-stone-600',
};

export function Pill({ tone = 'gris', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap', TONES[tone], className)}>{children}</span>;
}

/** Número grande con su explicación en palabras */
export function BigNumber({
  label,
  value,
  sub,
  tone,
  icon,
  href,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
  href?: string;
}) {
  const body = (
    <Card className={cn('h-full p-5 transition', href && 'hover:border-brand-200 hover:shadow-md')}>
      <div className="flex items-center gap-2 text-sm font-medium text-muted">
        {icon && <span className={cn('grid size-8 place-items-center rounded-full', TONES[tone ?? 'gris'])}>{icon}</span>}
        {label}
      </div>
      <p className={cn('num mt-3 text-3xl font-semibold tracking-tight', tone === 'rojo' && 'text-berry-700', tone === 'verde' && 'text-brand-700')}>{value}</p>
      {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
    </Card>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'lg'; loading?: boolean }) {
  const styles = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm',
    secondary: 'border border-line bg-white text-ink hover:bg-stone-50',
    ghost: 'text-brand-700 hover:bg-brand-50',
    danger: 'bg-berry-500 text-white hover:bg-berry-700',
  };
  const sizes = { sm: 'px-3 py-1.5 text-sm', md: 'px-4 py-2 text-sm', lg: 'px-5 py-3 text-base' };
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || loading}
      className={cn('inline-flex items-center justify-center gap-2 rounded-xl font-medium transition disabled:opacity-50', styles[variant], sizes[size], className)}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

export function LinkButton({ href, children, variant = 'primary', className }: { href: string; children: ReactNode; variant?: 'primary' | 'secondary' | 'ghost'; className?: string }) {
  const styles = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm',
    secondary: 'border border-line bg-white text-ink hover:bg-stone-50',
    ghost: 'text-brand-700 hover:bg-brand-50',
  };
  return (
    <Link href={href} className={cn('inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition', styles[variant], className)}>
      {children}
    </Link>
  );
}

export const inputCls =
  'w-full rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none transition placeholder:text-stone-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-stone-50';

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="flex items-start gap-2 rounded-xl bg-berry-50 px-3 py-2 text-sm text-berry-700">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

export function Loading({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
      <Loader2 className="size-5 animate-spin" /> {label}
    </div>
  );
}

/** Pantalla vacía que dice qué hacer */
export function Empty({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      {icon && <div className="mb-3 grid size-14 place-items-center rounded-full bg-brand-50 text-brand-600">{icon}</div>}
      <p className="text-lg font-semibold">{title}</p>
      {text && <p className="mt-1 max-w-md text-sm text-muted">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Modal({ title, intro, onClose, children, footer, wide }: { title: string; intro?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 sm:p-8" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cn('w-full rounded-2xl bg-white shadow-2xl', wide ? 'max-w-3xl' : 'max-w-lg')}>
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <div>
            <h2 className="text-xl font-semibold">{title}</h2>
            {intro && <p className="mt-1 text-sm text-muted">{intro}</p>}
          </div>
          <button onClick={onClose} className="rounded-full p-1.5 text-muted hover:bg-stone-100" aria-label="Cerrar">
            <X className="size-5" />
          </button>
        </div>
        <div className="space-y-4 px-6 py-5">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}

/** Pestañas simples */
export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: ReactNode; count?: number }[] }) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-2xl bg-stone-200/60 p-1">
      {items.map((i) => (
        <button
          key={i.id}
          onClick={() => onChange(i.id)}
          className={cn('rounded-xl px-3.5 py-1.5 text-sm font-medium transition', value === i.id ? 'bg-white text-ink shadow-sm' : 'text-muted hover:text-ink')}
        >
          {i.label}
          {i.count !== undefined && <span className={cn('ml-1.5 text-xs', value === i.id ? 'text-muted' : 'text-stone-400')}>{i.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Selector de mes (‹ octubre 2026 ›) */
export function MonthPicker({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  const current = todayCL().slice(0, 7);
  return (
    <div className="inline-flex items-center rounded-xl border border-line bg-white">
      <button onClick={() => onChange(addMonths(value, -1))} className="px-3 py-2 text-muted hover:text-ink" aria-label="Mes anterior">
        ‹
      </button>
      <span className="min-w-36 text-center text-sm font-medium capitalize">{monthLabel(value)}</span>
      <button
        onClick={() => onChange(addMonths(value, 1))}
        disabled={value >= current}
        className="px-3 py-2 text-muted hover:text-ink disabled:opacity-30"
        aria-label="Mes siguiente"
      >
        ›
      </button>
    </div>
  );
}

/** Barra de progreso */
export function Progress({ value, total, tone = 'verde' }: { value: number; total: number; tone?: 'verde' | 'ambar' }) {
  const pct = total ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-stone-200">
      <div className={cn('h-full rounded-full transition-all', tone === 'verde' ? 'bg-brand-500' : 'bg-sun-500')} style={{ width: `${pct}%` }} />
    </div>
  );
}

export const th = 'px-4 py-3 text-left text-xs font-medium tracking-wide text-muted uppercase';
export const td = 'px-4 py-3';
