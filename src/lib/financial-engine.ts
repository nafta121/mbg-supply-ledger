/**
 * MBG Supply Chain Financial Engine
 *
 * Core business invariants:
 * 1. Weight is calculated in grams (integer) to avoid float precision issues.
 * 2. Money is in IDR (integer).
 */

/**
 * Calculate the net amount payable to the supplier based on accepted weight only.
 * @param qtyAcceptedGrams - The actual accepted weight in grams (e.g., 10500 for 10.5 kg).
 * @param supplierActualCostSnapshot - The cost per kg from the supplier batch.
 * @returns The total amount payable to the supplier in IDR.
 */
export function calculateSupplierSettlement(qtyAcceptedGrams: number, supplierActualCostSnapshot: number): number {
  // Formula: (qtyAcceptedGrams / 1000) * supplierActualCostSnapshot
  return Math.round((qtyAcceptedGrams * supplierActualCostSnapshot) / 1000);
}

/**
 * Calculate the total invoice amount to be billed to the kitchen based on accepted weight.
 * @param qtyAcceptedGrams - The actual accepted weight in grams.
 * @param kitchenUnitPriceSnapshot - The selling price per kg to the kitchen.
 * @returns The total invoice amount in IDR.
 */
export function calculateKitchenInvoice(qtyAcceptedGrams: number, kitchenUnitPriceSnapshot: number): number {
  return Math.round((qtyAcceptedGrams * kitchenUnitPriceSnapshot) / 1000);
}

/**
 * Calculate the profit split based on cash-basis markup.
 * @param qtyAcceptedGrams - The actual accepted weight in grams.
 * @param supplierActualCostSnapshot - The cost per kg from the supplier batch.
 * @param kitchenUnitPriceSnapshot - The selling price per kg to the kitchen.
 * @param teamSharePct - Percentage share for the team (0-100).
 * @param koperasiSharePct - Percentage share for the Koperasi (0-100).
 * @returns The total markup and the respective split amounts.
 */
export function calculateProfitSplit(
  qtyAcceptedGrams: number,
  supplierActualCostSnapshot: number,
  kitchenUnitPriceSnapshot: number,
  teamSharePct: number,
  koperasiSharePct: number
): {
  totalMarkup: number;
  teamShareAmount: number;
  koperasiShareAmount: number;
} {
  if (teamSharePct + koperasiSharePct !== 100) {
    throw new Error("Profit split percentages must add up to 100");
  }

  const totalMarkup = Math.round((qtyAcceptedGrams * (kitchenUnitPriceSnapshot - supplierActualCostSnapshot)) / 1000);

  const teamShareAmount = Math.round(totalMarkup * (teamSharePct / 100));
  const koperasiShareAmount = totalMarkup - teamShareAmount; // ensures exact total match

  return {
    totalMarkup,
    teamShareAmount,
    koperasiShareAmount,
  };
}

export type InvoicePaymentStatus = 'DRAFT' | 'ISSUED' | 'PARTIAL' | 'PAID';
export type ProfitLedgerStatus = 'LOCKED_UNPAID' | 'AVAILABLE_FOR_PAYOUT';

/**
 * Determine the payout status of a profit ledger entry based on the kitchen invoice payment status.
 * @param invoicePaymentStatus - The current payment status of the kitchen invoice.
 * @returns The profit ledger payout status.
 */
export function getProfitLedgerStatus(invoicePaymentStatus: InvoicePaymentStatus): ProfitLedgerStatus {
  return invoicePaymentStatus === 'PAID' ? 'AVAILABLE_FOR_PAYOUT' : 'LOCKED_UNPAID';
}
