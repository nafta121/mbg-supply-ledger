import { describe, expect, it } from 'vitest';
import { composeShrinkReason, describeShrinkReason, parseShrinkReason } from '../courier-view';
import { buildInvoiceWaText } from '../invoice-view';
import { roundKg } from '../financial-engine';
import { createInitialSeedState } from './seed-fixture';
import { formatKg, formatKgNum, parseAcceptedKgInput, parseKgInput } from '../ui-format';

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
    for (const kg of [0, 0.2, 1, 1.25, 12.5, 20, 48, 49, 50, 70, 125, 150, 500, 1250]) {
      expect(formatKg(kg)).not.toContain('.000');
      expect(formatKg(kg)).not.toContain(',000');
      expect(formatKg(kg)).not.toMatch(TRAILING_ZERO_KG);
    }
  });

  it('rounds to at most 3 decimal places and never prints -0', () => {
    expect(roundKg(48.75)).toBe(48.75);
    expect(roundKg(12.5)).toBe(12.5);
    expect(roundKg(0.1 + 0.2)).toBe(0.3);
    expect(roundKg(-0.5)).toBe(-0.5);
    expect(roundKg(-0.0001)).toBe(0);
    expect(formatKgNum(-0.0001)).toBe('0');
    expect(roundKg(Number.NaN)).toBe(0);
  });

  it('round-trips shrink reason strings', () => {
    const composed = composeShrinkReason('Barang Rusak/Reject', 'wortel patah');
    expect(composed).toBe('Barang Rusak/Reject — wortel patah');
    expect(parseShrinkReason(composed)).toEqual({ reason: 'Barang Rusak/Reject', note: 'wortel patah' });
    expect(describeShrinkReason(composed)).toBe('Barang Rusak/Reject — wortel patah');
  });

  it('parses typed kg input (comma or dot) into 3-decimal kg', () => {
    expect(parseKgInput('50')).toBe(50);
    expect(parseKgInput('12,5')).toBe(12.5);
    expect(parseKgInput('12.5')).toBe(12.5);
    expect(parseKgInput('0,2')).toBe(0.2);
    expect(parseKgInput('')).toBe(0);
    expect(parseKgInput('-4')).toBe(0);
    expect(parseKgInput('abc')).toBe(0);
    expect(parseAcceptedKgInput('35')).toBe(35);
    expect(parseAcceptedKgInput('35,5')).toBe(35.5);
    expect(parseAcceptedKgInput('0,2')).toBe(0.2);
    expect(parseAcceptedKgInput('-1')).toBeNull();
    expect(parseAcceptedKgInput('')).toBeNull();
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
    const del02 = seed.deliveries.find((d) => d.kitchen_id === 'kitchen-02')!;
    const del03 = seed.deliveries.find((d) => d.kitchen_id === 'kitchen-03')!;
    const ayam02 = seed.deliveryItems.find((i) => i.delivery_id === del02.id && i.item_id === 'item-ayam')!;
    const wortel03 = seed.deliveryItems.find((i) => i.delivery_id === del03.id && i.item_id === 'item-wortel')!;
    expect([ayam02.qty_dispatched_kg, ayam02.qty_accepted_kg, ayam02.qty_shrinkage_kg]).toEqual([50, 49, 1]);
    expect([wortel03.qty_dispatched_kg, wortel03.qty_accepted_kg, wortel03.qty_shrinkage_kg]).toEqual([35, 33, 2]);
  });

  it('kitchen invoices and profit shares are clean whole-rupiah numbers', () => {
    for (const inv of seed.invoices) expect(Number.isInteger(inv.total_invoice_amount)).toBe(true);
    for (const le of seed.ledgerEntries) expect(Number.isInteger(le.profit_amount)).toBe(true);
  });

  it('WA invoice texts never contain trailing-zero kilograms', () => {
    for (const inv of seed.invoices) {
      expect(buildInvoiceWaText(seed, inv)).not.toMatch(TRAILING_ZERO_KG);
    }
  });
});
