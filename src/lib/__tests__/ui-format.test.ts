import { describe, expect, it } from 'vitest';
import {
  formatKgNum,
  formatRp,
  INVOICE_LABEL,
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
    expect(sumKg([49, 48, 50, 50, 50])).toBe(247);
    expect(sumIdr([0.1, 0.2])).toBe(0.3);
    expect(sumIdr([120000, 117000, 86850])).toBe(323850);
    expect(subtractKg(50, 49)).toBe(1);
  });

  it('formats rupiah and kg for display', () => {
    expect(formatRp(2000000)).toBe('Rp 2.000.000');
    expect(formatRp(1785250.5)).toBe('Rp 1.785.250,50');
    expect(formatKgNum(50)).toBe('50');
    expect(formatKgNum(14.25)).toBe('14');
    expect(formatKgNum(48.75)).toBe('49');
  });

  it('maps technical statuses to operational labels', () => {
    expect(PAYOUT_LABEL.LOCKED_UNPAID).toBe('Menunggu Dapur Bayar');
    expect(PAYOUT_LABEL.AVAILABLE_FOR_PAYOUT).toBe('Siap Cair');
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
