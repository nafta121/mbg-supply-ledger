'use client';

import React, { useEffect, useRef } from 'react';
import type { Tone } from '../lib/ui-format';

const TONE_BADGE: Record<Tone, string> = {
  green: 'border border-[#b7ebd0] bg-[#dcfae5] text-[#04250e]',
  amber: 'border border-[#fde68a] bg-[#fffbeb] text-[#92400e]',
  red: 'border border-[#f5c2c0] bg-[#ffedea] text-[#831c1e]',
  slate: 'border border-[#e6e6e6] bg-[#eeeeee] text-[#3d3d3d]',
};

const TONE_DOT: Record<Tone, string> = {
  green: 'bg-[#2e7d32]',
  amber: 'bg-[#92400e]',
  red: 'bg-[#c4242a]',
  slate: 'bg-[#6b6b6b]',
};

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2 text-[11px] font-medium ${TONE_BADGE[tone]}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[tone]}`} />
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
      className="grid gap-1 rounded-[8px] border border-[#e6e6e6] bg-[#eeeeee] p-1"
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
                ? 'border-[#e6e6e6] bg-white text-[#0a0a0a]'
                : 'border-transparent text-[#6b6b6b] hover:text-[#0a0a0a]'
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
          ? 'border-[#f5c2c0] bg-[#ffedea] text-[#831c1e]'
          : 'border-[#b7ebd0] bg-[#dcfae5] text-[#04250e]'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={`h-2 w-2 shrink-0 rounded-full ${isError ? 'bg-[#c4242a]' : 'bg-[#2e7d32]'}`}
        />
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
      <p className="text-[14px] font-medium text-[#6b6b6b]">{text}</p>
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
    <div className="no-print fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <button
        type="button"
        aria-label="Tutup"
        onClick={onClose}
        className="absolute inset-0 bg-[#0a0a0a]/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-[12px] border border-[#e6e6e6] bg-white sm:rounded-[10px]"
      >
        <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-[#d4d4d4] sm:hidden" />
        <div className="flex items-center justify-between border-b border-[#e6e6e6] bg-[#f8f9fa] px-4 py-3">
          <h2 className="text-[15px] font-medium text-[#0a0a0a]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup"
            className="flex h-7 w-7 items-center justify-center rounded-[6px] border border-[#d4d4d4] bg-white text-base text-[#6b6b6b] hover:bg-[#f2f4f7] hover:text-[#0a0a0a]"
          >
            ×
          </button>
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
    tone === 'red' ? 'text-[#c4242a]' : tone === 'green' ? 'text-[#2e7d32]' : 'text-[#0a0a0a]';
  return (
    <div className={`flex items-baseline justify-between gap-3 py-0.5 ${strong ? 'font-bold' : ''}`}>
      <span className={`min-w-0 truncate text-[13px] ${tone ? color : 'text-[#6b6b6b]'}`}>{label}</span>
      <span className={`shrink-0 tabular-nums ${strong ? 'text-[15px] font-bold' : 'text-[14px] font-medium'} ${color}`}>
        {value}
      </span>
    </div>
  );
}
