import { describe, expect, it } from 'vitest';
import { createInitialSeedState } from '../mbg-store';
import {
  type CourierKitchenOrderViewRow,
  fromCourierViewRows,
  fromSupabaseRows,
  toSupabaseRows,
} from '../supabase-sync';

describe('Supabase Sync Layer — Order-Driven Schema & Invariants', () => {
  it('round-trips initial seed state through Order-Driven Supabase rows losslessly', () => {
    const seed = createInitialSeedState();
    const rows = toSupabaseRows(seed);

    expect(rows.kitchens).toHaveLength(25);
    expect(rows.products).toHaveLength(5);
    expect(rows.orders).toHaveLength(5);
    expect(rows.orderItems).toHaveLength(11);
    expect(rows.invoices).toHaveLength(5);
    expect(rows.ledgerEntries).toHaveLength(11);

    // Invariant 1: All qty_ordered_kg and qty_accepted_kg must be whole integers
    for (const item of rows.orderItems) {
      expect(Number.isInteger(item.qty_ordered_kg)).toBe(true);
      if (item.qty_accepted_kg !== null) {
        expect(Number.isInteger(item.qty_accepted_kg)).toBe(true);
      } else {
        expect(item.is_weighed).toBe(false);
      }
    }

    // Invariant 4: Team + Cooperative amounts equal gross_margin_rp
    for (const ple of rows.ledgerEntries) {
      expect(Number(ple.team_amount_rp) + Number(ple.coop_amount_rp)).toBe(Number(ple.gross_margin_rp));
    }

    const restored = fromSupabaseRows({
      kitchens: rows.kitchens,
      products: rows.products,
      orders: rows.orders,
      orderItems: rows.orderItems,
      invoices: rows.invoices,
      ledgerEntries: rows.ledgerEntries,
      splitConfigs: [rows.splitConfig],
      payoutBatches: rows.payoutBatches,
    });

    expect(restored.kitchens).toHaveLength(25);
    expect(restored.items).toHaveLength(5);
    expect(restored.deliveries).toHaveLength(5);
    expect(restored.deliveryItems).toHaveLength(11);
    expect(restored.invoices).toHaveLength(5);
    expect(restored.ledgerEntries).toHaveLength(22);

    // Check DPR-03 Wortel: ordered 35, accepted 33, billed 462000
    const dpr03Inv = restored.invoices.find((i) => i.kitchen_id === 'kitchen-03')!;
    expect(dpr03Inv.total_invoice_amount).toBe(1212000);
    expect(dpr03Inv.payment_status).toBe('UNPAID');
  });

  it('maps v_courier_kitchen_orders rows without exposing any price or margin fields (Invariant 5)', () => {
    const viewRows: CourierKitchenOrderViewRow[] = [
      {
        order_item_id: 'ditem-09',
        order_id: 'deliv-07',
        order_code: 'SJ-20261016-DPR03-01',
        order_date: '2026-10-16',
        order_status: 'BAST_VERIFIED',
        kitchen_id: 'kitchen-03',
        kitchen_code: 'DPR-03',
        kitchen_name: 'SPPG Dapur 03 - Kalibata (Dapur C)',
        kitchen_pic_name: 'Hendra Wijaya',
        kitchen_pic_phone: '0812-9000-0003',
        product_id: 'item-wortel',
        product_name: 'Wortel',
        base_unit: 'kg',
        qty_ordered_kg: 35,
        qty_accepted_kg: 33,
        qty_shrinkage_kg: 2,
        is_weighed: true,
        shrinkage_reason: 'Barang Rusak/Reject',
        shrinkage_note: 'wortel patah/busuk',
        is_locked: false,
      },
    ];

    const safeItems = fromCourierViewRows(viewRows);
    expect(safeItems).toHaveLength(1);
    expect(safeItems[0]).toEqual({
      delivery_item_id: 'ditem-09',
      delivery_id: 'deliv-07',
      delivery_number: 'SJ-20261016-DPR03-01',
      delivery_date: '2026-10-16',
      kitchen_id: 'kitchen-03',
      kitchen_name: 'SPPG Dapur 03 - Kalibata (Dapur C)',
      item_id: 'item-wortel',
      item_name: 'Wortel',
      base_unit: 'kg',
      qty_dispatched_kg: 35,
      qty_accepted_kg: 33,
      qty_shrinkage_kg: 2,
      rejection_reason: 'Barang Rusak/Reject — wortel patah/busuk',
      kitchen_code: 'DPR-03',
      kitchen_pic_name: 'Hendra Wijaya',
      kitchen_pic_phone: '0812-9000-0003',
      is_weighed: true,
      is_locked: false,
    });

    const serialized = JSON.stringify(safeItems).toLowerCase();
    for (const forbidden of ['price', 'margin', 'invoice', 'cost', 'markup']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('supports decimal kilogram quantities (e.g. 12.5 kg and 0.2 kg) in fromSupabaseRows and fromCourierViewRows', () => {
    const seed = createInitialSeedState();
    const rows = toSupabaseRows(seed);
    rows.orderItems[0]!.qty_ordered_kg = 12.5;
    rows.orderItems[0]!.qty_accepted_kg = 12;
    rows.orderItems[1]!.qty_ordered_kg = 0.2;
    rows.orderItems[1]!.qty_accepted_kg = 0.2;

    const restored = fromSupabaseRows({
      kitchens: rows.kitchens,
      products: rows.products,
      orders: rows.orders,
      orderItems: rows.orderItems,
      invoices: rows.invoices,
      ledgerEntries: rows.ledgerEntries,
      splitConfigs: [rows.splitConfig],
      payoutBatches: rows.payoutBatches,
    });

    expect(restored.deliveryItems[0]!.qty_dispatched_kg).toBe(12.5);
    expect(restored.deliveryItems[0]!.qty_accepted_kg).toBe(12);
    expect(restored.deliveryItems[0]!.qty_shrinkage_kg).toBe(0.5);
    expect(restored.deliveryItems[1]!.qty_dispatched_kg).toBe(0.2);
    expect(restored.deliveryItems[1]!.qty_accepted_kg).toBe(0.2);
    expect(restored.deliveryItems[1]!.qty_shrinkage_kg).toBe(0);
  });
});

