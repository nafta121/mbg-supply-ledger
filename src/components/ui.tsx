'use client';

import React, { useEffect, useRef } from 'react';
import type { Tone } from '../lib/ui-format';

const TONE_BADGE: Record<Tone, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/30',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/30',
  red: 'bg-rose-50 text-rose-700 ring-rose-600/30',
  slate: 'bg-slate-100 text-slate-700 ring-slate-500/30',
};

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${TONE_BADGE[tone]}`}
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
      className="grid gap-1 rounded-xl bg-slate-200/70 p-1"
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
            className={`min-h-[40px] truncate rounded-lg px-2 text-sm font-semibold transition ${
              active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
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
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm font-medium ${
        isError
          ? 'border-rose-300 bg-rose-50 text-rose-800'
          : 'border-emerald-300 bg-emerald-50 text-emerald-800'
      }`}
    >
      <span className="min-w-0">{toast.text}</span>
      <button
        type="button"
        aria-label="Tutup"
        onClick={onClose}
        className="shrink-0 rounded px-1.5 text-base leading-none opacity-70 hover:opacity-100"
      >
        ×
      </button>
    </div>
  );
}

export function NoAccess({ text = 'Halaman ini khusus Admin.' }: { text?: string }) {
  return (
    <Card className="p-6 text-center">
      <p className="text-sm font-semibold text-slate-700">{text}</p>
    </Card>
  );
}

export function BottomSheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="no-print fixed inset-0 z-50 flex items-end justify-center">
      <button
        type="button"
        aria-label="Tutup"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-4 pb-6 shadow-xl"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-300" />
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup"
            className="flex h-9 w-9 items-center justify-center rounded-full text-xl text-slate-500 hover:bg-slate-100"
          >
            ×
          </button>
        </div>
        {children}
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
    tone === 'red' ? 'text-rose-700' : tone === 'green' ? 'text-emerald-700' : 'text-slate-900';
  return (
    <div className={`flex items-baseline justify-between gap-3 ${strong ? 'font-bold' : ''}`}>
      <span className={`min-w-0 truncate text-sm ${tone ? color : 'text-slate-600'}`}>{label}</span>
      <span className={`shrink-0 tabular-nums ${strong ? 'text-base' : 'text-sm'} ${color}`}>
        {value}
      </span>
    </div>
  );
}
