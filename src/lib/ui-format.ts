/**
 * UI-only helpers: operational labels (zero-jargon) and exact fixed-point
 * aggregation for on-screen totals. Business formulas stay in
 * `financial-engine.ts` / `mbg-store.ts`; these helpers never recompute
 * invoice, payable, or profit-share amounts — they only sum/format values
 * the store already produced (Invariant 1: no raw float accumulation).
 */
import type { InvoicePaymentStatus, LedgerPayoutStatus, OrderProgress, UserRole } from '../types/mbg';
import { gramsToKg, idrToSen, kgToGrams, roundKg, senToIdr } from './financial-engine';
import { formatIdr } from './mbg-store';

const ID_KG_FORMATTER = new Intl.NumberFormat('id-ID', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
  useGrouping: false,
});

// ---------- Exact aggregation (grams / sen BigInt) ----------

export function sumKg(values: number[]): number {
  let grams = 0n;
  for (const v of values) grams += kgToGrams(Number.isFinite(v) ? v : 0);
  return gramsToKg(grams);
}

export function sumIdr(values: number[]): number {
  let sen = 0n;
  for (const v of values) sen += idrToSen(Number.isFinite(v) ? v : 0);
  return senToIdr(sen);
}

export function subtractKg(a: number, b: number): number {
  return gramsToKg(kgToGrams(a) - kgToGrams(b));
}

export function addIdr(a: number, b: number): number {
  return senToIdr(idrToSen(a) + idrToSen(b));
}

/**
 * Parse a user-typed kg string or number (where BOTH `,` and `.` are decimal separators,
 * e.g. `"13.5"` -> `13.5`, `"13,5"` -> `13.5`, `"0.2"` -> `0.2`, `"0,2"` -> `0.2`, `"35"` -> `35`)
 * into a 3-decimal number (`Math.round(num * 1000) / 1000`).
 * Never share this parser with Rupiah inputs.
 */
export function parseKgInput(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 1000) / 1000 : 0;
  const trimmed = String(raw).trim();
  if (trimmed.startsWith('-')) return 0;
  const cleaned = trimmed.replace(/,/g, '.').replace(/[^0-9.]/g, '');
  if (!cleaned) return 0;
  const parts = cleaned.split('.');
  const normalized = parts.length > 1 ? `${parts[0] || '0'}.${parts.slice(1).join('')}` : (parts[0] ?? '');
  const num = Number.parseFloat(normalized);
  return Number.isFinite(num) && num > 0 ? Math.round(num * 1000) / 1000 : 0;
}

/**
 * Parse a courier/order decimal kg text input (`>= 0`, supports `,` or `.` and intermediate `"12,"` / `"0,"`).
 * Returns `null` when empty or invalid (`"-1"`, `"abc"`, `""`).
 */
export function parseAcceptedKgInput(raw: string): number | null {
  const cleaned = raw.trim().replace(/\s*kg$/i, '').trim().replace(/,/g, '.');
  if (!cleaned || !/^\d+(\.\d*)?$/.test(cleaned)) return null;
  const val = Number(cleaned);
  if (!Number.isFinite(val) || val < 0) return null;
  return Math.round(val * 1000) / 1000;
}

/** Backward-compatible alias for `parseAcceptedKgInput` (supports decimal kg `>= 0`). */
export function parseWholeKgInput(raw: string): number | null {
  return parseAcceptedKgInput(raw);
}

/**
 * Parse Rupiah input (`Harga Dapur/kg` like `"9.500"` or `Margin Kita/kg` like `"2.000"`),
 * where `.` is an Indonesian thousands separator, NOT a decimal point.
 * `"9.500"` or `"9500"` -> `9500`; `"2.000"` or `"2000"` -> `2000`.
 */
export function parseRpInput(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : 0;
  const digitsOnly = String(raw).replace(/[^0-9]/g, '');
  return digitsOnly ? Number.parseInt(digitsOnly, 10) : 0;
}

/** Returns today's date (`YYYY-MM-DD`) in Indonesian Western Time (`Asia/Jakarta` / WIB). */
export function getJakartaTodayYmd(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value ?? '2026';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

/** 14000 → "14.000" (thousand dots, no "Rp", for editable rupiah inputs). */
export function formatThousands(n: number): string {
  if (!Number.isFinite(n)) return '';
  return new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(Math.round(n));
}

// ---------- Display formatting ----------

/** `Rp 2.000.000` (drops `,00` when there are no sen). */
export function formatRp(idr: number): string {
  return formatIdr(idr).replace(/\u00a0/g, ' ').replace(/,00$/, '');
}

/**
 * Indonesian smart decimal kg number without unit:
 * - `50` → `"50"` (never `"50.000"` or `"50,000"`)
 * - `12.5` → `"12,5"`
 * - `0.2` → `"0,2"`
 * - `1.25` → `"1,25"`
 * - `-0.5` → `"-0,5"`
 */
export function formatKgNum(value: number): string {
  const clean = roundKg(value);
  return ID_KG_FORMATTER.format(clean).replace(/\u2212/g, '-');
}

/**
 * Indonesian smart decimal kg with unit:
 * `50` → `"50 kg"`, `12.5` → `"12,5 kg"`, `0.2` → `"0,2 kg"`, `1.25` → `"1,25 kg"`, `-0.5` → `"-0,5 kg"`.
 */
export function formatKg(value: number): string {
  return `${formatKgNum(value)} kg`;
}

/** Shrinkage shown as a deduction: `1` → `"-1"`, `0.5` → `"-0,5"`, `0` → `"0"` (no unit). */
export function formatShrinkKgNum(shrinkKg: number): string {
  const clean = roundKg(shrinkKg);
  return clean > 0 ? `-${formatKgNum(clean)}` : formatKgNum(clean);
}

/** "SPPG Dapur 01 - Tebet (Dapur A)" → "Tebet" */
export function shortKitchenName(name: string): string {
  const afterDash = name.includes(' - ') ? name.split(' - ').slice(1).join(' - ') : name;
  return afterDash.replace(/\s*\(.*?\)\s*/g, '').trim() || name;
}

// ---------- Operational labels (no technical codes on screen) ----------

export const ROLE_LABEL: Record<UserRole, string> = {
  OWNER_ADMIN: 'Admin',
  FINANCE: 'Keuangan',
  FIELD_TEAM: 'Tim Lapangan',
  COOPERATIVE_VIEWER: 'Koperasi',
};

export const PAYOUT_LABEL: Record<LedgerPayoutStatus, string> = {
  LOCKED_UNPAID: 'Menunggu Dapur Bayar',
  AVAILABLE_FOR_PAYOUT: 'Siap Dicairkan',
  PAID_OUT: 'Sudah Cair',
};

// Kitchen bills are shown with exactly 2 operational statuses: "Belum Bayar" / "Lunas".
// Any not-fully-paid state stays "Belum Bayar" (profit share remains locked — Invariant 4).
export const INVOICE_LABEL: Record<InvoicePaymentStatus, string> = {
  DRAFT: 'Belum Bayar',
  ISSUED: 'Belum Bayar',
  UNPAID: 'Belum Bayar',
  PARTIALLY_PAID: 'Belum Bayar',
  PAID: 'Lunas',
};

export const ORDER_PROGRESS_LABEL: Record<OrderProgress, string> = {
  WAITING_COURIER: 'Menunggu Kurir',
  PARTIALLY_WEIGHED: 'Sebagian Tertimbang',
  BAST_DONE: 'Selesai BAST',
};

export type Tone = 'green' | 'amber' | 'red' | 'slate';

export function invoiceTone(status: InvoicePaymentStatus): Tone {
  return status === 'PAID' ? 'green' : 'red';
}

export function orderProgressTone(p: OrderProgress): Tone {
  if (p === 'BAST_DONE') return 'green';
  if (p === 'PARTIALLY_WEIGHED') return 'amber';
  return 'slate';
}

export function payoutTone(status: LedgerPayoutStatus): Tone {
  if (status === 'AVAILABLE_FOR_PAYOUT') return 'green';
  if (status === 'PAID_OUT') return 'slate';
  return 'amber';
}

/** "0812-9000-0001" → "6281290000001" for wa.me links. */
export function toWaNumber(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) return `62${digits.slice(1)}`;
  return digits;
}
