import { describe, expect, it } from 'vitest';
import {
  upsertItemRecord,
  upsertKitchenRecord,
  validateItemInput,
  validateKitchenInput,
} from '../mbg-store';
import { createInitialSeedState } from './seed-fixture';
import { INVOICE_LABEL, invoiceTone, sumIdr } from '../ui-format';

const NOW = '2026-10-16T08:00:00.000Z';

describe('Stage 5/8 — invoice status standardisation', () => {
  const seed = createInitialSeedState();

  it('seed has only Belum Bayar / Lunas kitchen invoices', () => {
    expect(new Set(seed.invoices.map((i) => INVOICE_LABEL[i.payment_status]))).toEqual(
      new Set(['Belum Bayar', 'Lunas'])
    );
    const unpaid = seed.invoices.filter((i) => i.payment_status !== 'PAID');
    const paid = seed.invoices.filter((i) => i.payment_status === 'PAID');
    expect(unpaid).toHaveLength(3);
    expect(paid).toHaveLength(2);
    expect(sumIdr(unpaid.map((i) => i.total_invoice_amount))).toBe(6964500);
    expect(sumIdr(paid.map((i) => i.total_invoice_amount))).toBe(3310000);
  });

  it('unpaid invoices keep profit share LOCKED_UNPAID (cash basis)', () => {
    for (const inv of seed.invoices) {
      const entries = seed.ledgerEntries.filter((le) => le.invoice_id === inv.id);
      expect(entries.length).toBeGreaterThan(0);
      const expected = inv.payment_status === 'PAID' ? 'AVAILABLE_FOR_PAYOUT' : 'LOCKED_UNPAID';
      for (const e of entries) expect(e.payout_status).toBe(expected);
    }
  });

  it('maps every non-PAID status to Belum Bayar with red tone', () => {
    for (const s of ['DRAFT', 'ISSUED', 'UNPAID', 'PARTIALLY_PAID'] as const) {
      expect(INVOICE_LABEL[s]).toBe('Belum Bayar');
      expect(invoiceTone(s)).toBe('red');
    }
    expect(invoiceTone('PAID')).toBe('green');
  });
});

describe('Stage 5/8 — master data (Dapur & Barang)', () => {
  it('renames a kitchen and its PIC without touching other kitchens', () => {
    const { kitchens } = createInitialSeedState();
    const target = kitchens[0]!;
    const next = upsertKitchenRecord(
      kitchens,
      {
        id: target.id,
        name: '  SPPG Bekasi Utara 01 ',
        address: 'Jl. Sultan Agung',
        pic_name: 'Ibu Rahma',
        pic_phone: '0813-1111-2222',
      },
      NOW
    );
    const edited = next.find((k) => k.id === target.id)!;
    expect(edited.name).toBe('SPPG Bekasi Utara 01');
    expect(edited.pic_name).toBe('Ibu Rahma');
    expect(edited.pic_phone).toBe('0813-1111-2222');
    expect(edited.kitchen_code).toBe(target.kitchen_code);
    expect(next).toHaveLength(kitchens.length);
    expect(next[1]).toBe(kitchens[1]);
  });

  it('adds a new kitchen with a unique code', () => {
    const { kitchens } = createInitialSeedState();
    const next = upsertKitchenRecord(kitchens, { name: 'SPPG Baru', address: '', pic_name: 'Pak Ali', pic_phone: '0811' }, NOW);
    expect(next).toHaveLength(26);
    const added = next[25]!;
    expect(added.kitchen_code).toBe('DPR-26');
    expect(added.address).toBe('-');
    expect(new Set(next.map((k) => k.kitchen_code)).size).toBe(26);
  });

  it('items keep base_unit kg and store default kitchen price & margin', () => {
    const { items } = createInitialSeedState();
    const added = upsertItemRecord(
      items,
      { name: 'Tahu Putih', category: '', default_kitchen_price_per_kg: '12.000', default_margin_per_kg: 'Rp 1.500' },
      NOW
    );
    const it = added[added.length - 1]!;
    expect(it.base_unit).toBe('kg');
    expect(it.category).toBe('Lainnya');
    expect(it.sku).toBe('ITM06-KG');
    expect(it.default_kitchen_price_per_kg).toBe(12000);
    expect(it.default_margin_per_kg).toBe(1500);

    const renamed = upsertItemRecord(
      added,
      { id: it.id, name: 'Tahu Kuning', category: 'Protein Nabati', default_kitchen_price_per_kg: '13000', default_margin_per_kg: '' },
      NOW
    );
    expect(renamed.find((x) => x.id === it.id)).toMatchObject({
      name: 'Tahu Kuning',
      base_unit: 'kg',
      default_kitchen_price_per_kg: 13000,
      default_margin_per_kg: 0,
    });
  });

  it('validates required fields and margin ≤ price', () => {
    expect(validateKitchenInput({ name: ' ', address: '', pic_name: 'a', pic_phone: '1' })).toMatch(/Nama dapur/);
    expect(validateKitchenInput({ name: 'x', address: '', pic_name: '', pic_phone: '1' })).toMatch(/PIC/);
    expect(validateKitchenInput({ name: 'x', address: '', pic_name: 'a', pic_phone: '' })).toMatch(/WA/);
    expect(validateKitchenInput({ name: 'x', address: '', pic_name: 'a', pic_phone: '1' })).toBeNull();
    const item = { name: 'Wortel', category: '', default_kitchen_price_per_kg: '14.000', default_margin_per_kg: '2.000' };
    expect(validateItemInput(item)).toBeNull();
    expect(validateItemInput({ ...item, name: '' })).toMatch(/Nama barang/);
    expect(validateItemInput({ ...item, default_margin_per_kg: '20.000' })).toMatch(/Margin/);
  });

  it('seed contains the Phase-1 commodities with default prices', () => {
    const { items, kitchens } = createInitialSeedState();
    expect(kitchens).toHaveLength(25);
    expect(items.map((i) => [i.name, i.default_kitchen_price_per_kg, i.default_margin_per_kg])).toEqual([
      ['Wortel', 14000, 2000],
      ['Kubis', 10000, 1500],
      ['Daging Ayam Fillet', 40000, 4000],
      ['Telur Ayam', 30500, 3000],
      ['Beras', 15000, 1500],
    ]);
    expect(items.every((i) => i.base_unit === 'kg')).toBe(true);
  });
});
