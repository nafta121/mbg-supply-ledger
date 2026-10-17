/**
 * UI-only helpers: operational labels (zero-jargon) and exact fixed-point
 * aggregation for on-screen totals. Business formulas stay in
 * `financial-engine.ts` / `mbg-store.ts`; these helpers never recompute
 * invoice, payable, or profit-share amounts — they only sum/format values
 * the store already produced (Invariant 1: no raw float accumulation).
 */
import type {
  InvoicePaymentStatus,
  LedgerPayoutStatus,
  SettlementStatus,
  UserRole,
} from '../types/mbg';
import { gramsToKg, idrToSen, kgToGrams, senToIdr } from './financial-engine';
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

/** Parse a user-typed kg string into a safe, gram-rounded number (invalid → 0). */
export function parseKgInput(raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return 0;
  return gramsToKg(kgToGrams(n));
}

// ---------- Display formatting ----------

/** `Rp 2.000.000` (drops `,00` when there are no sen). */
export function formatRp(idr: number): string {
  return formatIdr(idr).replace(/\u00a0/g, ' ').replace(/,00$/, '');
}

/** `50.000` — kg number without unit, 3 decimals (gram precision). */
export function formatKgNum(kg: number): string {
  return gramsToKg(kgToGrams(kg)).toFixed(3);
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
  AVAILABLE_FOR_PAYOUT: 'Siap Cair',
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

export const SETTLEMENT_LABEL: Record<SettlementStatus, string> = {
  PENDING_BAST: 'Menunggu Timbang',
  READY_TO_PAY: 'Belum Dibayar',
  PAID: 'Sudah Dibayar',
};

export type Tone = 'green' | 'amber' | 'red' | 'slate';

export function invoiceTone(status: InvoicePaymentStatus): Tone {
  return status === 'PAID' ? 'green' : 'red';
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
