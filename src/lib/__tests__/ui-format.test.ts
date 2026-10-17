import { describe, expect, it } from 'vitest';
import { summarizeOrderDraft } from '../order-engine';
import {
  formatKg,
  formatKgNum,
  formatRp,
  getJakartaTodayYmd,
  INVOICE_LABEL,
  parseAcceptedKgInput,
  parseKgInput,
  parseRpInput,
  PAYOUT_LABEL,
  ROLE_LABEL,
  shortKitchenName,
  subtractKg,
  sumIdr,
  sumKg,
  toWaNumber,
} from '../ui-format';

describe('ui-format helpers', () => {
  it('sums kg and IDR exactly without float drift', () => {
    expect(sumKg([0.1, 0.2])).toBe(0.3);
    expect(sumKg([12.5, 0.2, 1.25])).toBe(13.95);
    expect(sumKg([49, 48, 50, 50, 50])).toBe(247);
    expect(sumIdr([0.1, 0.2])).toBe(0.3);
    expect(sumIdr([120000, 117000, 86850])).toBe(323850);
    expect(subtractKg(50, 49)).toBe(1);
    expect(subtractKg(12.5, 0.2)).toBe(12.3);
  });

  it('formats rupiah and smart Indonesian decimal kg without trailing zeros', () => {
    expect(formatRp(2000000)).toBe('Rp 2.000.000');
    expect(formatRp(1785250.5)).toBe('Rp 1.785.250,50');
    expect(formatKg(50)).toBe('50 kg');
    expect(formatKg(12.5)).toBe('12,5 kg');
    expect(formatKg(0.2)).toBe('0,2 kg');
    expect(formatKg(1.25)).toBe('1,25 kg');
    expect(formatKg(-0.5)).toBe('-0,5 kg');
    expect(formatKgNum(50)).toBe('50');
    expect(formatKgNum(12.5)).toBe('12,5');
    expect(formatKgNum(0.2)).toBe('0,2');
    expect(formatKgNum(1.25)).toBe('1,25');
    expect(formatKgNum(-0.5)).toBe('-0,5');
  });

  it('parses decimal kg inputs with either comma or dot separator', () => {
    expect(parseKgInput('12,5')).toBe(12.5);
    expect(parseKgInput('12.5')).toBe(12.5);
    expect(parseKgInput('0,2')).toBe(0.2);
    expect(parseKgInput('0.2')).toBe(0.2);
    expect(parseKgInput('1,25')).toBe(1.25);
    expect(parseKgInput('50')).toBe(50);
    expect(parseAcceptedKgInput('0,2')).toBe(0.2);
    expect(parseAcceptedKgInput('12,')).toBe(12);
    expect(parseAcceptedKgInput('0,')).toBe(0);
    expect(parseAcceptedKgInput('')).toBeNull();
  });

  it('separates parseKgInput vs parseRpInput and calculates Wortel 13.5 kg x Rp 9.500 = Rp 128.250 (margin Rp 27.000)', () => {
    expect(parseKgInput('13.5')).toBe(13.5);
    expect(parseKgInput('13,5')).toBe(13.5);
    expect(parseRpInput('9.500')).toBe(9500);
    expect(parseRpInput('2.000')).toBe(2000);

    const qty = parseKgInput('13.5');
    const price = parseRpInput('9.500');
    const margin = parseRpInput('2.000');
    const summary = summarizeOrderDraft([
      {
        item_id: 'item-wortel',
        qty_ordered_kg: qty,
        kitchen_unit_price_rp: price,
        margin_per_kg_rp: margin,
      },
    ]);

    expect(summary).toEqual({
      item_count: 1,
      total_kg: 13.5,
      estimated_invoice: 128250,
      estimated_margin: 27000,
    });
    expect(
      `Total Barang: ${summary.item_count} jenis (${formatKgNum(summary.total_kg)} kg) • Estimasi Tagihan Dapur: ${formatRp(summary.estimated_invoice)}`
    ).toBe('Total Barang: 1 jenis (13,5 kg) • Estimasi Tagihan Dapur: Rp 128.250');
    expect(formatRp(summary.estimated_margin)).toBe('Rp 27.000');
  });

  it('formats current date in Asia/Jakarta (WIB) as YYYY-MM-DD', () => {
    expect(getJakartaTodayYmd(new Date('2026-10-17T20:00:00.000Z'))).toBe('2026-10-18');
    expect(getJakartaTodayYmd()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('maps technical statuses to operational labels', () => {
    expect(PAYOUT_LABEL.LOCKED_UNPAID).toBe('Menunggu Dapur Bayar');
    expect(PAYOUT_LABEL.AVAILABLE_FOR_PAYOUT).toBe('Siap Dicairkan');
    expect(ROLE_LABEL.OWNER_ADMIN).toBe('Admin');
    expect(ROLE_LABEL.FIELD_TEAM).toBe('Tim Lapangan');
    expect(ROLE_LABEL.COOPERATIVE_VIEWER).toBe('Koperasi');
    expect(INVOICE_LABEL.PAID).toBe('Lunas');
    expect(INVOICE_LABEL.UNPAID).toBe('Belum Bayar');
  });

  it('shortens kitchen names and builds WA numbers', () => {
    expect(shortKitchenName('SPPG Dapur 01 - Tebet (Dapur A)')).toBe('Tebet');
    expect(shortKitchenName('SPPG Dapur 20 - Lenteng Agung')).toBe('Lenteng Agung');
    expect(toWaNumber('0812-9000-0001')).toBe('6281290000001');
  });
});

