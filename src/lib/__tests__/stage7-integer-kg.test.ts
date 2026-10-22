import { describe, expect, it } from 'vitest';
import {
  buildAcceptPendingLines,
  buildKitchenBastWaText,
  formatWeighedSummary,
  groupCourierStops,
  stopWeighedSummary,
} from '../courier-view';
import { buildInvoiceWaText } from '../invoice-view';
import { toWholeKg } from '../financial-engine';
import { buildSafeCourierItems, formatKg as storeFormatKg } from '../mbg-store';
import { createInitialSeedState } from './seed-fixture';
import { formatKg, formatKgNum, formatShrinkKgNum, parseKgInput, parseWholeKgInput } from '../ui-format';

const TRAILING_ZERO_KG = /\d[.,]\d*0\s*kg|\d\.000\s*kg/;

describe('Stage 7/8 — dynamic Indonesian decimal kilogram formatting (Invariant 1)', () => {
  it('formats whole and decimal kg with Indonesian comma and never prints trailing zeros (.000 / ,000)', () => {
    expect(formatKgNum(50)).toBe('50');
    expect(formatKgNum(20)).toBe('20');
    expect(formatKg(50)).toBe('50 kg');
    expect(formatKg(12.5)).toBe('12,5 kg');
    expect(formatKg(0.2)).toBe('0,2 kg');
    expect(formatKg(1.25)).toBe('1,25 kg');
    expect(formatKg(-0.5)).toBe('-0,5 kg');
    expect(formatKg(-3)).toBe('-3 kg');
    expect(`${formatKgNum(70)} / ${formatKgNum(70)} kg`).toBe('70 / 70 kg');
    expect(storeFormatKg(50)).toBe('50 kg');
    expect(storeFormatKg(12.5)).toBe('12,5 kg');
    expect(storeFormatKg(0.2)).toBe('0,2 kg');
    expect(storeFormatKg(125)).toBe('125 kg');
    for (const kg of [0, 0.2, 1, 1.25, 12.5, 20, 48, 49, 50, 70, 125, 150, 500, 1250]) {
      expect(formatKg(kg)).not.toContain('.000');
      expect(formatKg(kg)).not.toContain(',000');
      expect(storeFormatKg(kg)).not.toMatch(TRAILING_ZERO_KG);
    }
  });

  it('rounds to at most 3 decimal places and never prints -0', () => {
    expect(toWholeKg(48.75)).toBe(48.75);
    expect(toWholeKg(12.5)).toBe(12.5);
    expect(toWholeKg(0.1 + 0.2)).toBe(0.3);
    expect(toWholeKg(-0.5)).toBe(-0.5);
    expect(toWholeKg(-0.0001)).toBe(0);
    expect(formatKgNum(-0.0001)).toBe('0');
    expect(toWholeKg(Number.NaN)).toBe(0);
  });

  it('formats shrinkage as a negative deduction', () => {
    expect(formatShrinkKgNum(1)).toBe('-1');
    expect(formatShrinkKgNum(0.5)).toBe('-0,5');
    expect(formatShrinkKgNum(2)).toBe('-2');
    expect(formatShrinkKgNum(0)).toBe('0');
  });

  it('parses typed kg input (comma or dot) into 3-decimal kg', () => {
    expect(parseKgInput('50')).toBe(50);
    expect(parseKgInput('12,5')).toBe(12.5);
    expect(parseKgInput('12.5')).toBe(12.5);
    expect(parseKgInput('0,2')).toBe(0.2);
    expect(parseKgInput('')).toBe(0);
    expect(parseKgInput('-4')).toBe(0);
    expect(parseKgInput('abc')).toBe(0);
    expect(parseWholeKgInput('35')).toBe(35);
    expect(parseWholeKgInput('35,5')).toBe(35.5);
    expect(parseWholeKgInput('0,2')).toBe(0.2);
    expect(parseWholeKgInput('-1')).toBeNull();
    expect(parseWholeKgInput('')).toBeNull();
  });
});

describe('Stage 7/8 — whole-kg seed data', () => {
  const seed = createInitialSeedState();

  it('every order line uses whole kg (ordered, accepted, selisih)', () => {
    for (const di of seed.deliveryItems) {
      for (const v of [di.qty_dispatched_kg, di.qty_accepted_kg, di.qty_shrinkage_kg]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
    for (const le of seed.ledgerEntries) expect(Number.isInteger(le.qty_accepted_kg)).toBe(true);
  });

  it('DPR-02 Ayam 49/50 kg (susut 1) and DPR-03 Wortel 33/35 kg (reject 2)', () => {
    const items = buildSafeCourierItems(seed);
    const ayam02 = items.find((i) => i.kitchen_code === 'DPR-02' && i.item_id === 'item-ayam')!;
    const wortel03 = items.find((i) => i.kitchen_code === 'DPR-03' && i.item_id === 'item-wortel')!;
    expect([ayam02.qty_dispatched_kg, ayam02.qty_accepted_kg, ayam02.qty_shrinkage_kg]).toEqual([50, 49, 1]);
    expect([wortel03.qty_dispatched_kg, wortel03.qty_accepted_kg, wortel03.qty_shrinkage_kg]).toEqual([35, 33, 2]);
  });

  it('kitchen invoices and profit shares are clean whole-rupiah numbers', () => {
    for (const inv of seed.invoices) expect(Number.isInteger(inv.total_invoice_amount)).toBe(true);
    for (const le of seed.ledgerEntries) expect(Number.isInteger(le.profit_amount)).toBe(true);
  });

  it('WA BAST and WA invoice texts never contain trailing-zero kilograms', () => {
    const stops = groupCourierStops(buildSafeCourierItems(seed));
    for (const s of stops) {
      const text = buildKitchenBastWaText(s);
      expect(text).not.toMatch(TRAILING_ZERO_KG);
      expect(text).not.toContain('.000 kg');
    }
    for (const inv of seed.invoices) {
      expect(buildInvoiceWaText(seed, inv)).not.toMatch(TRAILING_ZERO_KG);
    }
  });
});

describe('Stage 7/8 — clean courier card (honest totals & anti-overwrite)', () => {
  const seed = createInitialSeedState();
  const stops = groupCourierStops(buildSafeCourierItems(seed));
  const stop = (code: string) => stops.find((s) => s.kitchen_code === code)!;

  it('"Tertimbang" counts only weighed lines', () => {
    expect(formatWeighedSummary(stopWeighedSummary(stop('DPR-03')))).toBe('Tertimbang: 2/2 barang (83 / 85 kg)');
    expect(formatWeighedSummary(stopWeighedSummary(stop('DPR-05')))).toBe('Tertimbang: 1/2 barang (50 / 75 kg)');
    expect(formatWeighedSummary(stopWeighedSummary(stop('DPR-04')))).toBe('Tertimbang: 0/3 barang (0 / 135 kg)');
  });

  it('"Terima Sesuai Order" only targets PENDING lines and never overwrites weighed Ayam 50 kg', () => {
    const dpr05 = stop('DPR-05');
    const ayam = dpr05.items.find((i) => i.item_id === 'item-ayam')!;
    const telur = dpr05.items.find((i) => i.item_id === 'item-telur')!;
    expect(ayam.is_weighed).toBe(true);
    expect(telur.is_weighed).toBe(false);
    expect(buildAcceptPendingLines(dpr05)).toEqual([
      { delivery_item_id: telur.delivery_item_id, qty_accepted_kg: 25, rejection_reason: null },
    ]);
  });

  it('returns no lines for a fully weighed or locked (Lunas) order', () => {
    expect(stop('DPR-03').done).toBe(true);
    expect(buildAcceptPendingLines(stop('DPR-03'))).toEqual([]);
    expect(stop('DPR-01').locked).toBe(true);
    expect(buildAcceptPendingLines(stop('DPR-01'))).toEqual([]);
  });

  it('courier card items stay price-free (Invariant 5)', () => {
    for (const s of stops) {
      for (const it of s.items) {
        expect('kitchen_unit_price_snapshot' in it).toBe(false);
        expect('margin_per_kg_snapshot' in it).toBe(false);
        expect('line_invoice_amount' in it).toBe(false);
      }
    }
  });
});
