import { cn } from '@/lib/cn';

/**
 * Marca de Cuadra: un cuadrado partido en dos mitades que calzan
 * (lo vendido y lo pagado), con la marca de "cuadra" entre ambas.
 */
export function LogoMark({ className, dark }: { className?: string; dark?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('size-6', className)} aria-hidden>
      <rect x="2" y="2" width="20" height="20" rx="4.5" fill={dark ? '#ffffff' : '#1f2328'} />
      <path d="M12 2h5.5A4.5 4.5 0 0 1 22 6.5v11a4.5 4.5 0 0 1-4.5 4.5H12z" fill="#2b5bd7" />
      <path d="M7.3 12.2l2.6 2.6 5.2-5.6" fill="none" stroke={dark ? '#1f2328' : '#ffffff'} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ dark, className }: { dark?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <LogoMark dark={dark} />
      <span className={cn('display text-[1.125rem] font-semibold', dark ? 'text-white' : 'text-ink')}>Cuadra</span>
    </span>
  );
}
