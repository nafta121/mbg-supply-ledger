import { describe, expect, it } from 'vitest';
import {
  calculateProfitSplitEntry,
  reconcileKitchenDeliveryItem,
  sanitizeDeliveryForFieldTeam,
} from '../financial-engine';
import { createInitialSeedState } from '../mbg-store';
import type { InvoicePaymentStatus } from '../../types/mbg';

describe('MBG Financial Engine — 5 Business Invariants & Real Simulation (docs/01)', () => {
  const splitConfig = {
    team_share_pct: 60.0,
    cooperative_share_pct: 40.0,
  };

  const simulationDeliveries = [
    {
      kitchen: 'Dapur A',
      supplier_batch_id: 'SUP-A',
      qty_dispatched_kg: 50.0,
      qty_accepted_kg: 50.0,
      supplier_actual_cost_snapshot: 36000.0,
      kitchen_unit_price_snapshot: 40000.0,
      invoice_status: 'PAID' as InvoicePaymentStatus,
      expected_shrinkage_kg: 0.0,
      expected_kitchen_invoice: 2000000.0,
      expected_supplier_net_payable: 1800000.0,
      expected_supplier_claim: 0.0,
      expected_total_markup: 200000.0,
      expected_team_share: 120000.0,
      expected_coop_share: 80000.0,
      expected_ledger_status: 'AVAILABLE_FOR_PAYOUT',
    },
    {
      kitchen: 'Dapur B',
      supplier_batch_id: 'SUP-A',
      qty_dispatched_kg: 50.0,
      qty_accepted_kg: 49, // Susut 1 kg
      supplier_actual_cost_snapshot: 36000.0,
      kitchen_unit_price_snapshot: 40000.0,
      invoice_status: 'PAID' as InvoicePaymentStatus,
      expected_shrinkage_kg: 1,
      expected_kitchen_invoice: 1960000.0,
      expected_supplier_net_payable: 1764000.0,
      expected_supplier_claim: 36000.0,
      expected_total_markup: 196000.0,
      expected_team_share: 117600.0,
      expected_coop_share: 78400.0,
      expected_ledger_status: 'AVAILABLE_FOR_PAYOUT',
    },
    {
      kitchen: 'Dapur C',
      supplier_batch_id: 'SUP-A',
      qty_dispatched_kg: 50.0,
      qty_accepted_kg: 50.0,
      supplier_actual_cost_snapshot: 36000.0,
      kitchen_unit_price_snapshot: 40000.0,
      invoice_status: 'PARTIALLY_PAID' as InvoicePaymentStatus,
      expected_shrinkage_kg: 0.0,
      expected_kitchen_invoice: 2000000.0,
      expected_supplier_net_payable: 1800000.0,
      expected_supplier_claim: 0.0,
      expected_total_markup: 200000.0,
      expected_team_share: 120000.0,
      expected_coop_share: 80000.0,
      expected_ledger_status: 'LOCKED_UNPAID',
    },
    {
      kitchen: 'Dapur D',
      supplier_batch_id: 'SUP-B',
      qty_dispatched_kg: 50.0,
      qty_accepted_kg: 48, // Reject 2 kg
      supplier_actual_cost_snapshot: 37000.0,
      kitchen_unit_price_snapshot: 40000.0,
      invoice_status: 'PAID' as InvoicePaymentStatus,
      expected_shrinkage_kg: 2,
      expected_kitchen_invoice: 1920000.0,
      expected_supplier_net_payable: 1776000.0,
      expected_supplier_claim: 74000.0,
      expected_total_markup: 144000.0,
      expected_team_share: 86400.0,
      expected_coop_share: 57600.0,
      expected_ledger_status: 'AVAILABLE_FOR_PAYOUT',
    },
    {
      kitchen: 'Dapur E',
      supplier_batch_id: 'SUP-B',
      qty_dispatched_kg: 50.0,
      qty_accepted_kg: 50.0,
      supplier_actual_cost_snapshot: 37000.0,
      kitchen_unit_price_snapshot: 40000.0,
      invoice_status: 'UNPAID' as InvoicePaymentStatus,
      expected_shrinkage_kg: 0.0,
      expected_kitchen_invoice: 2000000.0,
      expected_supplier_net_payable: 1850000.0,
      expected_supplier_claim: 0.0,
      expected_total_markup: 150000.0,
      expected_team_share: 90000.0,
      expected_coop_share: 60000.0,
      expected_ledger_status: 'LOCKED_UNPAID',
    },
  ];

  it('reconciles 5 kitchens across 2 supplier batches with 3 kg total shrinkage (whole kg) (Table 1 of docs/01)', () => {
    let totalDispatchedKg = 0;
    let totalShrinkageKg = 0;
    let totalAcceptedKg = 0;
    let totalKitchenInvoice = 0;
    let totalSupplierNetPayable = 0;
    let totalSupplierClaim = 0;

    const batchTotals: Record<
      string,
      { gross: number; claim: number; net: number; acceptedKg: number; shrinkageKg: number }
    > = {
      'SUP-A': { gross: 0, claim: 0, net: 0, acceptedKg: 0, shrinkageKg: 0 },
      'SUP-B': { gross: 0, claim: 0, net: 0, acceptedKg: 0, shrinkageKg: 0 },
    };

    for (const row of simulationDeliveries) {
      const reconciled = reconcileKitchenDeliveryItem({
        supplier_batch_id: row.supplier_batch_id,
        qty_dispatched_kg: row.qty_dispatched_kg,
        qty_accepted_kg: row.qty_accepted_kg,
        supplier_actual_cost_snapshot: row.supplier_actual_cost_snapshot,
        kitchen_unit_price_snapshot: row.kitchen_unit_price_snapshot,
      });

      expect(reconciled.qty_shrinkage_kg).toBe(row.expected_shrinkage_kg);
      expect(reconciled.kitchen_line_total).toBe(row.expected_kitchen_invoice);
      expect(reconciled.supplier_net_payable).toBe(row.expected_supplier_net_payable);
      expect(reconciled.supplier_shrinkage_deduction).toBe(row.expected_supplier_claim);
      expect(reconciled.supplier_gross_payable - reconciled.supplier_shrinkage_deduction).toBe(
        reconciled.supplier_net_payable
      );

      totalDispatchedKg += reconciled.qty_dispatched_kg;
      totalShrinkageKg += reconciled.qty_shrinkage_kg;
      totalAcceptedKg += reconciled.qty_accepted_kg;
      totalKitchenInvoice += reconciled.kitchen_line_total;
      totalSupplierNetPayable += reconciled.supplier_net_payable;
      totalSupplierClaim += reconciled.supplier_shrinkage_deduction;

      const batchBucket = batchTotals[row.supplier_batch_id];
      if (batchBucket) {
        batchBucket.gross += reconciled.supplier_gross_payable;
        batchBucket.claim += reconciled.supplier_shrinkage_deduction;
        batchBucket.net += reconciled.supplier_net_payable;
        batchBucket.acceptedKg += reconciled.qty_accepted_kg;
        batchBucket.shrinkageKg += reconciled.qty_shrinkage_kg;
      }
    }

    // Aggregate verification against Table 1 in docs/01-domain-workflows-and-formulas.md
    expect(totalDispatchedKg).toBe(250.0);
    expect(totalShrinkageKg).toBe(3.0);
    expect(totalAcceptedKg).toBe(247.0);
    expect(totalKitchenInvoice).toBe(9880000.0);
    expect(totalSupplierNetPayable).toBe(8990000.0);
    expect(totalSupplierClaim).toBe(110000.0);

    // Supplier Batch SUP-A settlement verification (CV Tani Makmur)
    expect(batchTotals['SUP-A']?.acceptedKg).toBe(149);
    expect(batchTotals['SUP-A']?.shrinkageKg).toBe(1);
    expect(batchTotals['SUP-A']?.gross).toBe(5400000.0);
    expect(batchTotals['SUP-A']?.claim).toBe(36000.0);
    expect(batchTotals['SUP-A']?.net).toBe(5364000.0);

    // Supplier Batch SUP-B settlement verification (UD Berkah Unggas)
    expect(batchTotals['SUP-B']?.acceptedKg).toBe(98);
    expect(batchTotals['SUP-B']?.shrinkageKg).toBe(2);
    expect(batchTotals['SUP-B']?.gross).toBe(3700000.0);
    expect(batchTotals['SUP-B']?.claim).toBe(74000.0);
    expect(batchTotals['SUP-B']?.net).toBe(3626000.0);
  });

  it('calculates profit-sharing ledger & enforces LOCKED_UNPAID vs AVAILABLE_FOR_PAYOUT on PAID transition (Table 2 of docs/01)', () => {
    let availableTeamTotal = 0;
    let availableCoopTotal = 0;
    let lockedTeamTotal = 0;
    let lockedCoopTotal = 0;

    for (const row of simulationDeliveries) {
      const split = calculateProfitSplitEntry({
        qty_accepted_kg: row.qty_accepted_kg,
        supplier_actual_cost_snapshot: row.supplier_actual_cost_snapshot,
        kitchen_unit_price_snapshot: row.kitchen_unit_price_snapshot,
        team_share_pct: splitConfig.team_share_pct,
        cooperative_share_pct: splitConfig.cooperative_share_pct,
        invoice_payment_status: row.invoice_status,
      });

      expect(split.total_markup).toBe(row.expected_total_markup);
      expect(split.team_share_amount).toBe(row.expected_team_share);
      expect(split.koperasi_share_amount).toBe(row.expected_coop_share);
      expect(split.team_share_amount + split.koperasi_share_amount).toBe(split.total_markup);
      expect(split.payout_status).toBe(row.expected_ledger_status);

      if (split.payout_status === 'AVAILABLE_FOR_PAYOUT') {
        availableTeamTotal += split.team_share_amount;
        availableCoopTotal += split.koperasi_share_amount;
      } else {
        lockedTeamTotal += split.team_share_amount;
        lockedCoopTotal += split.koperasi_share_amount;
      }
    }

    // Verify exact cash position from docs/01-domain-workflows-and-formulas.md
    expect(availableTeamTotal).toBe(324000.0);
    expect(availableCoopTotal).toBe(216000.0);
    expect(availableTeamTotal + availableCoopTotal).toBe(540000.0);

    expect(lockedTeamTotal).toBe(210000.0);
    expect(lockedCoopTotal).toBe(140000.0);
    expect(lockedTeamTotal + lockedCoopTotal).toBe(350000.0);

    // Simulate Dapur C & Dapur E transitioning from PARTIALLY_PAID / UNPAID -> PAID
    const dapurCAfterPaid = calculateProfitSplitEntry({
      qty_accepted_kg: 50.0,
      supplier_actual_cost_snapshot: 36000.0,
      kitchen_unit_price_snapshot: 40000.0,
      team_share_pct: 60.0,
      cooperative_share_pct: 40.0,
      invoice_payment_status: 'PAID',
      amount_paid: 2000000.0,
      total_invoice_amount: 2000000.0,
    });
    expect(dapurCAfterPaid.payout_status).toBe('AVAILABLE_FOR_PAYOUT');
  });

  it('rejects negative shrinkage or negative markup violations (Invariants 2 & 3)', () => {
    expect(() =>
      reconcileKitchenDeliveryItem({
        supplier_batch_id: 'SUP-A',
        qty_dispatched_kg: 50.0,
        qty_accepted_kg: 51, // Exceeds dispatched
        supplier_actual_cost_snapshot: 36000.0,
        kitchen_unit_price_snapshot: 40000.0,
      })
    ).toThrow(/qty_shrinkage_kg cannot be negative/);

    expect(() =>
      reconcileKitchenDeliveryItem({
        supplier_batch_id: 'SUP-A',
        qty_dispatched_kg: 50.0,
        qty_accepted_kg: 50.0,
        supplier_actual_cost_snapshot: 36000.0,
        kitchen_unit_price_snapshot: 35000.0, // Below actual cost
      })
    ).toThrow(/cannot be lower than supplier_actual_cost_snapshot/);
  });

  it('strips all cost, price, and markup attributes for FIELD_TEAM (Invariant 5 / v_safe_delivery_items_bast)', () => {
    const rawDeliveryRecord = {
      id: 'item-delivery-002',
      delivery_id: 'deliv-002',
      delivery_number: 'SJ-20261016-DPR02',
      delivery_date: '2026-10-16',
      kitchen_id: 'kitchen-02',
      kitchen_name: 'Dapur B',
      item_id: 'item-ayam-fillet',
      item_name: 'Dada Ayam Fillet',
      base_unit: 'kg' as const,
      supplier_batch_id: 'SUP-A',
      qty_dispatched_kg: 50.0,
      qty_accepted_kg: 49,
      supplier_actual_cost_snapshot: 36000.0,
      kitchen_unit_price_snapshot: 40000.0,
      line_invoice_amount: 1960000.0,
      line_supplier_payable_amount: 1764000.0,
      line_supplier_claim_amount: 36000.0,
      line_total_markup_amount: 196000.0,
      rejection_reason: 'Susut perjalanan 1 kg',
    };

    const safeRecord = sanitizeDeliveryForFieldTeam(rawDeliveryRecord);

    expect(safeRecord).toEqual({
      delivery_item_id: 'item-delivery-002',
      delivery_id: 'deliv-002',
      delivery_number: 'SJ-20261016-DPR02',
      delivery_date: '2026-10-16',
      kitchen_id: 'kitchen-02',
      kitchen_name: 'Dapur B',
      item_id: 'item-ayam-fillet',
      item_name: 'Dada Ayam Fillet',
      base_unit: 'kg',
      qty_dispatched_kg: 50.0,
      qty_accepted_kg: 49,
      qty_shrinkage_kg: 1,
      rejection_reason: 'Susut perjalanan 1 kg',
    });

    expect('supplier_actual_cost_snapshot' in safeRecord).toBe(false);
    expect('kitchen_unit_price_snapshot' in safeRecord).toBe(false);
    expect('line_invoice_amount' in safeRecord).toBe(false);
    expect('line_supplier_payable_amount' in safeRecord).toBe(false);
    expect('line_total_markup_amount' in safeRecord).toBe(false);
  });

  it('seeds 25 MBG kitchens, 3 suppliers, 5 kg commodities, and exact docs/01 transactions in mbg-store', () => {
    const seed = createInitialSeedState();
    expect(seed.kitchens).toHaveLength(25);
    expect(seed.suppliers).toHaveLength(3);
    expect(seed.items).toHaveLength(5);
    expect(seed.items.every((i) => i.base_unit === 'kg')).toBe(true);

    // Check supplier settlements match SUP-A (5,364,000 net) and SUP-B (3,626,000 net) — whole-kg seed
    const supASettlement = seed.supplierSettlements.find((s) => s.supplier_id === 'sup-a');
    const supBSettlement = seed.supplierSettlements.find((s) => s.supplier_id === 'sup-b');
    expect(supASettlement?.net_payable_amount).toBe(5364000.0);
    expect(supASettlement?.shrinkage_claim_deduction_amount).toBe(36000.0);
    expect(supBSettlement?.net_payable_amount).toBe(3626000.0);
    expect(supBSettlement?.shrinkage_claim_deduction_amount).toBe(74000.0);
  });
});

