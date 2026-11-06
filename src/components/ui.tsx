'use client';

import React, { useEffect, useId, useRef } from 'react';
import type { Tone } from '../lib/ui-format';

const TONE_BADGE: Record<Tone, string> = {
  green: 'border border-success-border bg-success-bg text-success-ink',
  amber: 'border border-warning-border bg-warning-bg text-warning',
  red: 'border border-error-border bg-error-bg text-error-ink',
  slate: 'border border-rule bg-paper-3 text-ink-2',
};

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-[6px] px-2 text-[11px] font-medium ${TONE_BADGE[tone]}`}
    >
      {children}
    </span>
  );
}

export function Card({
  children,
  className = '',
  as: Tag = 'div',
}: {
  children: React.ReactNode;
  className?: string;
  as?: 'div' | 'article' | 'section';
}) {
  return <Tag className={`card ${className}`}>{children}</Tag>;
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="grid gap-1 rounded-[8px] border border-rule bg-paper-3 p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={`min-h-[34px] truncate rounded-[6px] border px-2 text-[13px] font-medium transition-colors ${
              active
                ? 'border-rule bg-white text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export type ToastState = { kind: 'ok' | 'error'; text: string } | null;

export function Toast({ toast, onClose }: { toast: ToastState; onClose: () => void }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => onCloseRef.current(), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;
  const isError = toast.kind === 'error';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      className={`flex items-center justify-between gap-2.5 rounded-[8px] border px-3.5 py-2.5 text-[13px] font-medium ${
        isError
          ? 'border-error-border bg-error-bg text-error-ink'
          : 'border-success-border bg-success-bg text-success-ink'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0">{toast.text}</span>
      </div>
      <button
        type="button"
        aria-label="Tutup"
        onClick={onClose}
        className="shrink-0 rounded-[4px] px-1.5 text-base leading-none opacity-70 hover:opacity-100"
      >
        ×
      </button>
    </div>
  );
}

export function NoAccess({ text = 'Halaman ini khusus Admin.' }: { text?: string }) {
  return (
    <Card className="p-5 text-center">
      <p className="text-[14px] font-medium text-muted">{text}</p>
    </Card>
  );
}

export function BottomSheet({
  open,
  title,
  onClose,
  headerActions,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  headerActions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const getFocusable = () => {
      if (!dialogRef.current) return [];
      return Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);
    };

    if (dialogRef.current && !dialogRef.current.contains(document.activeElement)) {
      const first = getFocusable()[0] ?? dialogRef.current;
      first.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab') {
        const focusable = getFocusable();
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="no-print fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-scrim"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-[8px] border border-rule bg-white sm:rounded-[8px]"
      >
        <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-control sm:hidden" />
        <div className="flex items-center justify-between gap-2 border-b border-rule bg-paper-2 px-4 py-3">
          <h2 id={titleId} className="truncate text-[15px] font-medium text-ink">
            {title}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            {headerActions}
            <button
              type="button"
              onClick={onClose}
              aria-label="Tutup dialog"
              className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-[6px] border border-control bg-white text-base text-muted hover:bg-paper hover:text-ink"
            >
              ×
            </button>
          </div>
        </div>
        <div className="p-4 pb-6">{children}</div>
      </div>
    </div>
  );
}

export function StatRow({
  label,
  value,
  strong,
  tone,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  strong?: boolean;
  tone?: 'red' | 'green';
}) {
  const color =
    tone === 'red' ? 'text-error' : tone === 'green' ? 'text-success' : 'text-ink';
  return (
    <div className={`flex items-baseline justify-between gap-3 py-0.5 ${strong ? 'font-bold' : ''}`}>
      <span className={`min-w-0 truncate text-[13px] ${tone ? color : 'text-muted'}`}>{label}</span>
      <span className={`shrink-0 tabular-nums ${strong ? 'text-[15px] font-bold' : 'text-[14px] font-medium'} ${color}`}>
        {value}
      </span>
    </div>
  );
}
