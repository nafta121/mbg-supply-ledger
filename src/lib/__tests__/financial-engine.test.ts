import { describe, expect, it } from 'vitest';
import {
  calculateProfitSplitEntry,
  idrToSen,
  kgToGrams,
  multiplyWeightGramsByPriceSen,
  reconcileKitchenOrderLine,
  sanitizeDeliveryForFieldTeam,
  senToIdr,
} from '../financial-engine';
import type { InvoicePaymentStatus } from '../../types/mbg';

describe('MBG Financial Engine — Stage 8 order-driven invariants', () => {
  it('uses exact fixed-point arithmetic (grams × sen) without float drift', () => {
    expect(kgToGrams(35)).toBe(35000n);
    expect(idrToSen(14000)).toBe(1400000n);
    expect(senToIdr(multiplyWeightGramsByPriceSen(kgToGrams(33), idrToSen(14000)))).toBe(462000);
    expect(senToIdr(idrToSen(0.1) + idrToSen(0.2))).toBe(0.3);
  });

  it('bills the kitchen on qty_accepted_kg × Harga Dapur / kg (Invariant 2)', () => {
    // Wortel: order 35 kg, diterima 33 kg (reject 2 kg) @ Rp 14.000, margin Rp 2.000
    const r = reconcileKitchenOrderLine({
      qty_ordered_kg: 35,
      qty_accepted_kg: 33,
      kitchen_unit_price_rp: 14000,
      margin_per_kg_rp: 2000,
    });
    expect(r).toEqual({
      qty_ordered_kg: 35,
      qty_accepted_kg: 33,
      qty_shrinkage_kg: 2,
      kitchen_unit_price_rp: 14000,
      margin_per_kg_rp: 2000,
      line_invoice_amount: 462000, // NOT 35 × 14.000 = 490.000
      line_margin_amount: 66000,
    });

    const full = reconcileKitchenOrderLine({
      qty_ordered_kg: 25,
      qty_accepted_kg: 25,
      kitchen_unit_price_rp: 10000,
      margin_per_kg_rp: 1500,
    });
    expect(full.line_invoice_amount).toBe(250000);
    expect(full.line_margin_amount).toBe(37500);
    expect(full.qty_shrinkage_kg).toBe(0);

    // Decimal kg cases: 12.5 kg × Rp 14.000 = Rp 175.000; 0.2 kg × Rp 50.000 = Rp 10.000
    const dec1 = reconcileKitchenOrderLine({
      qty_ordered_kg: 12.5,
      qty_accepted_kg: 12.5,
      kitchen_unit_price_rp: 14000,
      margin_per_kg_rp: 2000,
    });
    expect(dec1.line_invoice_amount).toBe(175000);
    expect(dec1.line_margin_amount).toBe(25000);

    const dec2 = reconcileKitchenOrderLine({
      qty_ordered_kg: 0.2,
      qty_accepted_kg: 0.2,
      kitchen_unit_price_rp: 50000,
      margin_per_kg_rp: 5000,
    });
    expect(dec2.line_invoice_amount).toBe(10000);
    expect(dec2.line_margin_amount).toBe(1000);
  });

  it('rejects invalid order lines (qty <= 0, accepted > ordered, 0 <= margin <= price)', () => {
    const base = { qty_ordered_kg: 35, qty_accepted_kg: 35, kitchen_unit_price_rp: 14000, margin_per_kg_rp: 2000 };
    expect(() => reconcileKitchenOrderLine({ ...base, qty_ordered_kg: 0, qty_accepted_kg: 0 })).toThrow(/greater than 0/);
    expect(() => reconcileKitchenOrderLine({ ...base, qty_accepted_kg: 36 })).toThrow(/cannot exceed/);
    expect(() => reconcileKitchenOrderLine({ ...base, qty_accepted_kg: -1 })).toThrow(/negative/);
    expect(() => reconcileKitchenOrderLine({ ...base, kitchen_unit_price_rp: 0 })).toThrow(/greater than 0/);
    expect(() => reconcileKitchenOrderLine({ ...base, margin_per_kg_rp: -1 })).toThrow(/negative/);
    expect(() => reconcileKitchenOrderLine({ ...base, margin_per_kg_rp: 15000 })).toThrow(/cannot exceed/);
  });

  it('splits accepted kg × margin 60/40 and stays LOCKED_UNPAID until PAID (Invariant 4)', () => {
    const statuses: Array<[InvoicePaymentStatus, string]> = [
      ['ISSUED', 'LOCKED_UNPAID'],
      ['UNPAID', 'LOCKED_UNPAID'],
      ['PARTIALLY_PAID', 'LOCKED_UNPAID'],
      ['PAID', 'AVAILABLE_FOR_PAYOUT'],
    ];
    for (const [status, expected] of statuses) {
      const r = calculateProfitSplitEntry({
        qty_accepted_kg: 35,
        margin_per_kg_rp: 2000,
        team_share_pct: 60,
        cooperative_share_pct: 40,
        invoice_payment_status: status,
      });
      expect(r.total_margin).toBe(70000);
      expect(r.team_share_amount).toBe(42000);
      expect(r.koperasi_share_amount).toBe(28000);
      expect(r.payout_status).toBe(expected);
    }
  });

  it('never leaves a Rp 0,01 gap between Tim + Koperasi and the total margin', () => {
    const r = calculateProfitSplitEntry({
      qty_accepted_kg: 1,
      margin_per_kg_rp: 333.33,
      team_share_pct: 60,
      cooperative_share_pct: 40,
      invoice_payment_status: 'UNPAID',
    });
    expect(r.koperasi_share_amount).toBe(133.33);
    expect(r.team_share_amount).toBe(200);
    expect(idrToSen(r.team_share_amount) + idrToSen(r.koperasi_share_amount)).toBe(idrToSen(r.total_margin));
  });

  it('rejects invalid splits and a PAID status with an underpaid amount', () => {
    const base = { qty_accepted_kg: 10, margin_per_kg_rp: 1000, invoice_payment_status: 'UNPAID' as const };
    expect(() => calculateProfitSplitEntry({ ...base, team_share_pct: 60, cooperative_share_pct: 30 })).toThrow(/100.00%/);
    expect(() =>
      calculateProfitSplitEntry({
        ...base,
        team_share_pct: 60,
        cooperative_share_pct: 40,
        invoice_payment_status: 'PAID',
        amount_paid: 100,
        total_invoice_amount: 200,
      })
    ).toThrow(/amount_paid < total_invoice_amount/);
    expect(() =>
      calculateProfitSplitEntry({ ...base, margin_per_kg_rp: -5, team_share_pct: 60, cooperative_share_pct: 40 })
    ).toThrow(/negative/);
  });

  it('strips every price, invoice and margin attribute for FIELD_TEAM (Invariant 5)', () => {
    const safe = sanitizeDeliveryForFieldTeam({
      id: 'ditem-1',
      delivery_id: 'deliv-1',
      delivery_number: 'SJ-20261016-DPR01-01',
      delivery_date: '2026-10-16',
      kitchen_id: 'kitchen-01',
      kitchen_name: 'SPPG Dapur 01 - Tebet (Dapur A)',
      item_id: 'item-wortel',
      item_name: 'Wortel',
      qty_dispatched_kg: 35,
      qty_accepted_kg: 33,
      kitchen_unit_price_snapshot: 14000,
      margin_per_kg_snapshot: 2000,
      line_invoice_amount: 462000,
      line_margin_amount: 66000,
      rejection_reason: 'Barang Rusak/Reject',
    });
    expect(safe).toEqual({
      delivery_item_id: 'ditem-1',
      delivery_id: 'deliv-1',
      delivery_number: 'SJ-20261016-DPR01-01',
      delivery_date: '2026-10-16',
      kitchen_id: 'kitchen-01',
      kitchen_name: 'SPPG Dapur 01 - Tebet (Dapur A)',
      item_id: 'item-wortel',
      item_name: 'Wortel',
      base_unit: 'kg',
      qty_dispatched_kg: 35,
      qty_accepted_kg: 33,
      qty_shrinkage_kg: 2,
      rejection_reason: 'Barang Rusak/Reject',
    });
    const json = JSON.stringify(safe);
    for (const banned of ['price', 'margin', 'invoice', 'cost', 'markup']) {
      expect(json.toLowerCase()).not.toContain(banned);
    }
  });
});
