import { describe, expect, it } from 'vitest';
import {
  batchShortCode,
  createInitialSeedState,
  upsertItemRecord,
  upsertKitchenRecord,
  upsertSupplierRecord,
  validateItemInput,
  validateKitchenInput,
  validateSupplierInput,
} from '../mbg-store';
import { INVOICE_LABEL, invoiceTone, sumIdr } from '../ui-format';

const NOW = '2026-10-17T00:00:00.000Z';

describe('Stage 5 — invoice status standardisation', () => {
  it('seed has only Belum Bayar / Lunas kitchen bills, unpaid total Rp 4.000.000', () => {
    const seed = createInitialSeedState();
    const labels = new Set(seed.invoices.map((i) => INVOICE_LABEL[i.payment_status]));
    expect([...labels].sort()).toEqual(['Belum Bayar', 'Lunas']);
    expect(seed.invoices.some((i) => i.payment_status === 'PARTIALLY_PAID')).toBe(false);

    const unpaid = seed.invoices.filter((i) => i.payment_status !== 'PAID');
    expect(unpaid).toHaveLength(2);
    expect(unpaid.every((i) => i.amount_paid === 0)).toBe(true);
    expect(sumIdr(unpaid.map((i) => i.total_invoice_amount))).toBe(4000000);
  });

  it('unpaid invoices keep profit share LOCKED_UNPAID (cash basis)', () => {
    const seed = createInitialSeedState();
    const unpaidIds = new Set(
      seed.invoices.filter((i) => i.payment_status !== 'PAID').map((i) => i.id)
    );
    const entries = seed.ledgerEntries.filter((le) => unpaidIds.has(le.invoice_id));
    expect(entries).toHaveLength(4);
    expect(entries.every((le) => le.payout_status === 'LOCKED_UNPAID')).toBe(true);
  });

  it('maps every non-PAID status to Belum Bayar with red tone', () => {
    for (const s of ['DRAFT', 'ISSUED', 'UNPAID', 'PARTIALLY_PAID'] as const) {
      expect(INVOICE_LABEL[s]).toBe('Belum Bayar');
      expect(invoiceTone(s)).toBe('red');
    }
    expect(invoiceTone('PAID')).toBe('green');
  });
});

describe('Stage 5 — batch short code', () => {
  it('numbers batches chronologically (stored newest-first)', () => {
    const { batches } = createInitialSeedState();
    expect(batchShortCode(batches[0]!.id, batches)).toBe('#B03');
    expect(batchShortCode(batches[batches.length - 1]!.id, batches)).toBe('#B01');
    expect(batchShortCode('missing', batches)).toBe('#B--');
  });
});

describe('Stage 5 — master data', () => {
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
    expect(edited.default_markup_per_kg).toBe(target.default_markup_per_kg);
    expect(next).toHaveLength(kitchens.length);
    expect(next[1]).toBe(kitchens[1]);
  });

  it('adds a new kitchen with a unique code', () => {
    const { kitchens } = createInitialSeedState();
    const next = upsertKitchenRecord(
      kitchens,
      { name: 'SPPG Baru', address: '', pic_name: 'Pak Ali', pic_phone: '0811' },
      NOW
    );
    expect(next).toHaveLength(26);
    const added = next[25]!;
    expect(added.kitchen_code).toBe('DPR-26');
    expect(added.address).toBe('-');
    expect(new Set(next.map((k) => k.kitchen_code)).size).toBe(26);
  });

  it('adds/edits suppliers including bank info', () => {
    const { suppliers } = createInitialSeedState();
    const added = upsertSupplierRecord(
      suppliers,
      {
        name: 'CV Sayur Segar',
        contact_person: '',
        phone: '0812',
        bank_name: 'BNI',
        bank_account_number: '123',
        bank_account_holder: 'CV Sayur Segar',
      },
      NOW
    );
    const sup = added[added.length - 1]!;
    expect(sup.supplier_code).toBe('SUP-04');
    expect(sup.contact_person).toBeNull();
    expect(sup.bank_name).toBe('BNI');

    const edited = upsertSupplierRecord(
      added,
      { ...sup, id: sup.id, contact_person: 'Pak Budi', phone: '', bank_name: 'BRI', bank_account_number: '9', bank_account_holder: 'X' },
      NOW
    );
    const e = edited.find((s) => s.id === sup.id)!;
    expect(e.contact_person).toBe('Pak Budi');
    expect(e.phone).toBeNull();
    expect(e.bank_name).toBe('BRI');
  });

  it('items always keep base_unit kg', () => {
    const { items } = createInitialSeedState();
    const added = upsertItemRecord(items, { name: 'Tahu Putih', category: '' }, NOW);
    const it = added[added.length - 1]!;
    expect(it.base_unit).toBe('kg');
    expect(it.category).toBe('Lainnya');
    expect(it.sku).toBe('ITM06-KG');

    const renamed = upsertItemRecord(added, { id: it.id, name: 'Tahu Kuning', category: 'Protein Nabati' }, NOW);
    expect(renamed.find((x) => x.id === it.id)).toMatchObject({ name: 'Tahu Kuning', base_unit: 'kg' });
  });

  it('validates required fields', () => {
    expect(validateKitchenInput({ name: ' ', address: '', pic_name: 'a', pic_phone: '1' })).toMatch(/Nama dapur/);
    expect(validateKitchenInput({ name: 'x', address: '', pic_name: '', pic_phone: '1' })).toMatch(/PIC/);
    expect(validateKitchenInput({ name: 'x', address: '', pic_name: 'a', pic_phone: '' })).toMatch(/WA/);
    expect(validateKitchenInput({ name: 'x', address: '', pic_name: 'a', pic_phone: '1' })).toBeNull();
    expect(
      validateSupplierInput({ name: '', contact_person: '', phone: '', bank_name: '', bank_account_number: '', bank_account_holder: '' })
    ).toMatch(/supplier/);
    expect(validateItemInput({ name: '', category: '' })).toMatch(/bahan baku/);
  });
});
