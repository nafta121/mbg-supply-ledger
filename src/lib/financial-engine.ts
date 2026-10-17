import type {
  InvoicePaymentStatus,
  KitchenDeliveryItem,
  LedgerPayoutStatus,
  SafeDeliveryItemBastView,
} from '../types/mbg';

/**
 * Precision Fixed-Point Arithmetic Helpers (Invariant 1)
 * - Weight: 1 kg = 1,000 grams (integer `BigInt`)
 * - Currency: 1 IDR = 100 sen (integer `BigInt`)
 * - Percentage: 1% = 100 basis points (`NUMERIC(5,2)` -> integer `BigInt`)
 */

export function kgToGrams(kg: number | string): bigint {
  const num = typeof kg === 'string' ? Number(kg) : kg;
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid weight value in kg: ${String(kg)}`);
  }
  return BigInt(Math.round(num * 1000));
}

export function gramsToKg(grams: bigint): number {
  return Number(grams) / 1000;
}

/**
 * Rounds a kilogram quantity to at most 3 decimal places (`NUMERIC(12,3)` / gram precision)
 * to prevent IEEE-754 floating-point drift (e.g. `0.1 + 0.2 = 0.3`).
 * Accepts numbers or strings with `.` or `,` as decimal separator.
 * Never returns `-0`; invalid input → `0`.
 */
export function roundKg(kg: number | string): number {
  const normalized =
    typeof kg === 'string' ? Number(kg.trim().replace(/\s*kg$/i, '').replace(/,/g, '.')) : kg;
  if (!Number.isFinite(normalized)) return 0;
  const rounded = Math.round(normalized * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Backward-compatible alias for `roundKg` (3-decimal dynamic kg precision). */
export function toWholeKg(kg: number | string): number {
  return roundKg(kg);
}

export function idrToSen(idr: number | string): bigint {
  const num = typeof idr === 'string' ? Number(idr) : idr;
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid currency value in IDR: ${String(idr)}`);
  }
  return BigInt(Math.round(num * 100));
}

export function senToIdr(sen: bigint): number {
  return Number(sen) / 100;
}

export function pctToBasisPoints(pct: number | string): bigint {
  const num = typeof pct === 'string' ? Number(pct) : pct;
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid percentage value: ${String(pct)}`);
  }
  return BigInt(Math.round(num * 100));
}

/**
 * Half-up division for non-negative BigInt values: ROUND(numerator / denominator)
 */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error('Denominator must be positive');
  }
  if (numerator >= 0n) {
    return (numerator + denominator / 2n) / denominator;
  }
  return -((-numerator + denominator / 2n) / denominator);
}

/**
 * Multiplies weight in grams (`10^-3 kg`) by unit price in sen (`10^-2 IDR`)
 * and rounds half-up to integer sen (`NUMERIC(15,2)`).
 * Formula: ROUND((grams * price_sen) / 1000)
 */
export function multiplyWeightGramsByPriceSen(grams: bigint, unitPriceSen: bigint): bigint {
  return divideHalfUp(grams * unitPriceSen, 1000n);
}

export interface ReconcileOrderLineInput {
  /** Berat Order = Berat Kirim (kg, supports decimals up to 3 places e.g. 12.5 or 0.2). */
  qty_ordered_kg: number;
  /** Berat diterima dapur saat BAST (kg, supports decimals up to 3 places). */
  qty_accepted_kg: number;
  /** Harga Dapur / kg (sudah termasuk markup). */
  kitchen_unit_price_rp: number;
  /** Margin / Bagian Kita per kg (dasar bagi hasil Tim & Koperasi). */
  margin_per_kg_rp: number;
}

export interface ReconcileOrderLineResult {
  qty_ordered_kg: number;
  qty_accepted_kg: number;
  qty_shrinkage_kg: number;
  kitchen_unit_price_rp: number;
  margin_per_kg_rp: number;
  line_invoice_amount: number;
  line_margin_amount: number;
}

/**
 * a) reconcileKitchenOrderLine
 * Stage 8 Order-Driven Flow. Enforces:
 * - Invariant 1: 3-decimal gram precision (`NUMERIC(12,3)`), exact sen arithmetic.
 * - Invariant 2: the kitchen is billed ONLY for `qty_accepted_kg`; the
 *   difference (selisih/reject) is never invoiced.
 * - Invariant 3: price & margin snapshots are validated (0 ≤ margin ≤ price).
 */
export function reconcileKitchenOrderLine(input: ReconcileOrderLineInput): ReconcileOrderLineResult {
  const orderedGrams = kgToGrams(input.qty_ordered_kg);
  const acceptedGrams = kgToGrams(input.qty_accepted_kg);

  if (orderedGrams <= 0n) {
    throw new Error('Invariant 1 Violation: qty_ordered_kg must be greater than 0');
  }
  if (acceptedGrams < 0n) {
    throw new Error('Invariant 2 Violation: qty_accepted_kg cannot be negative');
  }
  if (acceptedGrams > orderedGrams) {
    throw new Error('Invariant 2 Violation: qty_accepted_kg cannot exceed qty_ordered_kg');
  }

  const priceSen = idrToSen(input.kitchen_unit_price_rp);
  const marginSen = idrToSen(input.margin_per_kg_rp);
  if (priceSen <= 0n) {
    throw new Error('Invariant 3 Violation: kitchen_unit_price_rp must be greater than 0');
  }
  if (marginSen < 0n) {
    throw new Error('Invariant 3 Violation: margin_per_kg_rp cannot be negative');
  }
  if (marginSen > priceSen) {
    throw new Error('Invariant 3 Violation: margin_per_kg_rp cannot exceed kitchen_unit_price_rp');
  }

  return {
    qty_ordered_kg: gramsToKg(orderedGrams),
    qty_accepted_kg: gramsToKg(acceptedGrams),
    qty_shrinkage_kg: gramsToKg(orderedGrams - acceptedGrams),
    kitchen_unit_price_rp: senToIdr(priceSen),
    margin_per_kg_rp: senToIdr(marginSen),
    line_invoice_amount: senToIdr(multiplyWeightGramsByPriceSen(acceptedGrams, priceSen)),
    line_margin_amount: senToIdr(multiplyWeightGramsByPriceSen(acceptedGrams, marginSen)),
  };
}

export interface CalculateProfitSplitInput {
  qty_accepted_kg: number;
  margin_per_kg_rp: number;
  team_share_pct: number;
  cooperative_share_pct: number;
  invoice_payment_status: InvoicePaymentStatus;
  amount_paid?: number;
  total_invoice_amount?: number;
}

export interface CalculateProfitSplitResult {
  qty_accepted_kg: number;
  margin_per_kg: number;
  total_margin: number;
  team_share_pct: number;
  cooperative_share_pct: number;
  team_share_amount: number;
  koperasi_share_amount: number;
  payout_status: LedgerPayoutStatus;
}

/**
 * b) calculateProfitSplitEntry
 * Total bagi hasil per item = qty_accepted_kg × margin_per_kg, split Tim vs Koperasi.
 * Enforces Invariant 1 (exact sen arithmetic without Rp 0,01 rounding gap)
 * and Invariant 4 (Strict Cash-Basis: LOCKED_UNPAID until the invoice is PAID).
 */
export function calculateProfitSplitEntry(
  input: CalculateProfitSplitInput
): CalculateProfitSplitResult {
  const acceptedGrams = kgToGrams(input.qty_accepted_kg);
  if (acceptedGrams < 0n) {
    throw new Error('Invariant 1 Violation: qty_accepted_kg cannot be negative');
  }

  const marginSen = idrToSen(input.margin_per_kg_rp);
  if (marginSen < 0n) {
    throw new Error('Invariant 3 Violation: margin_per_kg_rp cannot be negative');
  }

  const teamBp = pctToBasisPoints(input.team_share_pct);
  const coopBp = pctToBasisPoints(input.cooperative_share_pct);

  if (teamBp < 0n || coopBp < 0n || teamBp + coopBp !== 10000n) {
    throw new Error(
      'Invariant 4 Violation: team_share_pct + cooperative_share_pct must equal 100.00%'
    );
  }

  if (input.invoice_payment_status === 'PAID') {
    if (
      input.amount_paid !== undefined &&
      input.total_invoice_amount !== undefined &&
      idrToSen(input.amount_paid) < idrToSen(input.total_invoice_amount)
    ) {
      throw new Error(
        'Invariant 4 Violation: Invoice cannot be marked PAID when amount_paid < total_invoice_amount'
      );
    }
  }

  const totalMarginSen = multiplyWeightGramsByPriceSen(acceptedGrams, marginSen);

  // cooperative_profit_amount = ROUND(total_margin * (share_coop_pct / 100), 2)
  // team_profit_amount = total_margin - cooperative_profit_amount (no Rp 0,01 gap)
  const koperasiShareSen = divideHalfUp(totalMarginSen * coopBp, 10000n);
  const teamShareSen = totalMarginSen - koperasiShareSen;

  const payoutStatus: LedgerPayoutStatus =
    input.invoice_payment_status === 'PAID' ? 'AVAILABLE_FOR_PAYOUT' : 'LOCKED_UNPAID';

  return {
    qty_accepted_kg: gramsToKg(acceptedGrams),
    margin_per_kg: senToIdr(marginSen),
    total_margin: senToIdr(totalMarginSen),
    team_share_pct: Number(teamBp) / 100,
    cooperative_share_pct: Number(coopBp) / 100,
    team_share_amount: senToIdr(teamShareSen),
    koperasi_share_amount: senToIdr(koperasiShareSen),
    payout_status: payoutStatus,
  };
}

export interface FullDeliveryItemWithContext
  extends Partial<KitchenDeliveryItem>,
    Record<string, unknown> {
  id?: string;
  delivery_item_id?: string;
  delivery_id: string;
  delivery_number: string;
  delivery_date: string;
  kitchen_id: string;
  kitchen_name: string;
  item_id: string;
  item_name: string;
  base_unit?: 'kg';
  qty_dispatched_kg: number;
  qty_accepted_kg: number;
  qty_shrinkage_kg?: number;
  rejection_reason?: string | null;
}

/**
 * c) sanitizeDeliveryForFieldTeam
 * Enforces Invariant 5 (Strict RBAC for FIELD_TEAM) by mirroring `public.v_safe_delivery_items_bast`.
 * Strips all supplier cost, kitchen unit price, invoice totals, and markup fields.
 */
export function sanitizeDeliveryForFieldTeam(
  record: FullDeliveryItemWithContext
): SafeDeliveryItemBastView {
  const deliveryItemId = record.delivery_item_id ?? record.id;
  if (!deliveryItemId) {
    throw new Error('delivery_item_id or id is required to sanitize delivery item for FIELD_TEAM');
  }

  const dispatchedGrams = kgToGrams(record.qty_dispatched_kg);
  const acceptedGrams = kgToGrams(record.qty_accepted_kg);
  const shrinkageGrams =
    record.qty_shrinkage_kg !== undefined
      ? kgToGrams(record.qty_shrinkage_kg)
      : dispatchedGrams - acceptedGrams;

  return {
    delivery_item_id: deliveryItemId,
    delivery_id: record.delivery_id,
    delivery_number: record.delivery_number,
    delivery_date: record.delivery_date,
    kitchen_id: record.kitchen_id,
    kitchen_name: record.kitchen_name,
    item_id: record.item_id,
    item_name: record.item_name,
    base_unit: 'kg',
    qty_dispatched_kg: gramsToKg(dispatchedGrams),
    qty_accepted_kg: gramsToKg(acceptedGrams),
    qty_shrinkage_kg: gramsToKg(shrinkageGrams),
    rejection_reason: record.rejection_reason ?? null,
  };
}
