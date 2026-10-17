/**
 * UI-only helpers: operational labels (zero-jargon) and exact fixed-point
 * aggregation for on-screen totals. Business formulas stay in
 * `financial-engine.ts` / `mbg-store.ts`; these helpers never recompute
 * invoice, payable, or profit-share amounts — they only sum/format values
 * the store already produced (Invariant 1: no raw float accumulation).
 */
import type { InvoicePaymentStatus, LedgerPayoutStatus, OrderProgress, UserRole } from '../types/mbg';
import { gramsToKg, idrToSen, kgToGrams, senToIdr, toWholeKg } from './financial-engine';
import { formatIdr } from './mbg-store';

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

/** Parse a user-typed kg string into a safe WHOLE-kg number (invalid / ≤ 0 → 0). */
export function parseKgInput(raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return 0;
  return toWholeKg(n);
}

/** Whole-kg text input only (Invariant 1): "35" ok, "35.5" / "-1" / "" → null. */
export function parseWholeKgInput(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}

/** Typed rupiah text → whole rupiah: "14.000" / "Rp 14.000" → 14000, "" → 0. */
export function parseRpInput(raw: string | null | undefined): number {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits ? Number(digits) : 0;
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
 * `50` — kg number without unit as a WHOLE number (Stage 7 Invariant 1).
 * Never prints decimals or thousand separators: in Indonesia `50.000 kg`
 * reads as "fifty thousand kg".
 */
export function formatKgNum(kg: number): string {
  return String(toWholeKg(kg));
}

/** `50 kg`, `-3 kg` — whole-kg weight with unit. */
export function formatKg(kg: number): string {
  return `${formatKgNum(kg)} kg`;
}

/** Shrinkage shown as a deduction: 1 → `-1`, 0 → `0` (whole kg, no unit). */
export function formatShrinkKgNum(shrinkKg: number): string {
  const whole = toWholeKg(shrinkKg);
  return whole > 0 ? `-${whole}` : String(whole);
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
