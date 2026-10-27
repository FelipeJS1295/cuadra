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
    <div className={`mx-auto w-full px-4 py-6 sm:px-6 lg:py-8 ${wide ? 'max-w-[1680px]' : 'max-w-7xl'}`}>
      <header className="mb-7 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div className="max-w-2xl">
          <h1 className="display text-[1.75rem] leading-tight font-semibold">{title}</h1>
          {intro && <p className="mt-1 text-[0.9375rem] text-muted">{intro}</p>}
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
      <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink" aria-expanded={open}>
        <HelpCircle className="size-4" /> {label}
        <ChevronDown className={cn('size-3.5 transition', open && 'rotate-180')} />
      </button>
      {open && <div className="mt-2 max-w-2xl space-y-1.5 border-l-2 border-brand-200 py-1 pl-4 text-sm leading-relaxed text-ink/85">{children}</div>}
    </div>
  );
}

export function Card({ children, className, ...props }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={cn('rounded-2xl border border-line bg-white', className)}>
      {children}
    </div>
  );
}

type Tone = 'verde' | 'ambar' | 'rojo' | 'azul' | 'gris';
const TONES: Record<Tone, string> = {
  verde: 'bg-money-50 text-money-700',
  ambar: 'bg-sun-50 text-sun-700',
  rojo: 'bg-berry-50 text-berry-700',
  azul: 'bg-brand-50 text-brand-700',
  gris: 'bg-[#eef0f3] text-[#4a525c]',
};

export function Pill({ tone = 'gris', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONES[tone], className)}>{children}</span>;
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
    <Card className={cn('h-full p-5 transition-colors', href && 'hover:border-line-strong')}>
      <div className="flex items-center gap-2 text-sm text-muted">
        {icon && (
          <span
            className={cn(
              '[&>svg]:size-4',
              tone === 'rojo' ? 'text-berry-500' : tone === 'verde' ? 'text-money-600' : tone === 'ambar' ? 'text-sun-500' : tone === 'azul' ? 'text-brand-600' : 'text-muted',
            )}
          >
            {icon}
          </span>
        )}
        {label}
      </div>
      <p className={cn('figure mt-2.5 text-[2rem] leading-none font-semibold', tone === 'rojo' && 'text-berry-700', tone === 'verde' && 'text-money-700')}>{value}</p>
      {sub && <p className="mt-2 text-sm text-muted">{sub}</p>}
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
    primary: 'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-900',
    secondary: 'border border-line-strong bg-white text-ink hover:border-ink/40 hover:bg-[#fafbfc]',
    ghost: 'text-brand-700 hover:bg-brand-50',
    danger: 'bg-berry-500 text-white hover:bg-berry-700',
  };
  const sizes = { sm: 'h-8 px-3 text-sm', md: 'h-9 px-4 text-sm', lg: 'h-11 px-5 text-[0.9375rem]' };
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || loading}
      className={cn('inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-45', styles[variant], sizes[size], className)}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

export function LinkButton({ href, children, variant = 'primary', className }: { href: string; children: ReactNode; variant?: 'primary' | 'secondary' | 'ghost'; className?: string }) {
  const styles = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700',
    secondary: 'border border-line-strong bg-white text-ink hover:border-ink/40',
    ghost: 'text-brand-700 hover:bg-brand-50',
  };
  return (
    <Link href={href} className={cn('inline-flex h-9 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors', styles[variant], className)}>
      {children}
    </Link>
  );
}

export const inputCls =
  'w-full rounded-lg border border-line-strong bg-white px-3 py-2 text-sm outline-none transition-colors placeholder:text-[#9aa2ad] hover:border-[#b5bcc6] focus:border-brand-600 focus:ring-3 focus:ring-brand-100 disabled:border-line disabled:bg-paper disabled:text-muted';

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1.5 block text-[0.8125rem] font-medium text-ink/85">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg border border-berry-100 bg-berry-50 px-3 py-2 text-sm text-berry-700">
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
      {icon && <div className="mb-4 grid size-12 place-items-center rounded-xl border border-line bg-paper text-muted">{icon}</div>}
      <p className="text-base font-semibold">{title}</p>
      {text && <p className="mt-1 max-w-md text-sm text-muted">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Modal({ title, intro, onClose, children, footer, wide }: { title: string; intro?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-graphite-900/45 p-4 backdrop-blur-[2px] sm:p-10"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className={cn('w-full rounded-2xl border border-line bg-white shadow-[0_24px_60px_-20px_rgba(15,20,30,0.35)]', wide ? 'max-w-3xl' : 'max-w-lg')}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div>
            <h2 className="display text-lg font-semibold">{title}</h2>
            {intro && <p className="mt-1 text-sm text-muted">{intro}</p>}
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted hover:bg-paper hover:text-ink" aria-label="Cerrar">
            <X className="size-5" />
          </button>
        </div>
        <div className="space-y-4 px-6 py-5">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 rounded-b-2xl border-t border-line bg-[#fafbfc] px-6 py-3.5">{footer}</div>}
      </div>
    </div>
  );
}

/** Pestañas simples */
export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: ReactNode; count?: number }[] }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-line" role="tablist">
      {items.map((i) => (
        <button
          key={i.id}
          role="tab"
          aria-selected={value === i.id}
          onClick={() => onChange(i.id)}
          className={cn(
            '-mb-px border-b-2 pt-1 pb-2.5 text-sm font-medium transition-colors',
            value === i.id ? 'border-brand-600 text-ink' : 'border-transparent text-muted hover:text-ink',
          )}
        >
          {i.label}
          {i.count !== undefined && (
            <span className={cn('num ml-1.5 rounded-full px-1.5 py-px text-xs', value === i.id ? 'bg-brand-50 text-brand-700' : 'bg-[#eef0f3] text-muted')}>{i.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Selector de mes (‹ octubre 2026 ›) */
export function MonthPicker({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  const current = todayCL().slice(0, 7);
  return (
    <div className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-white">
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
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#e8ebef]">
      <div className={cn('h-full rounded-full transition-all', tone === 'verde' ? 'bg-money-500' : 'bg-sun-500')} style={{ width: `${pct}%` }} />
    </div>
  );
}

export const th = 'bg-[#f8f9fb] px-4 py-2.5 text-left text-xs font-medium text-muted';
export const td = 'px-4 py-3';
