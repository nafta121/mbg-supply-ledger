import type { SupabaseClient } from '@supabase/supabase-js';
import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import {
  executeHyperdriveAction,
  isHyperdriveConfigured,
  queryMbgDataViaHyperdrive,
  resolveHyperdriveConnectionString,
} from '../hyperdrive';
import { createInitialSeedState, toSupabaseRows } from './seed-fixture';
import {
  fetchMbgDataFromSupabase,
  fromSupabaseRows,
  setHyperdriveEndpointStateForTest,
  updateKitchenOrderRpc,
} from '../supabase-sync';

describe('Supabase Sync Layer — Order-Driven Schema & Invariants', () => {
  it('round-trips initial seed state through Order-Driven Supabase rows losslessly', () => {
    const seed = createInitialSeedState();
    const rows = toSupabaseRows(seed);

    expect(rows.kitchens).toHaveLength(25);
    expect(rows.products).toHaveLength(5);
    expect(rows.orders).toHaveLength(5);
    expect(rows.orderItems).toHaveLength(11);
    expect(rows.invoices).toHaveLength(5);
    expect(rows.ledgerEntries).toHaveLength(11);

    // Invariant 1: All qty_ordered_kg and qty_accepted_kg must be whole integers
    for (const item of rows.orderItems) {
      expect(Number.isInteger(item.qty_ordered_kg)).toBe(true);
      if (item.qty_accepted_kg !== null) {
        expect(Number.isInteger(item.qty_accepted_kg)).toBe(true);
      } else {
        expect(item.is_weighed).toBe(false);
      }
    }

    // Invariant 4: Team + Cooperative amounts equal gross_margin_rp
    for (const ple of rows.ledgerEntries) {
      expect(Number(ple.team_amount_rp) + Number(ple.coop_amount_rp)).toBe(Number(ple.gross_margin_rp));
    }

    const restored = fromSupabaseRows({
      kitchens: rows.kitchens,
      products: rows.products,
      orders: rows.orders,
      orderItems: rows.orderItems,
      invoices: rows.invoices,
      ledgerEntries: rows.ledgerEntries,
      splitConfigs: [rows.splitConfig],
      payoutBatches: rows.payoutBatches,
    });

    expect(restored.kitchens).toHaveLength(25);
    expect(restored.items).toHaveLength(5);
    expect(restored.deliveries).toHaveLength(5);
    expect(restored.deliveryItems).toHaveLength(11);
    expect(restored.invoices).toHaveLength(5);
    expect(restored.ledgerEntries).toHaveLength(22);

    // Check DPR-03 Wortel: ordered 35, accepted 33, billed 462000
    const dpr03Inv = restored.invoices.find((i) => i.kitchen_id === 'kitchen-03')!;
    expect(dpr03Inv.total_invoice_amount).toBe(1212000);
    expect(dpr03Inv.payment_status).toBe('UNPAID');
  });

  it('supports decimal kilogram quantities (e.g. 12.5 kg and 0.2 kg) in fromSupabaseRows', () => {
    const seed = createInitialSeedState();
    const rows = toSupabaseRows(seed);
    rows.orderItems[0]!.qty_ordered_kg = 12.5;
    rows.orderItems[0]!.qty_accepted_kg = 12;
    rows.orderItems[1]!.qty_ordered_kg = 0.2;
    rows.orderItems[1]!.qty_accepted_kg = 0.2;

    const restored = fromSupabaseRows({
      kitchens: rows.kitchens,
      products: rows.products,
      orders: rows.orders,
      orderItems: rows.orderItems,
      invoices: rows.invoices,
      ledgerEntries: rows.ledgerEntries,
      splitConfigs: [rows.splitConfig],
      payoutBatches: rows.payoutBatches,
    });

    expect(restored.deliveryItems[0]!.qty_dispatched_kg).toBe(12.5);
    expect(restored.deliveryItems[0]!.qty_accepted_kg).toBe(12);
    expect(restored.deliveryItems[0]!.qty_shrinkage_kg).toBe(0.5);
    expect(restored.deliveryItems[1]!.qty_dispatched_kg).toBe(0.2);
    expect(restored.deliveryItems[1]!.qty_accepted_kg).toBe(0.2);
    expect(restored.deliveryItems[1]!.qty_shrinkage_kg).toBe(0);
  });

  it('preserves separate team_paid_out_at and coop_paid_out_at timestamps and dynamic payment account info', () => {
    const seed = createInitialSeedState();
    const rows = toSupabaseRows(seed);
    rows.ledgerEntries[0]!.team_paid_out = true;
    rows.ledgerEntries[0]!.team_paid_out_at = '2026-10-16T16:00:00.000Z';
    rows.ledgerEntries[0]!.coop_paid_out = true;
    rows.ledgerEntries[0]!.coop_paid_out_at = '2026-10-17T10:30:00.000Z';
    rows.appSettings.payment_bank_name = 'BRI';
    rows.appSettings.payment_account_number = '388801005597504';
    rows.appSettings.payment_account_holder = 'Yoga Eko Setiawan';

    const restored = fromSupabaseRows({
      kitchens: rows.kitchens,
      products: rows.products,
      orders: rows.orders,
      orderItems: rows.orderItems,
      invoices: rows.invoices,
      ledgerEntries: rows.ledgerEntries,
      splitConfigs: [rows.splitConfig],
      appSettings: [rows.appSettings],
      payoutBatches: rows.payoutBatches,
    });

    const teamEntry = restored.ledgerEntries.find(
      (e) => e.delivery_item_id === rows.ledgerEntries[0]!.order_item_id && e.beneficiary_type === 'TEAM'
    )!;
    const coopEntry = restored.ledgerEntries.find(
      (e) => e.delivery_item_id === rows.ledgerEntries[0]!.order_item_id && e.beneficiary_type === 'COOPERATIVE'
    )!;
    expect(teamEntry.paid_out_at).toBe('2026-10-16T16:00:00.000Z');
    expect(coopEntry.paid_out_at).toBe('2026-10-17T10:30:00.000Z');
    expect(restored.splitConfig.payment_bank_name).toBe('BRI');
    expect(restored.splitConfig.payment_account_number).toBe('388801005597504');
    expect(restored.splitConfig.payment_account_holder).toBe('Yoga Eko Setiawan');
  });

  it('updateKitchenOrderRpc normalizes payload and returns RPC result or error', async () => {
    const rpcMock = vi.fn().mockResolvedValueOnce({
      data: { order_id: 'deliv-01', count: 2 },
      error: null,
    });
    const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

    const okRes = await updateKitchenOrderRpc(fakeClient, {
      delivery_id: 'deliv-01',
      kitchen_id: 'kitchen-02',
      order_date: '2026-10-20',
      lines: [
        {
          id: 'ditem-01',
          item_id: 'item-wortel',
          qty_ordered_kg: 35,
          qty_accepted_kg: 33.1264,
          kitchen_unit_price_rp: 14000,
          margin_per_kg_rp: 2000,
        },
      ],
    });

    expect(okRes).toEqual({ ok: true, order_id: 'deliv-01', count: 2 });
    expect(rpcMock).toHaveBeenCalledWith('rpc_update_kitchen_order', {
      p_order_id: 'deliv-01',
      p_kitchen_id: 'kitchen-02',
      p_order_date: '2026-10-20',
      p_items: [
        {
          id: 'ditem-01',
          product_id: 'item-wortel',
          item_id: 'item-wortel',
          qty_ordered_kg: 35,
          qty_accepted_kg: 33.126,
          kitchen_unit_price_rp: 14000,
          margin_per_kg_rp: 2000,
        },
      ],
    });

    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'Bagi hasil sudah dicairkan' },
    });
    const errRes = await updateKitchenOrderRpc(fakeClient, {
      delivery_id: 'deliv-01',
      kitchen_id: 'kitchen-02',
      order_date: '2026-10-20',
      lines: [],
    });
    expect(errRes).toEqual({ ok: false, error: 'Bagi hasil sudah dicairkan' });
  });

  it('fetchMbgDataFromSupabase falls back cleanly when app_settings lacks supplier_name column', async () => {
    const seed = createInitialSeedState();
    const rows = toSupabaseRows(seed);
    let appSettingsCalls = 0;

    const fakeClient = {
      from: (table: string) => ({
        select: () => ({
          order: () => {
            if (table === 'kitchens') return Promise.resolve({ data: rows.kitchens, error: null });
            if (table === 'products') return Promise.resolve({ data: rows.products, error: null });
            return {
              limit: () => Promise.resolve({ data: rows.payoutBatches, error: null }),
              range: () => {
                if (table === 'kitchen_orders') return Promise.resolve({ data: rows.orders, error: null });
                if (table === 'kitchen_order_items') return Promise.resolve({ data: rows.orderItems, error: null });
                if (table === 'kitchen_invoices') return Promise.resolve({ data: rows.invoices, error: null });
                if (table === 'profit_ledger_entries') return Promise.resolve({ data: rows.ledgerEntries, error: null });
                return Promise.resolve({ data: [], error: null });
              },
            };
          },
          eq: () => {
            appSettingsCalls += 1;
            if (appSettingsCalls === 1) {
              return Promise.resolve({ data: null, error: { message: 'column supplier_name does not exist' } });
            }
            return Promise.resolve({
              data: [
                {
                  id: 'default',
                  team_share_pct: 60,
                  coop_share_pct: 40,
                  payment_bank_name: 'BCA',
                  payment_account_number: '1234567890',
                  payment_account_holder: 'Koperasi MBG',
                },
              ],
              error: null,
            });
          },
        }),
      }),
    } as unknown as SupabaseClient;

    const data = await fetchMbgDataFromSupabase(fakeClient);
    expect(appSettingsCalls).toBe(2);
    expect(data).not.toBeNull();
    expect(data?.splitConfig.payment_bank_name).toBe('BCA');
    expect(data?.splitConfig.payment_account_number).toBe('1234567890');
    expect(data?.splitConfig.payment_account_holder).toBe('Koperasi MBG');
  });

  it('resolves Cloudflare Hyperdrive connectionString, queries in 1 round-trip, and enforces Admin PIN & delete guards on mutations', async () => {
    expect(isHyperdriveConfigured({})).toBe(false);
    const hdEnv = {
      HYPERDRIVE: { connectionString: 'postgresql://postgres:secret@edge.hyperdrive.cloudflare:5432/postgres' },
    };
    expect(resolveHyperdriveConnectionString(hdEnv)).toBe(
      'postgresql://postgres:secret@edge.hyperdrive.cloudflare:5432/postgres'
    );

    // 1. Single-query Hyperdrive read (`queryMbgDataViaHyperdrive`)
    const seed = createInitialSeedState();
    const rows = toSupabaseRows(seed);
    const readEndMock = vi.fn().mockResolvedValue(undefined);
    const readSqlMock = vi.fn().mockResolvedValue([
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
    const readSql = Object.assign(readSqlMock, { end: readEndMock }) as unknown as Sql;
    const hdData = await queryMbgDataViaHyperdrive(hdEnv, () => readSql);
    expect(readSqlMock).toHaveBeenCalledTimes(1);
    expect(hdData.kitchens).toHaveLength(25);
    expect(hdData.invoices).toHaveLength(5);

    // 2. Rejects mutation when Admin PIN is missing
    const noPinSql = Object.assign(vi.fn(), {
      end: vi.fn().mockResolvedValue(undefined),
    }) as unknown as Sql;
    const noPinRes = await executeHyperdriveAction(
      { action: 'mark_invoice_paid', invoiceId: 'inv-01' },
      hdEnv,
      () => noPinSql
    );
    expect(noPinRes.ok).toBe(false);
    expect(String(noPinRes.error)).toMatch(/PIN Admin/i);

    // 3. Executes upsert_order after Admin PIN verification succeeds
    const endMock = vi.fn().mockResolvedValue(undefined);
    const fakeSql = Object.assign(
      vi
        .fn()
        .mockResolvedValueOnce([{ res: { ok: true } }])
        .mockResolvedValueOnce([{ res: { order_id: 'deliv-hd-1', order_code: 'SJ-HD-01', merged: false, count: 1 } }]),
      {
        json: (v: unknown) => v,
        array: (v: unknown) => v,
        end: endMock,
      }
    ) as unknown as Sql;

    const result = await executeHyperdriveAction(
      {
        action: 'upsert_order',
        adminPin: '1122',
        orderDate: '2026-10-20',
        input: {
          kitchen_id: 'kitchen-01',
          lines: [{ item_id: 'item-wortel', qty_ordered_kg: 25.5, kitchen_unit_price_rp: 14000, margin_per_kg_rp: 2000 }],
        },
      },
      hdEnv,
      () => fakeSql
    );

    expect(result).toEqual({
      ok: true,
      order_id: 'deliv-hd-1',
      order_code: 'SJ-HD-01',
      merged: false,
      count: 1,
    });
    expect(endMock).toHaveBeenCalledTimes(1);

    // 4. Returns error when delete_order targets a non-existent order/invoice, and succeeds (with batch sync) for paid invoices
    const missingDeleteSql = Object.assign(
      vi.fn().mockResolvedValueOnce([{ res: { ok: true } }]).mockResolvedValueOnce([]),
      { end: vi.fn().mockResolvedValue(undefined) }
    ) as unknown as Sql;
    const missingDelRes = await executeHyperdriveAction(
      { action: 'delete_order', orderId: 'deliv-missing', adminPin: '1122' },
      hdEnv,
      () => missingDeleteSql
    );
    expect(missingDelRes.ok).toBe(false);
    expect(String(missingDelRes.error)).toMatch(/tidak ditemukan/i);

    const paidDeleteSql = Object.assign(
      vi
        .fn()
        .mockResolvedValueOnce([{ res: { ok: true } }])
        .mockResolvedValueOnce([{ id: 'deliv-01', team_batch_id: 'pbatch-team-1', coop_batch_id: null }])
        .mockResolvedValueOnce([]),
      { end: vi.fn().mockResolvedValue(undefined) }
    ) as unknown as Sql;
    const paidDelRes = await executeHyperdriveAction(
      { action: 'delete_order', orderId: 'deliv-01', adminPin: '1122' },
      hdEnv,
      () => paidDeleteSql
    );
    expect(paidDelRes).toEqual({ ok: true });

    // 5. Single-hop includeSnapshot returns authoritative MbgData snapshot over the same socket
    const singleHopEndMock = vi.fn().mockResolvedValue(undefined);
    const singleHopSql = Object.assign(
      vi
        .fn()
        .mockResolvedValueOnce([{ res: { ok: true } }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
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
        ]),
      { end: singleHopEndMock }
    ) as unknown as Sql;

    const singleHopRes = await executeHyperdriveAction(
      { action: 'mark_invoice_paid', invoiceId: 'inv-01', adminPin: '1122', includeSnapshot: true },
      hdEnv,
      () => singleHopSql
    );
    expect(singleHopRes.ok).toBe(true);
    expect((singleHopRes.snapshot as { kitchens: unknown[] }).kitchens).toHaveLength(25);
    expect(singleHopEndMock).toHaveBeenCalledTimes(1);

    setHyperdriveEndpointStateForTest('unknown');
  });
});


