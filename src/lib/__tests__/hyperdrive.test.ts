import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeHyperdriveAction,
  isHyperdriveConfigured,
  queryMbgDataViaHyperdrive,
  resetHyperdrivePinGuardForTest,
  resolveHyperdriveConnectionString,
} from '../hyperdrive';
import { createInitialSeedState, toSupabaseRows } from './seed-fixture';

const hdEnv = {
  HYPERDRIVE: { connectionString: 'postgresql://postgres:secret@edge.hyperdrive.cloudflare:5432/postgres' },
};

describe('Cloudflare Hyperdrive Security & Scale Hardening', () => {
  beforeEach(() => {
    resetHyperdrivePinGuardForTest();
  });

  it('uses recent_orders CTE in queryMbgDataViaHyperdrive to prevent 50-day LIMIT 5000 silent truncation', async () => {
    expect(isHyperdriveConfigured({})).toBe(false);
    expect(resolveHyperdriveConnectionString(hdEnv)).toBe(
      'postgresql://postgres:secret@edge.hyperdrive.cloudflare:5432/postgres'
    );

    const seed = createInitialSeedState();
    const rows = toSupabaseRows(seed);
    let capturedSql = '';
    const sqlMock = vi.fn((strings: TemplateStringsArray) => {
      capturedSql = strings.join('?');
      return Promise.resolve([
        {
          kitchens: rows.kitchens,
          products: rows.products,
          orders: rows.orders,
          orderItems: rows.orderItems,
          invoices: rows.invoices,
          ledgerEntries: rows.ledgerEntries,
          appSettings: [rows.appSettings],
          payoutBatches: rows.payoutBatches,
        },
      ]);
    });
    const fakeSql = Object.assign(sqlMock, {
      end: vi.fn().mockResolvedValue(undefined),
    }) as unknown as Sql;

    const data = await queryMbgDataViaHyperdrive(hdEnv, () => fakeSql);
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(capturedSql).toContain('WITH recent_orders AS');
    expect(capturedSql).toContain('WHERE order_id IN (SELECT id FROM recent_orders)');
    expect(capturedSql).not.toContain('LIMIT 5000');
    expect(data.deliveries).toHaveLength(5);
    expect(data.deliveryItems).toHaveLength(11);
  });

  it('locks out a clientIp after 5 failed Admin PIN attempts and rejects the 6th without querying SQL', async () => {
    const sqlMock = vi.fn().mockResolvedValue([{ res: { ok: false } }]);
    const fakeSql = Object.assign(sqlMock, {
      end: vi.fn().mockResolvedValue(undefined),
    }) as unknown as Sql;

    for (let i = 0; i < 5; i++) {
      const res = await executeHyperdriveAction(
        {
          action: 'mark_invoice_paid',
          invoiceId: 'inv-01',
          adminPin: '9999',
          clientIp: '203.0.113.42',
        },
        hdEnv,
        () => fakeSql
      );
      expect(res).toEqual({
        ok: false,
        error: 'PIN Admin tidak valid atau sesi telah berakhir.',
      });
    }
    expect(sqlMock).toHaveBeenCalledTimes(5);

    // 6th attempt from same IP is blocked before running any SQL query
    const sixthRes = await executeHyperdriveAction(
      {
        action: 'mark_invoice_paid',
        invoiceId: 'inv-01',
        adminPin: '1122',
        clientIp: '203.0.113.42',
      },
      hdEnv,
      () => fakeSql
    );
    expect(sixthRes).toEqual({
      ok: false,
      error: 'Terlalu banyak percobaan PIN salah. Coba lagi dalam 10 menit.',
    });
    expect(sqlMock).toHaveBeenCalledTimes(5);

    // Verify verify_role_pin action is also locked out for that IP without querying SQL
    const verifyRes = await executeHyperdriveAction(
      {
        action: 'verify_role_pin',
        role: 'OWNER_ADMIN',
        pin: '1122',
        clientIp: '203.0.113.42',
      },
      hdEnv,
      () => fakeSql
    );
    expect(verifyRes).toEqual({
      ok: false,
      error: 'Terlalu banyak percobaan PIN salah. Coba lagi dalam 10 menit.',
    });
    expect(sqlMock).toHaveBeenCalledTimes(5);
  });

  it('bounds tracked PIN failure keys at 256 by evicting the oldest clientIp', async () => {
    const sqlMock = vi.fn().mockResolvedValue([{ res: { ok: false } }]);
    const fakeSql = Object.assign(sqlMock, {
      end: vi.fn().mockResolvedValue(undefined),
    }) as unknown as Sql;

    // Lock out IP #0 with 5 failed attempts
    for (let i = 0; i < 5; i++) {
      await executeHyperdriveAction(
        { action: 'verify_role_pin', role: 'OWNER_ADMIN', pin: '0000', clientIp: '10.0.0.0' },
        hdEnv,
        () => fakeSql
      );
    }
    expect(sqlMock).toHaveBeenCalledTimes(5);

    // Insert 256 additional distinct IPs to evict '10.0.0.0'
    for (let ip = 1; ip <= 256; ip++) {
      await executeHyperdriveAction(
        { action: 'verify_role_pin', role: 'OWNER_ADMIN', pin: '0000', clientIp: `10.0.1.${ip}` },
        hdEnv,
        () => fakeSql
      );
    }
    expect(sqlMock).toHaveBeenCalledTimes(5 + 256);

    // '10.0.0.0' was evicted and can now query SQL again when providing the valid PIN
    sqlMock.mockResolvedValueOnce([{ res: { ok: true } }]);
    const unlockedRes = await executeHyperdriveAction(
      { action: 'verify_role_pin', role: 'OWNER_ADMIN', pin: '1122', clientIp: '10.0.0.0' },
      hdEnv,
      () => fakeSql
    );
    expect(unlockedRes).toEqual({ ok: true });
    expect(sqlMock).toHaveBeenCalledTimes(5 + 256 + 1);
  });
});
