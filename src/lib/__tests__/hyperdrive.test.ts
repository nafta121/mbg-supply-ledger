import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type DurableObjectStateLike, MbgSyncHub } from '../../worker';
import {
  computeSnapshotEtag,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  executeHyperdriveAction,
  hashRolePin,
  type HyperdriveActionPayload,
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
    const adminSaltedHash = await hashRolePin('OWNER_ADMIN', '1122');

    const executedStatements: Array<{ query: string; values: unknown[] }> = [];

    const createStatement = (query: string, values: unknown[] = []): D1PreparedStatementLike => ({
      bind: (...bound: unknown[]) => createStatement(query, bound),
      first: async <T = Record<string, unknown>>() => {
        executedStatements.push({ query, values });
        if (query.includes('FROM role_credentials')) {
          return { pin_sha256: adminSaltedHash } as unknown as T;
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

  it('enforces Stage 1 Must-Fix security, BigInt Sen split, O(1) settings batch, and R2 document hygiene', async () => {
    const saltedAdminHex = await hashRolePin('OWNER_ADMIN', '1122');
    const saltedCoopHex = await hashRolePin('COOPERATIVE_VIEWER', '3344');
    expect(saltedAdminHex).toBe('65fbd296a1ae8adde6f7340794abb06caa642dc0623c12b8a199d70d4b6265aa');
    expect(saltedCoopHex).toBe('3679bb403222966183d744b3679589c8823dd3bdb739d8a15f85d5cd8d97db6a');

    const batchedQueries: string[][] = [];
    const rateLimits = new Map<string, { fail_count: number; reset_at_ms: number }>();
    const idempotencyLog = new Map<string, { result_json: string; expires_at_ms: number }>();

    const makeStmt = (
      query: string,
      values: unknown[] = []
    ): D1PreparedStatementLike & { __query: string; __values: unknown[] } => ({
      __query: query,
      __values: values,
      bind: (...bound: unknown[]) => makeStmt(query, bound),
      first: async <T = Record<string, unknown>>() => {
        if (query.includes('FROM role_credentials')) {
          const role = String(values[0] ?? '');
          if (role === 'OWNER_ADMIN') return { pin_sha256: saltedAdminHex } as unknown as T;
          if (role === 'COOPERATIVE_VIEWER') return { pin_sha256: saltedCoopHex } as unknown as T;
          return null;
        }
        if (query.includes('FROM security_rate_limits')) {
          const key = String(values[0] ?? '');
          return (rateLimits.get(key) ?? null) as unknown as T;
        }
        if (query.includes('FROM mutation_idempotency_log')) {
          const key = String(values[0] ?? '');
          return (idempotencyLog.get(key) ?? null) as unknown as T;
        }
        return null;
      },
      all: async <T = Record<string, unknown>>() => ({ results: [] as T[] }),
      run: async () => {
        if (query.includes('INSERT INTO security_rate_limits')) {
          rateLimits.set(String(values[0]), {
            fail_count: Number(values[1]),
            reset_at_ms: Number(values[2]),
          });
        } else if (query.includes('DELETE FROM security_rate_limits')) {
          rateLimits.delete(String(values[0]));
        } else if (query.includes('INSERT INTO mutation_idempotency_log')) {
          idempotencyLog.set(String(values[0]), {
            result_json: String(values[1]),
            expires_at_ms: Number(values[2]),
          });
        }
        return { success: true };
      },
    });

    let currentOrderItems = [
      {
        id: 'ditem-1',
        order_id: 'deliv-1',
        product_id: 'prod-1',
        product_name_snapshot: 'Wortel',
        qty_ordered_kg: 33.333,
        qty_accepted_kg: 33.333,
        kitchen_unit_price_rp: 16500,
        margin_per_kg_rp: 2000,
        is_weighed: 1,
      },
    ];

    const fakeD1: D1DatabaseLike = {
      prepare: (query: string) => makeStmt(query),
      batch: async <T = Record<string, unknown>>(statements: D1PreparedStatementLike[]) => {
        const qs = statements.map((s) => (s as unknown as { __query: string }).__query);
        batchedQueries.push(qs);

        // update_order initial read (5 queries)
        if (qs.length === 5 && qs[0]?.includes('FROM kitchen_orders') && qs[1]?.includes('FROM kitchens')) {
          return [
            { results: [{ id: 'deliv-1', kitchen_id: 'k-1', order_date: '2026-11-10', order_code: 'SJ-1' }] as unknown as T[] },
            { results: [{ id: 'k-1', code: 'DPR-01', name: 'Dapur 1', pic_name: 'PIC' }] as unknown as T[] },
            { results: [{ id: 'prod-1', code: 'ITM-1', name: 'Wortel' }] as unknown as T[] },
            {
              results: [
                ...currentOrderItems,
                { id: 'ditem-removed', order_id: 'deliv-1', product_id: 'prod-2', qty_ordered_kg: 5, qty_accepted_kg: 5 },
              ] as unknown as T[],
            },
            { results: [] as unknown as T[] },
          ];
        }

        // recalculateOrderFinancialsD1 read (5 queries)
        if (qs.length === 5 && qs[2]?.includes('FROM kitchen_invoices')) {
          return [
            { results: [{ id: 'deliv-1', kitchen_id: 'k-1', order_date: '2026-11-10', order_code: 'SJ-1' }] as unknown as T[] },
            { results: currentOrderItems as unknown as T[] },
            { results: [{ id: 'inv-deliv-1', order_id: 'deliv-1', status: 'UNPAID', amount_paid_rp: 0 }] as unknown as T[] },
            { results: [{ id: 'default', team_share_pct: 50, coop_share_pct: 50 }] as unknown as T[] },
            {
              results: [
                { id: 'ple-ditem-1', order_id: 'deliv-1', order_item_id: 'ditem-1', team_paid_out: 0, coop_paid_out: 0 },
                { id: 'ple-ditem-removed', order_id: 'deliv-1', order_item_id: 'ditem-removed', team_paid_out: 0, coop_paid_out: 0 },
              ] as unknown as T[],
            },
          ];
        }

        // update_app_settings read (2 queries)
        if (qs.length === 2 && qs[0]?.includes('FROM app_settings') && qs[1]?.includes('FROM profit_ledger_entries')) {
          return [
            { results: [{ id: 'default', team_share_pct: 50, coop_share_pct: 50 }] as unknown as T[] },
            {
              results: [
                { id: 'ple-1', gross_margin_rp: 66666 },
                { id: 'ple-2', gross_margin_rp: 33333.33 },
              ] as unknown as T[],
            },
          ];
        }

        return statements.map(() => ({ results: [] as T[], success: true }));
      },
    };

    const env = { DB: fakeD1 };

    // 1. Unknown action returns { ok: false } instead of crashing with TypeError
    const unknownRes = await executeHyperdriveAction(
      { action: 'non_existent_action', adminPin: '1122' } as unknown as HyperdriveActionPayload,
      env
    );
    expect(unknownRes.ok).toBe(false);
    expect(String(unknownRes.error)).toContain('Aksi tidak dikenal');

    // 2. update_order removes an item, computes exact BigInt Sen split, and reconciles payout batches
    batchedQueries.length = 0;
    const updateOrderRes = await executeHyperdriveAction(
      {
        action: 'update_order',
        adminPin: '1122',
        clientMutationId: 'mut-upd-order-1',
        input: {
          delivery_id: 'deliv-1',
          kitchen_id: 'k-1',
          order_date: '2026-11-10',
          lines: [
            {
              id: 'ditem-1',
              item_id: 'prod-1',
              qty_ordered_kg: 33.333,
              qty_accepted_kg: 33.333,
              kitchen_unit_price_rp: 16500,
              margin_per_kg_rp: 2000,
            },
          ],
        },
      },
      env
    );
    expect(updateOrderRes.ok).toBe(true);
    // Verify reconcilePayoutBatchesD1 ran after removing ditem-removed
    const flattenedSql = batchedQueries.flat().join('\n');
    expect(flattenedSql).toContain('UPDATE profit_payout_batches');
    expect(flattenedSql).toContain('DELETE FROM profit_payout_batches');

    // Verify D1-persisted idempotency even after clearing in-memory isolate cache
    resetHyperdrivePinGuardForTest();
    const dedupUpdateRes = await executeHyperdriveAction(
      {
        action: 'update_order',
        adminPin: '1122',
        clientMutationId: 'mut-upd-order-1',
        input: {
          delivery_id: 'deliv-1',
          kitchen_id: 'k-1',
          order_date: '2026-11-10',
          lines: [],
        },
      },
      env
    );
    expect(dedupUpdateRes).toMatchObject({ ok: true, deduplicated: true });

    // 3. update_app_settings executes in exactly 2 D1 batches (1 read + 1 write) regardless of open orders
    batchedQueries.length = 0;
    const settingsRes = await executeHyperdriveAction(
      {
        action: 'update_app_settings',
        adminPin: '1122',
        params: {
          teamSharePct: 50,
          coopSharePct: 50,
          supplierName: 'CV. NMD',
        },
      },
      env
    );
    expect(settingsRes.ok).toBe(true);
    expect(batchedQueries).toHaveLength(2);

    // 4. /api/documents requires PIN on GET, stores empty data_url in DO SQLite when R2 succeeds, and deletes from R2 on DELETE
    const r2Objects = new Map<string, string>();
    const doDocs = new Map<string, { id: string; doc_type: string; ref_id: string; file_name: string; content_type: string; data_url: string; size_bytes: number; created_at: string }>();

    const docHubState: DurableObjectStateLike = {
      storage: {
        sql: {
          exec: vi.fn((sqlText: string, ...params: unknown[]) => {
            if (sqlText.includes('INSERT INTO documents')) {
              const [id, doc_type, ref_id, file_name, content_type, data_url, size_bytes, created_at] = params as [
                string,
                string,
                string,
                string,
                string,
                string,
                number,
                string
              ];
              doDocs.set(id, { id, doc_type, ref_id, file_name, content_type, data_url, size_bytes, created_at });
            } else if (sqlText.includes('DELETE FROM documents WHERE id = ?')) {
              doDocs.delete(String(params[0]));
            } else if (sqlText.includes('SELECT file_name FROM documents WHERE id = ?')) {
              const doc = doDocs.get(String(params[0]));
              return { toArray: () => (doc ? [{ file_name: doc.file_name }] : []) };
            } else if (sqlText.includes('FROM documents WHERE id = ?')) {
              const doc = doDocs.get(String(params[0]));
              return { toArray: () => (doc ? [{ ...doc }] : []) };
            }
            return { toArray: () => [] };
          }) as unknown as DurableObjectStateLike['storage']['sql']['exec'],
        },
      },
      acceptWebSocket: vi.fn(),
      getWebSockets: vi.fn(() => []),
      blockConcurrencyWhile: vi.fn(async (cb) => cb()),
    };

    const r2Bucket = {
      get: vi.fn(async (key: string) => {
        const val = r2Objects.get(key);
        if (!val) return null;
        return {
          body: null,
          text: async () => val,
          arrayBuffer: async () => new TextEncoder().encode(val).buffer,
        };
      }),
      put: vi.fn(async (key: string, val: unknown) => {
        r2Objects.set(key, String(val));
      }),
      delete: vi.fn(async (key: string | string[]) => {
        if (Array.isArray(key)) key.forEach((k) => r2Objects.delete(k));
        else r2Objects.delete(key);
      }),
    };

    const docHub = new MbgSyncHub(docHubState, { ...env, MBG_STORAGE: r2Bucket });
    const workerEnv = {
      ...env,
      MBG_STORAGE: r2Bucket,
      MBG_SYNC_HUB: {
        idFromName: () => 'global-id',
        get: () => docHub,
        getByName: () => docHub,
      },
    };

    // Unauthenticated GET /api/documents is rejected with 401
    const unauthGet = await worker.fetch(new Request('https://mbg.letsgrow.web.id/api/documents'), workerEnv);
    expect(unauthGet.status).toBe(401);

    // Upload document via POST /api/documents
    const postDocRes = await worker.fetch(
      new Request('https://mbg.letsgrow.web.id/api/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-pin': '1122' },
        body: JSON.stringify({
          id: 'doc-bast-01',
          docType: 'BAST',
          refId: 'deliv-1',
          fileName: 'bast-01.jpg',
          contentType: 'image/jpeg',
          dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
        }),
      }),
      workerEnv
    );
    expect(postDocRes.status).toBe(200);
    // R2 received the payload while DO SQLite stored '' for data_url
    expect(r2Objects.get('documents/doc-bast-01/bast-01.jpg')).toBe('data:image/jpeg;base64,/9j/4AAQSkZJRg==');
    expect(doDocs.get('doc-bast-01')?.data_url).toBe('');

    // Authenticated GET /api/documents?id=doc-bast-01 (with Coop PIN) hydrates data_url from R2
    const authGet = await worker.fetch(
      new Request('https://mbg.letsgrow.web.id/api/documents?id=doc-bast-01', {
        headers: { 'x-role-pin': '3344' },
      }),
      workerEnv
    );
    expect(authGet.status).toBe(200);
    const authGetJson = (await authGet.json()) as { ok: boolean; document: { data_url: string } };
    expect(authGetJson.ok).toBe(true);
    expect(authGetJson.document.data_url).toBe('data:image/jpeg;base64,/9j/4AAQSkZJRg==');

    // DELETE /api/documents?id=doc-bast-01 removes from both DO SQLite and R2
    const delDocRes = await worker.fetch(
      new Request('https://mbg.letsgrow.web.id/api/documents?id=doc-bast-01', {
        method: 'DELETE',
        headers: { 'x-admin-pin': '1122' },
      }),
      workerEnv
    );
    expect(delDocRes.status).toBe(200);
    expect(doDocs.has('doc-bast-01')).toBe(false);
    expect(r2Objects.has('documents/doc-bast-01/bast-01.jpg')).toBe(false);
  });
});
