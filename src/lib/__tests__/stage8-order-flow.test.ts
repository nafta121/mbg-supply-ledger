import { describe, expect, it } from 'vitest';
import {
  buildKitchenBastWaText,
  courierProgress,
  formatShortfallNote,
  formatVehicleLoad,
  groupCourierStops,
  summarizeVehicleLoad,
} from '../courier-view';
import { buildInvoiceLines, buildInvoiceProfit, buildInvoiceWaText, formatInvoiceLine, summarizeInvoice } from '../invoice-view';
import { BUSINESS_DATE, buildSafeCourierItems, createInitialSeedState, type MbgState } from '../mbg-store';
import {
  applyBastWeights,
  createKitchenOrder,
  deleteKitchenOrder,
  type EngineCtx,
  executePayout,
  markInvoicePaid,
  orderProgress,
  removeOrderLine,
  summarizeOrderDraft,
  updateProfitSplit,
} from '../order-engine';
import { ORDER_PROGRESS_LABEL, PAYOUT_LABEL, sumIdr } from '../ui-format';

function ctx(): EngineCtx {
  let n = 0;
  return { nowIso: '2026-10-16T10:00:00.000Z', today: BUSINESS_DATE, uid: (p) => `${p}-t${(n += 1)}` };
}

function ok<T>(res: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

/** Fresh state with no orders (master data only). */
function emptyState(): MbgState {
  const s = createInitialSeedState();
  return { ...s, deliveries: [], deliveryItems: [], invoices: [], ledgerEntries: [], payoutBatches: [] };
}

const wortel = { item_id: 'item-wortel', qty_ordered_kg: 35, kitchen_unit_price_rp: 14000, margin_per_kg_rp: 2000 };
const kubis = { item_id: 'item-kubis', qty_ordered_kg: 25, kitchen_unit_price_rp: 10000, margin_per_kg_rp: 1500 };

describe('Stage 8 — Order Dapur (multi-item)', () => {
  it('previews "2 jenis (60 kg) • Estimasi Tagihan Rp 740.000"', () => {
    expect(summarizeOrderDraft([wortel, kubis])).toEqual({
      item_count: 2,
      total_kg: 60,
      estimated_invoice: 740000,
      estimated_margin: 107500,
    });
    // Blank rows are ignored.
    expect(summarizeOrderDraft([wortel, { ...kubis, item_id: '' }]).item_count).toBe(1);
  });

  it('1 order = 1 delivery card + 1 combined UNPAID invoice + LOCKED_UNPAID ledger', () => {
    const c = ctx();
    const res = createKitchenOrder(emptyState(), { kitchen_id: 'kitchen-01', lines: [wortel, kubis] }, c);
    const s = ok(res);
    expect(s.deliveries).toHaveLength(1);
    expect(s.deliveryItems).toHaveLength(2);
    expect(s.invoices).toHaveLength(1);
    const inv = s.invoices[0]!;
    expect(inv.payment_status).toBe('UNPAID');
    expect(inv.total_invoice_amount).toBe(740000);
    expect(inv.invoice_number).toBe('INV-20261016-DPR01-01');
    expect(s.deliveries[0]!.delivery_number).toBe('SJ-20261016-DPR01-01');
    expect(s.ledgerEntries).toHaveLength(4);
    expect(s.ledgerEntries.every((le) => le.payout_status === 'LOCKED_UNPAID')).toBe(true);
    expect(sumIdr(s.ledgerEntries.map((le) => le.profit_amount))).toBe(107500);
    expect(orderProgress(s.deliveryItems)).toBe('WAITING_COURIER');
    expect(ORDER_PROGRESS_LABEL[orderProgress(s.deliveryItems)]).toBe('Menunggu Kurir');
  });

  it('merges a second order for the same kitchen into the open order & invoice', () => {
    const c = ctx();
    let s = ok(createKitchenOrder(emptyState(), { kitchen_id: 'kitchen-01', lines: [wortel] }, c));
    const res = createKitchenOrder(s, { kitchen_id: 'kitchen-01', lines: [kubis] }, c);
    expect(res.ok && res.merged).toBe(true);
    s = ok(res);
    expect(s.deliveries).toHaveLength(1);
    expect(s.invoices).toHaveLength(1);
    expect(s.invoices[0]!.total_invoice_amount).toBe(740000);
  });

  it('validates the order form and supports decimal kg orders (e.g. 12,5 kg and 0,2 kg)', () => {
    const c = ctx();
    const base = emptyState();
    const err = (lines: (typeof wortel)[], kitchen_id = 'kitchen-01') => {
      const r = createKitchenOrder(base, { kitchen_id, lines }, c);
      return r.ok ? null : r.error;
    };
    expect(err([wortel], 'nope')).toMatch(/dapur/);
    expect(err([])).toMatch(/minimal 1 barang/);
    expect(err([{ ...wortel, item_id: '' }])).toMatch(/Pilih nama barang/);
    expect(err([{ ...wortel, qty_ordered_kg: 0 }])).toMatch(/berat order/);
    expect(err([{ ...wortel, kitchen_unit_price_rp: 0 }])).toMatch(/Harga Dapur/);
    expect(err([{ ...wortel, margin_per_kg_rp: 20000 }])).toMatch(/melebihi/);
    expect(err([wortel, wortel])).toMatch(/sudah ada/);

    // Decimal order: Wortel 12.5 kg @ Rp 14.000 = Rp 175.000 + Kubis 0.2 kg @ Rp 50.000 = Rp 10.000
    const decState = ok(
      createKitchenOrder(
        base,
        {
          kitchen_id: 'kitchen-01',
          lines: [
            { item_id: 'item-wortel', qty_ordered_kg: 12.5, kitchen_unit_price_rp: 14000, margin_per_kg_rp: 2000 },
            { item_id: 'item-kubis', qty_ordered_kg: 0.2, kitchen_unit_price_rp: 50000, margin_per_kg_rp: 5000 },
          ],
        },
        c
      )
    );
    expect(decState.invoices[0]!.total_invoice_amount).toBe(185000);
    // Margin: 12.5 * 2000 (25.000) + 0.2 * 5000 (1.000) = 26.000 -> Tim 60% = 15.600, Koperasi 40% = 10.400
    const decProfit = buildInvoiceProfit(decState, decState.invoices[0]!.id);
    expect(decProfit).toMatchObject({
      total_margin: 26000,
      team_amount: 15600,
      coop_amount: 10400,
      total_accepted_kg: 12.7,
    });
  });

  it('removes a line (re-bills) and deletes the order when the last line goes', () => {
    const c = ctx();
    let s = ok(createKitchenOrder(emptyState(), { kitchen_id: 'kitchen-01', lines: [wortel, kubis] }, c));
    const kubisLine = s.deliveryItems.find((d) => d.item_id === 'item-kubis')!;
    s = ok(removeOrderLine(s, kubisLine.id, c.nowIso));
    expect(s.invoices[0]!.total_invoice_amount).toBe(490000);
    expect(s.ledgerEntries).toHaveLength(2);
    const last = s.deliveryItems[0]!;
    s = ok(removeOrderLine(s, last.id, c.nowIso));
    expect(s.deliveries).toHaveLength(0);
    expect(s.invoices).toHaveLength(0);
    expect(s.ledgerEntries).toHaveLength(0);
  });
});

describe('Stage 8 — Timbang kurir & Invoice Dapur berbasis bobot terima', () => {
  it('kirim Wortel 35 kg, diterima 33 kg → invoice hanya menagih 33 kg', () => {
    const c = ctx();
    let s = ok(createKitchenOrder(emptyState(), { kitchen_id: 'kitchen-01', lines: [wortel, kubis] }, c));
    const w = s.deliveryItems.find((d) => d.item_id === 'item-wortel')!;
    s = ok(applyBastWeights(s, [{ delivery_item_id: w.id, qty_accepted_kg: 33, rejection_reason: 'Barang Rusak/Reject' }], c.nowIso));

    expect(orderProgress(s.deliveryItems)).toBe('PARTIALLY_WEIGHED');
    const inv = s.invoices[0]!;
    // 33 × 14.000 + 25 × 10.000 (Kubis still estimated at order weight)
    expect(inv.total_invoice_amount).toBe(712000);

    const lines = buildInvoiceLines(s, inv);
    expect(formatInvoiceLine(lines.find((l) => l.item_name === 'Wortel')!)).toBe('Wortel: 33 kg × Rp 14.000 = Rp 462.000');
    expect(summarizeInvoice(lines).fully_weighed).toBe(false);
    expect(formatShortfallNote(35, 33)).toBe('Selisih/Reject -2 kg (Hanya ditagih 33 kg ke Dapur)');

    // Cannot mark Lunas until every line is weighed.
    const early = markInvoicePaid(s, inv.id, c.nowIso);
    expect(early.ok).toBe(false);

    const k = s.deliveryItems.find((d) => d.item_id === 'item-kubis')!;
    s = ok(applyBastWeights(s, [{ delivery_item_id: k.id, qty_accepted_kg: 25 }], c.nowIso));
    expect(orderProgress(s.deliveryItems)).toBe('BAST_DONE');
    expect(s.deliveries[0]!.status).toBe('BAST_VERIFIED');
    expect(s.invoices[0]!.total_invoice_amount).toBe(712000);

    // Bagi hasil = accepted × margin: 33×2.000 + 25×1.500 = 103.500 → Tim 62.100 / Koperasi 41.400
    const profit = buildInvoiceProfit(s, inv.id);
    expect(profit).toMatchObject({ total_margin: 103500, team_amount: 62100, coop_amount: 41400, total_accepted_kg: 58 });
    expect(profit.team_status).toBe('LOCKED_UNPAID');
  });

  it('rejects weights above the order and supports decimal accepted weights (e.g. 33.4 kg)', () => {
    const c = ctx();
    const s = ok(createKitchenOrder(emptyState(), { kitchen_id: 'kitchen-02', lines: [wortel] }, c));
    const w = s.deliveryItems[0]!;
    const over = applyBastWeights(s, [{ delivery_item_id: w.id, qty_accepted_kg: 36 }], c.nowIso);
    expect(over.ok).toBe(false);
    const dec = ok(applyBastWeights(s, [{ delivery_item_id: w.id, qty_accepted_kg: 33.4 }], c.nowIso));
    expect(dec.deliveryItems[0]!.qty_accepted_kg).toBe(33.4);
    expect(dec.deliveryItems[0]!.qty_shrinkage_kg).toBe(1.6);
    expect(dec.invoices[0]!.total_invoice_amount).toBe(467600);
  });
});

describe('Stage 8 — Bagi hasil cash-basis (Menunggu Dapur Bayar → Siap Dicairkan)', () => {
  it('Tandai Lunas unlocks ledger; payout only from AVAILABLE rows; paid orders are frozen', () => {
    const c = ctx();
    let s = ok(createKitchenOrder(emptyState(), { kitchen_id: 'kitchen-01', lines: [wortel, kubis] }, c));
    s = ok(
      applyBastWeights(
        s,
        s.deliveryItems.map((d) => ({ delivery_item_id: d.id, qty_accepted_kg: d.qty_dispatched_kg })),
        c.nowIso
      )
    );
    const inv = s.invoices[0]!;
    expect(PAYOUT_LABEL[s.ledgerEntries[0]!.payout_status]).toBe('Menunggu Dapur Bayar');
    expect(executePayout(s, 'TEAM', c).ok).toBe(false);

    s = ok(markInvoicePaid(s, inv.id, c.nowIso));
    expect(s.invoices[0]!.payment_status).toBe('PAID');
    expect(s.invoices[0]!.amount_paid).toBe(740000);
    expect(s.ledgerEntries.every((le) => le.payout_status === 'AVAILABLE_FOR_PAYOUT')).toBe(true);
    expect(PAYOUT_LABEL.AVAILABLE_FOR_PAYOUT).toBe('Siap Dicairkan');

    // Frozen after Lunas.
    expect(applyBastWeights(s, [{ delivery_item_id: s.deliveryItems[0]!.id, qty_accepted_kg: 1 }], c.nowIso).ok).toBe(false);
    expect(removeOrderLine(s, s.deliveryItems[0]!.id, c.nowIso).ok).toBe(false);
    expect(deleteKitchenOrder(s, s.deliveries[0]!.id).ok).toBe(false);
    // A new order for the same kitchen opens a fresh order/invoice.
    const s2 = ok(createKitchenOrder(s, { kitchen_id: 'kitchen-01', lines: [wortel] }, c));
    expect(s2.invoices).toHaveLength(2);
    expect(s2.invoices[1]!.invoice_number).toBe('INV-20261016-DPR01-02');

    s = ok(executePayout(s, 'TEAM', c));
    expect(s.payoutBatches[0]!.total_payout_amount).toBe(64500);
    const team = s.ledgerEntries.filter((le) => le.beneficiary_type === 'TEAM');
    const coop = s.ledgerEntries.filter((le) => le.beneficiary_type === 'COOPERATIVE');
    expect(team.every((le) => le.payout_status === 'PAID_OUT')).toBe(true);
    expect(coop.every((le) => le.payout_status === 'AVAILABLE_FOR_PAYOUT')).toBe(true);

    // Changing the split never rewrites lines that were (partly) paid out:
    // Tim + Koperasi stays exactly the line margin (no over-distribution).
    s = ok(updateProfitSplit(s, 50, 50, c.nowIso));
    expect(sumIdr(s.ledgerEntries.filter((le) => le.beneficiary_type === 'TEAM').map((le) => le.profit_amount))).toBe(64500);
    expect(sumIdr(s.ledgerEntries.filter((le) => le.beneficiary_type === 'COOPERATIVE').map((le) => le.profit_amount))).toBe(43000);
    // …while open orders do follow the new split.
    const withOpen = ok(createKitchenOrder(s, { kitchen_id: 'kitchen-02', lines: [wortel] }, c));
    const open = withOpen.ledgerEntries.filter((le) => le.invoice_id === withOpen.invoices[1]!.id);
    expect(open.map((le) => le.profit_amount)).toEqual([35000, 35000]);
    expect(updateProfitSplit(s, 60, 30, c.nowIso).ok).toBe(false);
  });
});

describe('Stage 8 — seed scenario (16 Okt 2026)', () => {
  const seed = createInitialSeedState();
  const safe = buildSafeCourierItems(seed);
  const stops = groupCourierStops(safe);

  it('lands Admin on "Order Dapur" with 5 orders, 1 card & 1 invoice each', () => {
    expect(seed.activeTab).toBe('orders');
    expect(seed.deliveries).toHaveLength(5);
    expect(seed.invoices).toHaveLength(5);
    expect(stops).toHaveLength(5);
    expect(stops.map((s) => s.kitchen_code)).toEqual(['DPR-01', 'DPR-02', 'DPR-03', 'DPR-04', 'DPR-05']);
  });

  it('total muatan kurir: Wortel 105 kg • Kubis 75 kg • Daging Ayam 150 kg', () => {
    const load = summarizeVehicleLoad(safe);
    const kg = Object.fromEntries(load.map((l) => [l.item_name, l.qty_dispatched_kg]));
    expect(kg).toEqual({ Wortel: 105, Kubis: 75, 'Daging Ayam Fillet': 150, 'Telur Ayam': 45, Beras: 50 });
    expect(formatVehicleLoad(load)).toContain('Wortel: 105 kg');
    expect(courierProgress(stops)).toEqual({ done: 3, total: 5, total_shrinkage_kg: 3 });
  });

  it('order statuses: Selesai BAST / Menunggu Kurir / Sebagian Tertimbang', () => {
    const progress = (code: string) => {
      const d = seed.deliveries.find((x) => seed.kitchens.find((k) => k.id === x.kitchen_id)?.kitchen_code === code)!;
      return orderProgress(seed.deliveryItems.filter((di) => di.delivery_id === d.id));
    };
    expect(progress('DPR-01')).toBe('BAST_DONE');
    expect(progress('DPR-03')).toBe('BAST_DONE');
    expect(progress('DPR-04')).toBe('WAITING_COURIER');
    expect(progress('DPR-05')).toBe('PARTIALLY_WEIGHED');
  });

  it('DPR-01 invoice: Wortel 35 × 14.000 + Kubis 25 × 10.000 = Rp 740.000 (Lunas) with bank account and no Jatuh Tempo', () => {
    const inv = seed.invoices.find((i) => i.kitchen_id === 'kitchen-01')!;
    expect(inv.payment_status).toBe('PAID');
    expect(buildInvoiceLines(seed, inv).map(formatInvoiceLine)).toEqual([
      'Wortel: 35 kg × Rp 14.000 = Rp 490.000',
      'Kubis: 25 kg × Rp 10.000 = Rp 250.000',
    ]);
    expect(inv.total_invoice_amount).toBe(740000);
    const wa = buildInvoiceWaText(seed, inv);
    expect(wa).toContain('Total Tagihan: Rp 740.000');
    expect(wa).toContain('Status: Lunas');
    expect(wa).toContain('TRANSFER PEMBAYARAN KE REKENING:');
    expect(wa).toContain('BRI • 0000-0000-0000-000');
    expect(wa).toContain('a.n. Bendahara Supplier MBG');
    expect(wa).not.toMatch(/jatuh tempo/i);
    expect(wa).not.toContain(',00');

    // Custom configurable bank account on unpaid invoice
    const unpaidInv = seed.invoices.find((i) => i.kitchen_id === 'kitchen-03')!;
    const customState = {
      ...seed,
      splitConfig: {
        ...seed.splitConfig,
        payment_bank_name: 'BCA',
        payment_account_number: '8888-9999-00',
        payment_account_holder: 'Koperasi MBG Pusat',
      },
    };
    const customWa = buildInvoiceWaText(customState, unpaidInv);
    expect(customWa).toContain('BCA • 8888-9999-00');
    expect(customWa).toContain('a.n. Koperasi MBG Pusat');
    expect(customWa).not.toMatch(/jatuh tempo/i);
  });

  it('bagi hasil: Siap Dicairkan Tim Rp 218.100 / Koperasi Rp 145.400; sisanya Menunggu Dapur Bayar', () => {
    const sum = (status: string, who: string) =>
      sumIdr(
        seed.ledgerEntries
          .filter((le) => le.payout_status === status && le.beneficiary_type === who)
          .map((le) => le.profit_amount)
      );
    expect(sum('AVAILABLE_FOR_PAYOUT', 'TEAM')).toBe(218100);
    expect(sum('AVAILABLE_FOR_PAYOUT', 'COOPERATIVE')).toBe(145400);
    // DPR-03 141.000 + DPR-04 (35×2.000 + 50×1.500 + 50×4.000 = 345.000) + DPR-05 (50×4.000 + 25×3.000 = 275.000)
    expect(sumIdr([sum('LOCKED_UNPAID', 'TEAM'), sum('LOCKED_UNPAID', 'COOPERATIVE')])).toBe(761000);
  });

  it('WA BAST is kg-only (no rupiah) and explains the shortfall is not billed', () => {
    const dpr03 = stops.find((s) => s.kitchen_code === 'DPR-03')!;
    const text = buildKitchenBastWaText(dpr03);
    expect(text).not.toMatch(/Rp/);
    expect(text).toContain('Wortel: order 35 kg, diterima 33 kg (selisih -2 kg');
    expect(text).toContain('tidak ditagihkan ke dapur');
    expect(text).not.toMatch(/supplier/i);
  });
});

