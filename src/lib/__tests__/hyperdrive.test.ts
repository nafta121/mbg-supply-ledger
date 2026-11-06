import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type DurableObjectStateLike, MbgSyncHub } from '../../worker';
import {
  computeSnapshotEtag,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  executeHyperdriveAction,
  isHyperdriveConfigured,
  queryMbgDataViaHyperdrive,
  resetHyperdrivePinGuardForTest,
  resolveHyperdriveConnectionString,
  type Sql,
  timingSafeEqualBytes,
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

  it('deduplicates retried mutations with identical clientMutationId without re-running SQL mutation', async () => {
    const sqlMock = vi
      .fn()
      // 1st call: PIN verification
      .mockResolvedValueOnce([{ res: { ok: true } }])
      // 2nd call: mark_invoice_paid RPC
      .mockResolvedValueOnce([{ ok: true }])
      // 3rd call: PIN verification on retry (when sqlFactory is provided)
      .mockResolvedValueOnce([{ res: { ok: true } }]);

    const fakeSql = Object.assign(sqlMock, {
      end: vi.fn().mockResolvedValue(undefined),
    }) as unknown as Sql;

    const firstRes = await executeHyperdriveAction(
      {
        action: 'mark_invoice_paid',
        invoiceId: 'inv-01',
        adminPin: '1122',
        clientMutationId: 'mut-retry-001',
      },
      hdEnv,
      () => fakeSql
    );
    expect(firstRes).toEqual({ ok: true });
    expect(sqlMock).toHaveBeenCalledTimes(2);

    const retryRes = await executeHyperdriveAction(
      {
        action: 'mark_invoice_paid',
        invoiceId: 'inv-01',
        adminPin: '1122',
        clientMutationId: 'mut-retry-001',
      },
      hdEnv,
      () => fakeSql
    );
    expect(retryRes).toEqual({ ok: true, deduplicated: true });
    // Only PIN check ran; mark_invoice_paid SQL was NOT executed a second time
    expect(sqlMock).toHaveBeenCalledTimes(3);
  });

  it('computes deterministic SHA-256 weak ETag and performs constant-time byte comparisons', async () => {
    const etagA = await computeSnapshotEtag({ a: 1, b: [2, 3] });
    const etagB = await computeSnapshotEtag({ a: 1, b: [2, 3] });
    const etagC = await computeSnapshotEtag({ a: 1, b: [2, 4] });

    expect(etagA).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(etagA).toBe(etagB);
    expect(etagA).not.toBe(etagC);

    const buf1 = new Uint8Array([1, 2, 3, 4]);
    const buf2 = new Uint8Array([1, 2, 3, 4]);
    const buf3 = new Uint8Array([1, 2, 3, 5]);
    expect(timingSafeEqualBytes(buf1, buf2)).toBe(true);
    expect(timingSafeEqualBytes(buf1, buf3)).toBe(false);
  });

  it('coordinates real-time broadcasts, APK version manifest, and documents in MbgSyncHub Durable Object', async () => {
    const sentMessages: string[] = [];
    const fakeWs = {
      send: vi.fn((msg: string) => sentMessages.push(msg)),
      close: vi.fn(),
    } as unknown as WebSocket;

    const fakeState: DurableObjectStateLike = {
      storage: {
        sql: {
          exec: vi.fn(() => ({
            toArray: () => [
              {
                version: 2,
                last_action: 'mark_invoice_paid',
                etag: 'W/"abc"',
                updated_at: '2026-11-06T12:00:00.000Z',
                version_code: 2,
                version_name: '1.1.0',
                download_url: 'https://mbg.letsgrow.web.id/apk/mbg-v1.1.0.apk',
                sha256: 'deadbeef',
                release_notes: 'Peningkatan sinkronisasi real-time',
                mandatory: 1,
                published_at: '2026-11-06T12:00:00.000Z',
              },
            ],
            [Symbol.iterator]: function* () {
              // empty iterator
            },
          })) as unknown as DurableObjectStateLike["storage"]["sql"]["exec"],
        },
      },
      acceptWebSocket: vi.fn(),
      getWebSockets: vi.fn(() => [fakeWs]),
      blockConcurrencyWhile: vi.fn(async (cb) => cb()),
    };

    const hub = new MbgSyncHub(fakeState, hdEnv);

    // 1. Broadcast mutation (with inline snapshot) to connected WebSocket clients
    const sampleSnapshot = { kitchens: [], items: [], deliveries: [] };
    const broadcastRes = await hub.fetch(
      new Request('https://mbg-sync-hub.internal/broadcast', {
        method: 'POST',
        body: JSON.stringify({
          action: 'mark_invoice_paid',
          etag: 'W/"abc"',
          snapshot: sampleSnapshot,
        }),
      })
    );
    const broadcastJson = (await broadcastRes.json()) as { ok: boolean; clients: number };
    expect(broadcastJson.ok).toBe(true);
    expect(broadcastJson.clients).toBe(1);
    expect(sentMessages).toHaveLength(1);
    expect(JSON.parse(sentMessages[0] ?? '{}')).toMatchObject({
      type: 'mutation',
      action: 'mark_invoice_paid',
      etag: 'W/"abc"',
      snapshot: sampleSnapshot,
    });

    // 2. Query APK manifest via Worker /api/apk/version
    const apkRes = await worker.fetch(new Request('https://mbg.letsgrow.web.id/api/apk/version'), {
      ...hdEnv,
      MBG_SYNC_HUB: {
        idFromName: () => 'global-id',
        get: () => hub,
        getByName: () => hub,
      },
    });
    const apkJson = (await apkRes.json()) as {
      ok: boolean;
      apk: { versionCode: number; versionName: string; mandatory: boolean };
    };
    expect(apkJson.ok).toBe(true);
    expect(apkJson.apk.versionCode).toBe(2);
    expect(apkJson.apk.versionName).toBe('1.1.0');
    expect(apkJson.apk.mandatory).toBe(true);
  });

  it('executes full Cloudflare D1 snapshot reads, SHA-256 PIN verification, and atomic batch mutations via env.DB', async () => {
    const seed = createInitialSeedState();
    const rows = toSupabaseRows(seed);
    // Hash for role='OWNER_ADMIN', salt='mbg-pin-salt-admin-v1', pin='1122':
    // sha256("OWNER_ADMIN:mbg-pin-salt-admin-v1:1122") = e67bc0661e992a765eb4b5518aa51fc0bd4a2eb2ca8da837a2782bd77d0f13bd
    const adminSalt = 'mbg-pin-salt-admin-v1';
    const adminHash = 'e67bc0661e992a765eb4b5518aa51fc0bd4a2eb2ca8da837a2782bd77d0f13bd';

    const executedStatements: Array<{ query: string; values: unknown[] }> = [];

    const createStatement = (query: string, values: unknown[] = []): D1PreparedStatementLike => ({
      bind: (...bound: unknown[]) => createStatement(query, bound),
      first: async <T = Record<string, unknown>>() => {
        executedStatements.push({ query, values });
        if (query.includes('FROM role_pins')) {
          return { pin_salt: adminSalt, pin_hash: adminHash } as unknown as T;
        }
        if (query.includes('FROM kitchen_orders WHERE id = ?')) {
          return { id: 'deliv-01', kitchen_id: 'kitchen-01', order_date: '2026-10-16', order_code: 'SJ-20261016-DPR01-01' } as unknown as T;
        }
        if (query.includes('FROM app_settings WHERE id =')) {
          return rows.appSettings as unknown as T;
        }
        if (query.includes('FROM kitchen_invoices WHERE order_id = ?')) {
          return rows.invoices[0] as unknown as T;
        }
        return null;
      },
      all: async <T = Record<string, unknown>>() => {
        executedStatements.push({ query, values });
        if (query.includes('FROM profit_ledger_entries WHERE order_id = ?')) {
          return { results: [] as T[] };
        }
        return { results: [] as T[] };
      },
      run: async () => {
        executedStatements.push({ query, values });
        return { success: true };
      },
    });

    const fakeD1: D1DatabaseLike = {
      prepare: (query: string) => createStatement(query),
      batch: async <T = Record<string, unknown>>(statements: D1PreparedStatementLike[]) => {
        // When 8 statements are batched, it's fetchMbgSnapshotFromD1
        if (statements.length === 8) {
          return [
            { results: rows.kitchens.map((k) => ({ ...k, is_active: 1 })) as unknown as T[] },
            { results: rows.products.map((p) => ({ ...p, is_active: 1 })) as unknown as T[] },
            { results: rows.orders as unknown as T[] },
            { results: rows.orderItems.map((oi) => ({ ...oi, is_weighed: oi.is_weighed ? 1 : 0 })) as unknown as T[] },
            { results: rows.invoices as unknown as T[] },
            {
              results: rows.ledgerEntries.map((le) => ({
                ...le,
                team_paid_out: le.team_paid_out ? 1 : 0,
                coop_paid_out: le.coop_paid_out ? 1 : 0,
              })) as unknown as T[],
            },
            { results: [rows.appSettings] as unknown as T[] },
            { results: rows.payoutBatches as unknown as T[] },
          ];
        }
        return statements.map(() => ({ results: [] as T[], success: true }));
      },
    };

    const d1Env = { DB: fakeD1 };
    expect(isHyperdriveConfigured(d1Env)).toBe(true);

    // 1. Read snapshot via D1 batch (with SQLite integer booleans 1/0 coerced to true/false)
    const snapshot = await queryMbgDataViaHyperdrive(d1Env);
    expect(snapshot.kitchens).toHaveLength(25);
    expect(snapshot.kitchens[0]?.is_active).toBe(true);
    expect(snapshot.items[0]?.is_active).toBe(true);
    expect(snapshot.deliveries).toHaveLength(5);

    // 2. Verify Admin PIN via Web Crypto SHA-256 against D1 role_pins
    const validPinRes = await executeHyperdriveAction(
      { action: 'verify_role_pin', role: 'OWNER_ADMIN', pin: '1122', clientIp: '198.51.100.10' },
      d1Env
    );
    expect(validPinRes).toEqual({ ok: true });

    const invalidPinRes = await executeHyperdriveAction(
      { action: 'verify_role_pin', role: 'OWNER_ADMIN', pin: '0000', clientIp: '198.51.100.10' },
      d1Env
    );
    expect(invalidPinRes).toEqual({ ok: false });

    // 3. Delete order via D1 atomic batch + includeSnapshot
    const deleteRes = await executeHyperdriveAction(
      { action: 'delete_order', orderId: 'deliv-01', adminPin: '1122', includeSnapshot: true },
      d1Env
    );
    expect(deleteRes.ok).toBe(true);
    expect((deleteRes.snapshot as { kitchens: unknown[] }).kitchens).toHaveLength(25);
  });
});
