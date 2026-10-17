import { describe, expect, it } from 'vitest';
import {
  buildKitchenBastWaText,
  composeShrinkReason,
  courierProgress,
  groupCourierStops,
  parseShrinkReason,
  summarizeVehicleLoad,
  supplierShrinkBreakdown,
} from '../courier-view';
import { buildSafeCourierItems, createInitialSeedState } from '../mbg-store';

const FORBIDDEN_KEYS = [
  'supplier_actual_cost_snapshot',
  'kitchen_unit_price_snapshot',
  'supplier_actual_cost_per_kg',
  'line_invoice_amount',
  'line_supplier_payable_amount',
  'line_supplier_claim_amount',
  'line_total_markup_amount',
  'total_invoice_amount',
  'default_markup_per_kg',
];

describe('Stage 6 — price-free courier projection (Invariant 5)', () => {
  it('never exposes cost, price, invoice, or markup fields', () => {
    const items = buildSafeCourierItems(createInitialSeedState());
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      for (const k of FORBIDDEN_KEYS) expect(k in it).toBe(false);
      expect(it.base_unit).toBe('kg');
      expect(it.batch_code).toMatch(/^BATCH-/);
    }
  });
});

describe('Stage 6 — kitchen-centric grouping', () => {
  const seed = createInitialSeedState();
  const items = buildSafeCourierItems(seed);
  const stops = groupCourierStops(items);

  it('groups multiple items of DPR-01 and DPR-02 onto one card each', () => {
    const dpr01 = stops.find((s) => s.kitchen_code === 'DPR-01')!;
    const dpr02 = stops.find((s) => s.kitchen_code === 'DPR-02')!;
    expect(dpr01.items.map((i) => i.item_id).sort()).toEqual(['item-ayam', 'item-telur']);
    expect(dpr02.items.map((i) => i.item_id).sort()).toEqual(['item-ayam', 'item-telur']);
    expect(dpr01.pic_name).toBe('Budi Santoso');
    // Telur still awaiting BAST → stop not finished yet.
    expect(dpr01.done).toBe(false);
    expect(dpr01.pending_count).toBe(1);
    expect(dpr01.total_dispatched_kg).toBe(70);
  });

  it('one stop per kitchen, sorted by kitchen code', () => {
    expect(stops.map((s) => s.kitchen_code)).toEqual(['DPR-01', 'DPR-02', 'DPR-03', 'DPR-04', 'DPR-05']);
  });

  it('sums total vehicle load per item in exact kg', () => {
    const load = summarizeVehicleLoad(items);
    const ayam = load.find((l) => l.item_id === 'item-ayam')!;
    const telur = load.find((l) => l.item_id === 'item-telur')!;
    expect(ayam.qty_dispatched_kg).toBe(250);
    expect(telur.qty_dispatched_kg).toBe(40);
  });

  it('reports courier progress and accumulated physical shrinkage', () => {
    const p = courierProgress(stops);
    expect(p).toEqual({ done: 3, total: 5, total_shrinkage_kg: 3 });
  });

  it('pending Telur stops follow the allocation flow: UNPAID invoice + LOCKED_UNPAID ledger', () => {
    const pending = seed.deliveries.filter((d) => d.status === 'IN_TRANSIT');
    expect(pending).toHaveLength(2);
    const ids = new Set(pending.map((d) => d.id));
    const invs = seed.invoices.filter((i) => ids.has(i.delivery_id));
    expect(invs.every((i) => i.payment_status === 'UNPAID')).toBe(true);
    const invIds = new Set(invs.map((i) => i.id));
    const ledger = seed.ledgerEntries.filter((le) => invIds.has(le.invoice_id));
    expect(ledger).toHaveLength(4);
    expect(ledger.every((le) => le.payout_status === 'LOCKED_UNPAID')).toBe(true);
  });
});

describe('Stage 6 — shrink reasons', () => {
  it('composes and parses quick-chip reasons with an optional note', () => {
    expect(composeShrinkReason('Barang Rusak/Reject', ' memar ')).toBe('Barang Rusak/Reject — memar');
    expect(composeShrinkReason('Selisih Timbang', '')).toBe('Selisih Timbang');
    expect(composeShrinkReason(null, '')).toBeNull();
    expect(parseShrinkReason('Barang Rusak/Reject — memar')).toEqual({
      reason: 'Barang Rusak/Reject',
      note: 'memar',
    });
    expect(parseShrinkReason('Susut')).toEqual({ reason: 'Susut', note: '' });
    expect(parseShrinkReason('teks bebas lama')).toEqual({ reason: null, note: 'teks bebas lama' });
  });

  it('exposes courier reasons per kitchen for the supplier deduction basis', () => {
    const seed = createInitialSeedState();
    const supA = supplierShrinkBreakdown('batch-sup-a-ayam', seed.deliveryItems, seed.deliveries, seed.kitchens);
    expect(supA).toHaveLength(1);
    expect(supA[0]).toMatchObject({ kitchen_code: 'DPR-02', kg: 1.25, reason: 'Susut' });
    const supB = supplierShrinkBreakdown('batch-sup-b-ayam', seed.deliveryItems, seed.deliveries, seed.kitchens);
    expect(supB[0]).toMatchObject({ kitchen_code: 'DPR-04', kg: 1.75, reason: 'Barang Rusak/Reject' });
  });

  it('WA BAST recap lists every item in kg and contains no rupiah', () => {
    const stops = groupCourierStops(buildSafeCourierItems(createInitialSeedState()));
    const text = buildKitchenBastWaText(stops.find((s) => s.kitchen_code === 'DPR-02')!);
    expect(text).toContain('Daging Ayam Fillet');
    expect(text).toContain('Telur Ayam Negeri');
    expect(text).toContain('susut 1.250 kg — Susut');
    expect(text).not.toMatch(/Rp|IDR/);
  });
});
