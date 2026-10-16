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

export interface ReconcileDeliveryItemInput {
  supplier_batch_id: string;
  qty_dispatched_kg: number;
  qty_accepted_kg: number;
  supplier_actual_cost_snapshot: number;
  kitchen_unit_price_snapshot: number;
}

export interface ReconcileDeliveryItemResult {
  supplier_batch_id: string;
  qty_dispatched_kg: number;
  qty_accepted_kg: number;
  qty_shrinkage_kg: number;
  supplier_actual_cost_snapshot: number;
  kitchen_unit_price_snapshot: number;
  kitchen_line_total: number;
  supplier_gross_payable: number;
  supplier_shrinkage_deduction: number;
  supplier_net_payable: number;
}

/**
 * a) reconcileKitchenDeliveryItem
 * Enforces Invariant 1 (Precision kg & IDR), Invariant 2 (Zero-Shrinkage Risk / Supplier bears 100% shrinkage),
 * and Invariant 3 (Actual Batch Costing & Immutable Snapshot).
 */
export function reconcileKitchenDeliveryItem(
  input: ReconcileDeliveryItemInput
): ReconcileDeliveryItemResult {
  if (!input.supplier_batch_id || input.supplier_batch_id.trim() === '') {
    throw new Error('Invariant 3 Violation: supplier_batch_id is required');
  }

  const dispatchedGrams = kgToGrams(input.qty_dispatched_kg);
  const acceptedGrams = kgToGrams(input.qty_accepted_kg);

  if (dispatchedGrams <= 0n) {
    throw new Error('Invariant 1/2 Violation: qty_dispatched_kg must be greater than 0');
  }
  if (acceptedGrams < 0n) {
    throw new Error('Invariant 2 Violation: qty_accepted_kg cannot be negative');
  }
  if (acceptedGrams > dispatchedGrams) {
    throw new Error(
      'Invariant 2 Violation: qty_shrinkage_kg cannot be negative (qty_accepted_kg exceeds qty_dispatched_kg)'
    );
  }

  const supplierCostSen = idrToSen(input.supplier_actual_cost_snapshot);
  const kitchenPriceSen = idrToSen(input.kitchen_unit_price_snapshot);

  if (supplierCostSen <= 0n) {
    throw new Error('Invariant 3 Violation: supplier_actual_cost_snapshot must be greater than 0');
  }
  if (kitchenPriceSen < supplierCostSen) {
    throw new Error(
      'Invariant 3 Violation: kitchen_unit_price_snapshot cannot be lower than supplier_actual_cost_snapshot'
    );
  }

  const shrinkageGrams = dispatchedGrams - acceptedGrams;

  const kitchenLineTotalSen = multiplyWeightGramsByPriceSen(acceptedGrams, kitchenPriceSen);
  const supplierGrossPayableSen = multiplyWeightGramsByPriceSen(dispatchedGrams, supplierCostSen);
  const supplierShrinkageDeductionSen = multiplyWeightGramsByPriceSen(
    shrinkageGrams,
    supplierCostSen
  );
  const supplierNetPayableSen = multiplyWeightGramsByPriceSen(acceptedGrams, supplierCostSen);

  return {
    supplier_batch_id: input.supplier_batch_id,
    qty_dispatched_kg: gramsToKg(dispatchedGrams),
    qty_accepted_kg: gramsToKg(acceptedGrams),
    qty_shrinkage_kg: gramsToKg(shrinkageGrams),
    supplier_actual_cost_snapshot: senToIdr(supplierCostSen),
    kitchen_unit_price_snapshot: senToIdr(kitchenPriceSen),
    kitchen_line_total: senToIdr(kitchenLineTotalSen),
    supplier_gross_payable: senToIdr(supplierGrossPayableSen),
    supplier_shrinkage_deduction: senToIdr(supplierShrinkageDeductionSen),
    supplier_net_payable: senToIdr(supplierNetPayableSen),
  };
}

export interface CalculateProfitSplitInput {
  qty_accepted_kg: number;
  supplier_actual_cost_snapshot: number;
  kitchen_unit_price_snapshot: number;
  team_share_pct: number;
  cooperative_share_pct: number;
  invoice_payment_status: InvoicePaymentStatus;
  amount_paid?: number;
  total_invoice_amount?: number;
}

export interface CalculateProfitSplitResult {
  qty_accepted_kg: number;
  unit_markup: number;
  total_markup: number;
  team_share_pct: number;
  cooperative_share_pct: number;
  team_share_amount: number;
  koperasi_share_amount: number;
  payout_status: LedgerPayoutStatus;
}

/**
 * b) calculateProfitSplitEntry
 * Enforces Invariant 1 (Exact sen arithmetic without Rp 0.01 rounding gap)
 * and Invariant 4 (Strict Cash-Basis Profit Sharing: LOCKED_UNPAID until invoice is PAID).
 */
export function calculateProfitSplitEntry(
  input: CalculateProfitSplitInput
): CalculateProfitSplitResult {
  const acceptedGrams = kgToGrams(input.qty_accepted_kg);
  if (acceptedGrams < 0n) {
    throw new Error('Invariant 1 Violation: qty_accepted_kg cannot be negative');
  }

  const supplierCostSen = idrToSen(input.supplier_actual_cost_snapshot);
  const kitchenPriceSen = idrToSen(input.kitchen_unit_price_snapshot);

  if (kitchenPriceSen < supplierCostSen) {
    throw new Error(
      'Invariant 3 Violation: kitchen_unit_price_snapshot cannot be lower than supplier_actual_cost_snapshot'
    );
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

  const unitMarkupSen = kitchenPriceSen - supplierCostSen;
  const totalMarkupSen = multiplyWeightGramsByPriceSen(acceptedGrams, unitMarkupSen);

  // Follow docs/01-domain-workflows-and-formulas.md Step 5:
  // cooperative_profit_amount = ROUND(total_markup_amount * (share_coop_pct / 100), 2)
  // team_profit_amount = total_markup_amount - cooperative_profit_amount
  const koperasiShareSen = divideHalfUp(totalMarkupSen * coopBp, 10000n);
  const teamShareSen = totalMarkupSen - koperasiShareSen;

  const payoutStatus: LedgerPayoutStatus =
    input.invoice_payment_status === 'PAID' ? 'AVAILABLE_FOR_PAYOUT' : 'LOCKED_UNPAID';

  return {
    qty_accepted_kg: gramsToKg(acceptedGrams),
    unit_markup: senToIdr(unitMarkupSen),
    total_markup: senToIdr(totalMarkupSen),
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
