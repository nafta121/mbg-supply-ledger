import { describe, expect, it } from 'vitest';
import { BUSINESS_DATE, type MbgState } from '../mbg-store';
import { createInitialSeedState } from './seed-fixture';
import {
  applyBastWeights,
  createKitchenOrder,
  type EngineCtx,
  executePayout,
  markInvoicePaid,
  summarizeOrderDraft,
  updateProfitSplit,
} from '../order-engine';
import { fromSupabaseRows, toSupabaseRows } from '../supabase-sync';
import { formatKg, parseKgInput, parseRpInput, sumIdr } from '../ui-format';

function makeCtx(): EngineCtx {
  let seq = 0;
  return {
    nowIso: '2026-10-16T10:00:00.000Z',
    today: BUSINESS_DATE,
    uid: (prefix) => `${prefix}-oe${(seq += 1)}`,
  };
}

function emptyState(): MbgState {
  const s = createInitialSeedState();
  return {
    ...s,
    deliveries: [],
    deliveryItems: [],
    invoices: [],
    ledgerEntries: [],
    payoutBatches: [],
  };
}

describe('order-engine — Decimal Kg, Unweighed Guard, & Partial Payout Split Freeze', () => {
  it('processes multi-item order with decimal weights (13.5 kg, 0.2 kg, 12,5 kg) and separates parseKgInput vs parseRpInput', () => {
    const qtyWortel = parseKgInput('13.5');
    const qtyLada = parseKgInput('0.2');
    const qtyKubis = parseKgInput('12,5');

    const priceWortel = parseRpInput('9.500');
    const marginWortel = parseRpInput('2.000');

    expect(qtyWortel).toBe(13.5);
    expect(qtyLada).toBe(0.2);
    expect(qtyKubis).toBe(12.5);
    expect(priceWortel).toBe(9500);
    expect(marginWortel).toBe(2000);

    const lines = [
      { item_id: 'item-wortel', qty_ordered_kg: qtyWortel, kitchen_unit_price_rp: priceWortel, margin_per_kg_rp: marginWortel },
      { item_id: 'item-telur', qty_ordered_kg: qtyLada, kitchen_unit_price_rp: 30000, margin_per_kg_rp: 3000 },
      { item_id: 'item-kubis', qty_ordered_kg: qtyKubis, kitchen_unit_price_rp: 10000, margin_per_kg_rp: 1500 },
    ];

    const draft = summarizeOrderDraft(lines);
    // 13.5 + 0.2 + 12.5 = 26.2 kg
    expect(draft.item_count).toBe(3);
    expect(draft.total_kg).toBe(26.2);
    expect(formatKg(draft.total_kg)).toBe('26,2 kg');
    // Invoice: (13.5 * 9500 = 128250) + (0.2 * 30000 = 6000) + (12.5 * 10000 = 125000) = 259250
    expect(draft.estimated_invoice).toBe(259250);
    // Margin: (13.5 * 2000 = 27000) + (0.2 * 3000 = 600) + (12.5 * 1500 = 18750) = 46350
    expect(draft.estimated_margin).toBe(46350);

    const ctx = makeCtx();
    const res = createKitchenOrder(emptyState(), { kitchen_id: 'kitchen-01', lines }, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const inv = res.data.invoices[0]!;
    expect(inv.total_invoice_amount).toBe(259250);
    expect(inv.payment_bank_name).toBe('BRI');
    expect(sumIdr(res.data.ledgerEntries.map((le) => le.profit_amount))).toBe(46350);
  });

  it('rejects markInvoicePaid while any item on the order is still unweighed (is_weighed = false)', () => {
    const ctx = makeCtx();
    const created = createKitchenOrder(
      emptyState(),
      {
        kitchen_id: 'kitchen-01',
        lines: [
          { item_id: 'item-wortel', qty_ordered_kg: 13.5, kitchen_unit_price_rp: 14000, margin_per_kg_rp: 2000 },
          { item_id: 'item-kubis', qty_ordered_kg: 12.5, kitchen_unit_price_rp: 10000, margin_per_kg_rp: 1500 },
        ],
      },
      ctx
    );
    if (!created.ok) throw new Error(created.error);
    let data = created.data;
    const invId = data.invoices[0]!.id;

    // 1. None weighed -> reject
    const attempt1 = markInvoicePaid(data, invId, '2026-10-16T11:00:00.000Z');
    expect(attempt1.ok).toBe(false);
    if (!attempt1.ok) {
      expect(attempt1.error).toMatch(/Belum semua barang ditimbang/i);
    }

    // 2. Only first item weighed -> still reject
    const firstItem = data.deliveryItems[0]!;
    const weighed1 = applyBastWeights(
      data,
      [{ delivery_item_id: firstItem.id, qty_accepted_kg: 13, rejection_reason: 'Susut' }],
      '2026-10-16T11:30:00.000Z'
    );
    if (!weighed1.ok) throw new Error(weighed1.error);
    data = weighed1.data;

    const attempt2 = markInvoicePaid(data, invId, '2026-10-16T11:45:00.000Z');
    expect(attempt2.ok).toBe(false);

    // 3. Weigh second item -> markInvoicePaid succeeds and unlocks ledger
    const secondItem = data.deliveryItems[1]!;
    const weighed2 = applyBastWeights(
      data,
      [{ delivery_item_id: secondItem.id, qty_accepted_kg: 12.5, rejection_reason: null }],
      '2026-10-16T12:00:00.000Z'
    );
    if (!weighed2.ok) throw new Error(weighed2.error);
    data = weighed2.data;

    const paidRes = markInvoicePaid(data, invId, '2026-10-16T13:00:00.000Z');
    expect(paidRes.ok).toBe(true);
    if (!paidRes.ok) return;
    expect(paidRes.data.invoices[0]!.payment_status).toBe('PAID');
    expect(paidRes.data.ledgerEntries.every((le) => le.payout_status === 'AVAILABLE_FOR_PAYOUT')).toBe(true);
  });

  it('freezes split percentage on partial payout (executePayout TEAM) when updateProfitSplit is called later', () => {
    const ctx = makeCtx();
    // Create two orders: Order 1 (PAID) and Order 2 (UNPAID)
    let state = emptyState();
    const o1 = createKitchenOrder(
      state,
      {
        kitchen_id: 'kitchen-01',
        lines: [{ item_id: 'item-wortel', qty_ordered_kg: 10, kitchen_unit_price_rp: 14000, margin_per_kg_rp: 2000 }],
      },
      ctx
    );
    if (!o1.ok) throw new Error(o1.error);
    state = o1.data;

    const o2 = createKitchenOrder(
      state,
      {
        kitchen_id: 'kitchen-02',
        lines: [{ item_id: 'item-wortel', qty_ordered_kg: 10, kitchen_unit_price_rp: 14000, margin_per_kg_rp: 2000 }],
      },
      ctx
    );
    if (!o2.ok) throw new Error(o2.error);
    state = o2.data;

    const item1 = state.deliveryItems.find((di) => di.delivery_id === o1.delivery_id)!;
    const inv1 = state.invoices.find((inv) => inv.delivery_id === o1.delivery_id)!;
    const item2 = state.deliveryItems.find((di) => di.delivery_id === o2.delivery_id)!;

    // Weigh and mark Order 1 as PAID (at 60% Team : 40% Coop -> Rp 12.000 : Rp 8.000)
    const w1 = applyBastWeights(state, [{ delivery_item_id: item1.id, qty_accepted_kg: 10 }], '2026-10-16T11:00:00.000Z');
    if (!w1.ok) throw new Error(w1.error);
    const p1 = markInvoicePaid(w1.data, inv1.id, '2026-10-16T12:00:00.000Z');
    if (!p1.ok) throw new Error(p1.error);
    state = p1.data;

    // Execute partial payout for TEAM only -> Order 1 TEAM is PAID_OUT (12.000), COOPERATIVE is AVAILABLE_FOR_PAYOUT (8.000)
    const payoutRes = executePayout(state, 'TEAM', { ...ctx, nowIso: '2026-10-16T14:00:00.000Z' }, 'Cairkan Tim');
    if (!payoutRes.ok) throw new Error(payoutRes.error);
    state = payoutRes.data;

    // Now change global split to 50% : 50%
    const splitRes = updateProfitSplit(state, 50, 50, '2026-10-16T15:00:00.000Z');
    if (!splitRes.ok) throw new Error(splitRes.error);
    state = splitRes.data;

    // Order 1 has a partial payout -> its TEAM and COOPERATIVE shares MUST stay frozen at 60/40 (12.000 + 8.000 = 20.000)
    const o1Team = state.ledgerEntries.find((le) => le.delivery_item_id === item1.id && le.beneficiary_type === 'TEAM')!;
    const o1Coop = state.ledgerEntries.find(
      (le) => le.delivery_item_id === item1.id && le.beneficiary_type === 'COOPERATIVE'
    )!;
    expect(o1Team.payout_status).toBe('PAID_OUT');
    expect(o1Team.share_pct_snapshot).toBe(60);
    expect(o1Team.profit_amount).toBe(12000);
    expect(o1Coop.payout_status).toBe('AVAILABLE_FOR_PAYOUT');
    expect(o1Coop.share_pct_snapshot).toBe(40);
    expect(o1Coop.profit_amount).toBe(8000);
    expect(o1Team.profit_amount + o1Coop.profit_amount).toBe(20000);

    // Order 2 has no payouts -> its shares MUST update to 50/50 (10.000 + 10.000 = 20.000)
    const o2Team = state.ledgerEntries.find((le) => le.delivery_item_id === item2.id && le.beneficiary_type === 'TEAM')!;
    const o2Coop = state.ledgerEntries.find(
      (le) => le.delivery_item_id === item2.id && le.beneficiary_type === 'COOPERATIVE'
    )!;
    expect(o2Team.share_pct_snapshot).toBe(50);
    expect(o2Team.profit_amount).toBe(10000);
    expect(o2Coop.share_pct_snapshot).toBe(50);
    expect(o2Coop.profit_amount).toBe(10000);

    // Verify Supabase row round-trip preserves separate team_paid_out_at and coop_paid_out_at
    const rows = toSupabaseRows(state);
    const ple1 = rows.ledgerEntries.find((r) => r.order_item_id === item1.id)!;
    expect(ple1.team_paid_out).toBe(true);
    expect(ple1.coop_paid_out).toBe(false);
    expect(ple1.team_paid_out_at).toBe('2026-10-16T14:00:00.000Z');
    expect(ple1.coop_paid_out_at).toBeNull();

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
    const restoredTeam = restored.ledgerEntries.find(
      (le) => le.delivery_item_id === item1.id && le.beneficiary_type === 'TEAM'
    )!;
    const restoredCoop = restored.ledgerEntries.find(
      (le) => le.delivery_item_id === item1.id && le.beneficiary_type === 'COOPERATIVE'
    )!;
    expect(restoredTeam.paid_out_at).toBe('2026-10-16T14:00:00.000Z');
    expect(restoredCoop.paid_out_at).toBeNull();
  });
});
