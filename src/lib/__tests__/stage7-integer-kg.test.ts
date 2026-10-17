import { describe, expect, it } from 'vitest';
import {
  buildAcceptPendingLines,
  buildKitchenBastWaText,
  courierProgress,
  formatWeighedSummary,
  groupCourierStops,
  isDeliveryDone,
  stopWeighedSummary,
} from '../courier-view';
import { toWholeKg } from '../financial-engine';
import { buildSafeCourierItems, createInitialSeedState, formatKg as storeFormatKg } from '../mbg-store';
import { formatKg, formatKgNum, formatShrinkKgNum, parseKgInput } from '../ui-format';

const DECIMAL_KG = /\d[.,]\d+\s*kg/;

describe('Stage 7 — whole-kilogram formatting (Invariant 1)', () => {
  it('formats kg as whole numbers without .000', () => {
    expect(formatKgNum(50)).toBe('50');
    expect(formatKgNum(20)).toBe('20');
    expect(formatKg(50)).toBe('50 kg');
    expect(formatKg(-3)).toBe('-3 kg');
    expect(`${formatKgNum(70)} / ${formatKgNum(70)} kg`).toBe('70 / 70 kg');
    expect(storeFormatKg(50)).toBe('50 kg');
    expect(storeFormatKg(125)).toBe('125 kg');
    for (const kg of [0, 1, 20, 48, 49, 50, 70, 125, 150, 500, 1250]) {
      expect(formatKg(kg)).not.toContain('.000');
      expect(storeFormatKg(kg)).not.toMatch(DECIMAL_KG);
    }
  });

  it('rounds to the nearest whole kg (half away from zero) and never prints -0', () => {
    expect(toWholeKg(48.75)).toBe(49);
    expect(toWholeKg(49.5)).toBe(50);
    expect(toWholeKg(49.4)).toBe(49);
    expect(toWholeKg(-1.5)).toBe(-2);
    expect(toWholeKg(-0.2)).toBe(0);
    expect(formatKgNum(-0.2)).toBe('0');
    expect(toWholeKg(Number.NaN)).toBe(0);
  });

  it('formats shrinkage as a negative deduction', () => {
    expect(formatShrinkKgNum(1)).toBe('-1');
    expect(formatShrinkKgNum(2)).toBe('-2');
    expect(formatShrinkKgNum(0)).toBe('0');
  });

  it('parses typed kg input into whole kg', () => {
    expect(parseKgInput('50')).toBe(50);
    expect(parseKgInput('12.6')).toBe(13);
    expect(parseKgInput('')).toBe(0);
    expect(parseKgInput('-4')).toBe(0);
    expect(parseKgInput('abc')).toBe(0);
  });
});

describe('Stage 7 — whole-kg seed data', () => {
  const seed = createInitialSeedState();

  it('batches are whole kg: 150 / 100 / 500', () => {
    const byId = Object.fromEntries(seed.batches.map((b) => [b.id, b.qty_procured_kg]));
    expect(byId['batch-sup-a-ayam']).toBe(150);
    expect(byId['batch-sup-b-ayam']).toBe(100);
    expect(byId['batch-sup-c-telur']).toBe(500);
    expect(seed.batches.every((b) => Number.isInteger(b.qty_procured_kg))).toBe(true);
  });

  it('every delivery line uses whole kg (dispatched, accepted, shrinkage)', () => {
    for (const di of seed.deliveryItems) {
      expect(Number.isInteger(di.qty_dispatched_kg)).toBe(true);
      expect(Number.isInteger(di.qty_accepted_kg)).toBe(true);
      expect(Number.isInteger(di.qty_shrinkage_kg)).toBe(true);
    }
  });

  it('DPR-02 Ayam 49/50 kg (susut 1 kg) and DPR-04 Ayam 48/50 kg (susut 2 kg); total susut 3 kg', () => {
    const stops = groupCourierStops(buildSafeCourierItems(seed));
    const ayam = (code: string) =>
      stops.find((s) => s.kitchen_code === code)!.items.find((i) => i.item_id === 'item-ayam')!;
    expect(ayam('DPR-02')).toMatchObject({ qty_dispatched_kg: 50, qty_accepted_kg: 49, qty_shrinkage_kg: 1 });
    expect(ayam('DPR-04')).toMatchObject({ qty_dispatched_kg: 50, qty_accepted_kg: 48, qty_shrinkage_kg: 2 });
    expect(courierProgress(stops).total_shrinkage_kg).toBe(3);
  });

  it('kitchen bills, supplier payable and profit shares are clean whole-rupiah numbers', () => {
    const inv02 = seed.invoices.find((i) => i.id === 'inv-02')!;
    const inv04 = seed.invoices.find((i) => i.id === 'inv-04')!;
    expect(inv02.total_invoice_amount).toBe(1960000);
    expect(inv02.amount_paid).toBe(1960000);
    expect(inv04.total_invoice_amount).toBe(1920000);
    expect(inv04.amount_paid).toBe(1920000);
    for (const le of seed.ledgerEntries) expect(Number.isInteger(le.profit_amount)).toBe(true);
    for (const s of seed.supplierSettlements) {
      expect(Number.isInteger(s.net_payable_amount)).toBe(true);
      expect(Number.isInteger(s.shrinkage_claim_deduction_amount)).toBe(true);
    }
  });

  it('WA BAST recap never contains decimal kilograms', () => {
    const stops = groupCourierStops(buildSafeCourierItems(seed));
    for (const s of stops) {
      const text = buildKitchenBastWaText(s);
      expect(text).not.toMatch(DECIMAL_KG);
      expect(text).not.toContain('.000');
    }
  });
});

describe('Stage 7 — clean courier card (honest totals & anti-overwrite)', () => {
  const seed = createInitialSeedState();
  const stops = groupCourierStops(buildSafeCourierItems(seed));
  const dpr01 = stops.find((s) => s.kitchen_code === 'DPR-01')!;
  const dpr02 = stops.find((s) => s.kitchen_code === 'DPR-02')!;

  it('"Tertimbang" counts only weighed lines: 1/2 barang (50 / 70 kg)', () => {
    const summary = stopWeighedSummary(dpr01);
    expect(summary).toEqual({
      weighed_count: 1,
      total_count: 2,
      weighed_accepted_kg: 50,
      total_dispatched_kg: 70,
    });
    expect(formatWeighedSummary(summary)).toBe('Tertimbang: 1/2 barang (50 / 70 kg)');
    expect(formatWeighedSummary(stopWeighedSummary(dpr02))).toBe('Tertimbang: 1/2 barang (49 / 70 kg)');
  });

  it('"Terima Sesuai Kirim" only targets PENDING lines and never overwrites weighed Ayam 49 kg', () => {
    const lines = buildAcceptPendingLines(dpr02);
    const ayam = dpr02.items.find((i) => i.item_id === 'item-ayam')!;
    const telur = dpr02.items.find((i) => i.item_id === 'item-telur')!;
    expect(isDeliveryDone(ayam.delivery_status)).toBe(true);
    expect(isDeliveryDone(telur.delivery_status)).toBe(false);
    expect(lines).toEqual([
      { delivery_item_id: telur.delivery_item_id, qty_accepted_kg: 20, rejection_reason: null },
    ]);
    expect(lines.some((l) => l.delivery_item_id === ayam.delivery_item_id)).toBe(false);
  });

  it('returns no lines for a fully weighed kitchen (nothing to overwrite)', () => {
    const dpr04 = stops.find((s) => s.kitchen_code === 'DPR-04')!;
    expect(dpr04.done).toBe(true);
    expect(buildAcceptPendingLines(dpr04)).toEqual([]);
  });

  it('courier card items stay price-free (Invariant 5)', () => {
    for (const it of dpr02.items) {
      expect('supplier_actual_cost_snapshot' in it).toBe(false);
      expect('kitchen_unit_price_snapshot' in it).toBe(false);
    }
  });
});
