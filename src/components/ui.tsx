'use client';

import React, { useEffect, useRef } from 'react';
import type { Tone } from '../lib/ui-format';

const TONE_BADGE: Record<Tone, string> = {
  green: 'bg-[#dcfae5] text-[#04250e]',
  amber: 'bg-[#fffbeb] text-[#92400e] ring-1 ring-inset ring-[#fde68a]',
  red: 'bg-[#ffedea] text-[#831c1e]',
  slate: 'bg-[#eeeeee] text-[#3d3d3d]',
};

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-[4px] px-2 text-[11px] font-medium ${TONE_BADGE[tone]}`}
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
            className={`min-h-[34px] truncate rounded-[6px] px-2 text-[13px] font-medium transition-colors ${
              active ? 'bg-white text-[#0a0a0a]' : 'text-[#6b6b6b] hover:text-[#0a0a0a]'
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
      className={`flex items-center justify-between gap-3 rounded-[6px] border px-3 py-2 text-[13px] font-medium ${
        isError
          ? 'border-[#f5c2c0] bg-[#ffedea] text-[#831c1e]'
          : 'border-[#b7ebd0] bg-[#dcfae5] text-[#04250e]'
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
    <div className="no-print fixed inset-0 z-50 flex items-end justify-center">
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
        className="relative max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-[12px] border-t border-[#e6e6e6] bg-white p-4 pb-6"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[#d4d4d4]" />
        <div className="mb-3 flex items-center justify-between border-b border-[#f0f0f0] pb-2.5">
          <h2 className="text-[16px] font-medium text-[#0a0a0a]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup"
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-lg text-[#6b6b6b] hover:bg-[#f2f4f7]"
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
