/**
 * Stage 8 — Order-Driven Flow engine (pure, framework-free).
 *
 * Order Dapur -> Timbang BAST Kurir -> Invoice Dapur Gabungan -> Bagi Hasil (Tim & Koperasi).
 * There is NO supplier stock batch and NO supplier settlement in Phase 1.
 *
 * Every transition takes the current data and returns a NEW data object
 * (or an error). The React store (`mbg-store.ts`) only wraps these with
 * `setState`, so all business rules are unit-testable here:
 * - Invariant 1: dynamic decimal kg weights (up to 3 decimals, no trailing zeros), exact sen arithmetic (financial-engine).
 * - Invariant 2: kitchens are billed only for `qty_accepted_kg`.
 * - Invariant 3: kitchen price & margin are snapshotted per order line.
 * - Invariant 4: ledger stays LOCKED_UNPAID until the invoice is PAID.
 * - Invariant 5: `buildSafeCourierItems` is the price-free courier projection.
 */
import type {
  BeneficiaryType,
  Item,
  Kitchen,
  KitchenDelivery,
  KitchenDeliveryItem,
  KitchenInvoice,
  OrderProgress,
  ProfitLedgerEntry,
  ProfitPayoutBatch,
  ProfitSplitConfig,
  SafeCourierBastItem,
} from '../types/mbg';
import {
  calculateProfitSplitEntry,
  gramsToKg,
  idrToSen,
  kgToGrams,
  multiplyWeightGramsByPriceSen,
  pctToBasisPoints,
  reconcileKitchenOrderLine,
  roundKg,
  sanitizeDeliveryForFieldTeam,
  senToIdr,
} from './financial-engine';

export interface MbgData {
  kitchens: Kitchen[];
  items: Item[];
  deliveries: KitchenDelivery[];
  deliveryItems: KitchenDeliveryItem[];
  invoices: KitchenInvoice[];
  splitConfig: ProfitSplitConfig;
  ledgerEntries: ProfitLedgerEntry[];
  payoutBatches: ProfitPayoutBatch[];
}

export interface EngineCtx {
  nowIso: string;
  /** Business date of the order (YYYY-MM-DD). */
  today: string;
  /** Unique id generator: `uid('deliv')` → `deliv-…`. */
  uid: (prefix: string) => string;
}

export type EngineResult<T extends MbgData> =
  | { ok: true; data: T; delivery_id?: string; merged?: boolean; count?: number }
  | { ok: false; error: string };

export interface OrderLineInput {
  item_id: string;
  qty_ordered_kg: number;
  kitchen_unit_price_rp: number;
  margin_per_kg_rp: number;
}

export interface CreateOrderInput {
  kitchen_id: string;
  lines: OrderLineInput[];
}

export interface UpdateBastInput {
  delivery_item_id: string;
  qty_accepted_kg: number;
  rejection_reason?: string | null;
  bast_signed_by_name?: string;
}

const DUE_DAYS = 7;

// ---------- Small helpers ----------

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function compactDate(isoDate: string): string {
  return isoDate.replace(/-/g, '');
}

function isPaid(inv: KitchenInvoice | undefined): boolean {
  return inv?.payment_status === 'PAID';
}

export function invoiceForDelivery(data: Pick<MbgData, 'invoices'>, deliveryId: string) {
  return data.invoices.find((i) => i.delivery_id === deliveryId);
}

export function linesForDelivery(data: Pick<MbgData, 'deliveryItems'>, deliveryId: string) {
  return data.deliveryItems.filter((di) => di.delivery_id === deliveryId);
}

/** Menunggu Kurir / Sebagian Tertimbang / Selesai BAST. */
export function orderProgress(lines: Array<Pick<KitchenDeliveryItem, 'weighed_at'>>): OrderProgress {
  const weighed = lines.filter((l) => l.weighed_at !== null).length;
  if (lines.length > 0 && weighed === lines.length) return 'BAST_DONE';
  if (weighed > 0) return 'PARTIALLY_WEIGHED';
  return 'WAITING_COURIER';
}

export function isOrderFullyWeighed(data: Pick<MbgData, 'deliveryItems'>, deliveryId: string): boolean {
  return orderProgress(linesForDelivery(data, deliveryId)) === 'BAST_DONE';
}

export interface OrderDraftSummary {
  item_count: number;
  total_kg: number;
  estimated_invoice: number;
  estimated_margin: number;
}

/** "Total Barang: 2 jenis (60 kg) • Estimasi Tagihan Dapur: Rp 740.000" — exact grams/sen. */
export function summarizeOrderDraft(lines: OrderLineInput[]): OrderDraftSummary {
  let grams = 0n;
  let invoiceSen = 0n;
  let marginSen = 0n;
  let count = 0;
  for (const l of lines) {
    const kg = roundKg(l.qty_ordered_kg);
    if (!l.item_id || kg <= 0) continue;
    count += 1;
    const g = kgToGrams(kg);
    grams += g;
    const price = Number.isFinite(l.kitchen_unit_price_rp) ? l.kitchen_unit_price_rp : 0;
    const margin = Number.isFinite(l.margin_per_kg_rp) ? l.margin_per_kg_rp : 0;
    invoiceSen += multiplyWeightGramsByPriceSen(g, idrToSen(price));
    marginSen += multiplyWeightGramsByPriceSen(g, idrToSen(margin));
  }
  return {
    item_count: count,
    total_kg: gramsToKg(grams),
    estimated_invoice: senToIdr(invoiceSen),
    estimated_margin: senToIdr(marginSen),
  };
}

/** Open (not yet Lunas) order of a kitchen — new lines are merged into it. */
export function findOpenOrder(
  data: Pick<MbgData, 'deliveries' | 'invoices'>,
  kitchenId: string,
  date?: string
): KitchenDelivery | undefined {
  return data.deliveries.find(
    (d) =>
      d.kitchen_id === kitchenId &&
      (date ? d.delivery_date === date : true) &&
      !isPaid(invoiceForDelivery(data, d.id))
  );
}

// ---------- Validation ----------

export function validateOrderLines(
  data: Pick<MbgData, 'items'>,
  lines: OrderLineInput[],
  existingItemIds: string[] = []
): string | null {
  if (lines.length === 0) return 'Tambahkan minimal 1 barang.';
  const seen = new Set(existingItemIds);
  for (const l of lines) {
    const item = data.items.find((i) => i.id === l.item_id);
    if (!item) return 'Pilih nama barang di setiap baris.';
    const name = item.name;
    if (seen.has(item.id)) return `${name} sudah ada di order dapur ini.`;
    seen.add(item.id);
    const qty = roundKg(l.qty_ordered_kg);
    if (!Number.isFinite(l.qty_ordered_kg) || qty <= 0) {
      return `${name}: isi berat order (kg).`;
    }
    if (!Number.isFinite(l.kitchen_unit_price_rp) || l.kitchen_unit_price_rp <= 0) {
      return `${name}: isi Harga Dapur / kg.`;
    }
    if (!Number.isFinite(l.margin_per_kg_rp) || l.margin_per_kg_rp < 0) {
      return `${name}: margin tidak boleh negatif.`;
    }
    if (idrToSen(l.margin_per_kg_rp) > idrToSen(l.kitchen_unit_price_rp)) {
      return `${name}: margin tidak boleh melebihi harga dapur.`;
    }
  }
  return null;
}

// ---------- Derived recomputation (invoice total + ledger) ----------

/**
 * Recomputes everything derived from one order: delivery status, invoice total
 * (Σ accepted × price) and the profit ledger (Σ accepted × margin, split Tim/Koperasi).
 * PAID_OUT ledger rows are never touched (immutable history).
 */
export function recomputeOrder<T extends MbgData>(data: T, deliveryId: string, nowIso: string): T {
  const delivery = data.deliveries.find((d) => d.id === deliveryId);
  const invoice = invoiceForDelivery(data, deliveryId);
  if (!delivery || !invoice) return data;
  const lines = linesForDelivery(data, deliveryId);

  let totalSen = 0n;
  for (const l of lines) totalSen += idrToSen(l.line_invoice_amount);
  const total = senToIdr(totalSen);
  const paid = isPaid(invoice);

  const progress = orderProgress(lines);
  const nextDeliveries = data.deliveries.map((d) => {
    if (d.id !== deliveryId) return d;
    const done = progress === 'BAST_DONE';
    return {
      ...d,
      status: done ? ('BAST_VERIFIED' as const) : ('IN_TRANSIT' as const),
      bast_verified_at: done ? d.bast_verified_at ?? nowIso : null,
      updated_at: nowIso,
    };
  });

  const nextInvoices = data.invoices.map((inv) =>
    inv.id === invoice.id
      ? {
          ...inv,
          total_invoice_amount: total,
          amount_paid: paid ? total : inv.amount_paid,
          updated_at: nowIso,
        }
      : inv
  );

  const lineIds = new Set(lines.map((l) => l.id));
  const others = data.ledgerEntries.filter(
    (le) => le.invoice_id !== invoice.id || (!lineIds.has(le.delivery_item_id) && le.payout_status === 'PAID_OUT')
  );
  const orderEntries = data.ledgerEntries.filter((le) => le.invoice_id === invoice.id);
  const hasOrderPaidOut = orderEntries.some((le) => le.payout_status === 'PAID_OUT');
  const effectiveTeamPct = hasOrderPaidOut
    ? (orderEntries.find((le) => le.beneficiary_type === 'TEAM')?.share_pct_snapshot ?? data.splitConfig.team_share_pct)
    : data.splitConfig.team_share_pct;
  const effectiveCoopPct = hasOrderPaidOut
    ? (orderEntries.find((le) => le.beneficiary_type === 'COOPERATIVE')?.share_pct_snapshot ??
        data.splitConfig.cooperative_share_pct)
    : data.splitConfig.cooperative_share_pct;

  const rebuilt: ProfitLedgerEntry[] = [];
  for (const line of lines) {
    // Once any share of the order or line is paid out, both shares keep their snapshot so
    // Tim + Koperasi always equals the line margin (no over-distribution, Invariant 4).
    const lineEntries = data.ledgerEntries.filter((le) => le.delivery_item_id === line.id);
    if ((hasOrderPaidOut || lineEntries.some((le) => le.payout_status === 'PAID_OUT')) && lineEntries.length === 2) {
      rebuilt.push(...lineEntries);
      continue;
    }
    const split = calculateProfitSplitEntry({
      qty_accepted_kg: line.qty_accepted_kg,
      margin_per_kg_rp: line.margin_per_kg_snapshot,
      team_share_pct: effectiveTeamPct,
      cooperative_share_pct: effectiveCoopPct,
      invoice_payment_status: invoice.payment_status,
    });
    for (const who of ['TEAM', 'COOPERATIVE'] as const) {
      const existing = lineEntries.find((le) => le.beneficiary_type === who);
      if (existing?.payout_status === 'PAID_OUT') {
        rebuilt.push(existing);
        continue;
      }
      rebuilt.push({
        id: existing?.id ?? `ledger-${line.id}-${who === 'TEAM' ? 'team' : 'coop'}`,
        invoice_id: invoice.id,
        delivery_item_id: line.id,
        split_config_id: data.splitConfig.id,
        beneficiary_type: who,
        qty_accepted_kg: split.qty_accepted_kg,
        unit_markup_snapshot: split.margin_per_kg,
        share_pct_snapshot: who === 'TEAM' ? split.team_share_pct : split.cooperative_share_pct,
        profit_amount: who === 'TEAM' ? split.team_share_amount : split.koperasi_share_amount,
        payout_status: split.payout_status,
        payout_batch_id: null,
        unlocked_at: split.payout_status === 'AVAILABLE_FOR_PAYOUT' ? existing?.unlocked_at ?? nowIso : null,
        paid_out_at: null,
        created_at: existing?.created_at ?? nowIso,
        updated_at: nowIso,
      });
    }
  }

  return {
    ...data,
    deliveries: nextDeliveries,
    invoices: nextInvoices,
    ledgerEntries: [...others, ...rebuilt],
  };
}

// ---------- Transitions ----------

function buildLine(
  deliveryId: string,
  input: OrderLineInput,
  id: string,
  nowIso: string
): KitchenDeliveryItem {
  const qty = roundKg(input.qty_ordered_kg);
  // Accepted defaults to the ordered weight (estimate) until the courier weighs it.
  const r = reconcileKitchenOrderLine({
    qty_ordered_kg: qty,
    qty_accepted_kg: qty,
    kitchen_unit_price_rp: input.kitchen_unit_price_rp,
    margin_per_kg_rp: input.margin_per_kg_rp,
  });
  return {
    id,
    delivery_id: deliveryId,
    item_id: input.item_id,
    qty_dispatched_kg: r.qty_ordered_kg,
    qty_accepted_kg: r.qty_accepted_kg,
    qty_shrinkage_kg: r.qty_shrinkage_kg,
    kitchen_unit_price_snapshot: r.kitchen_unit_price_rp,
    margin_per_kg_snapshot: r.margin_per_kg_rp,
    line_invoice_amount: r.line_invoice_amount,
    line_margin_amount: r.line_margin_amount,
    weighed_at: null,
    rejection_reason: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

function nextDocNumber(prefix: string, base: string, taken: string[]): string {
  const set = new Set(taken);
  let n = 1;
  let code = `${prefix}-${base}-${String(n).padStart(2, '0')}`;
  while (set.has(code)) {
    n += 1;
    code = `${prefix}-${base}-${String(n).padStart(2, '0')}`;
  }
  return code;
}

/**
 * "Simpan Order & Kirim ke Daftar Kurir": creates 1 Order Dapur (multi-barang)
 * + 1 Invoice Dapur Gabungan (UNPAID) + LOCKED_UNPAID ledger rows. If the
 * kitchen already has an open (not Lunas) order today, lines are merged into it.
 */
export function createKitchenOrder<T extends MbgData>(
  data: T,
  input: CreateOrderInput,
  ctx: EngineCtx
): EngineResult<T> {
  const kitchen = data.kitchens.find((k) => k.id === input.kitchen_id);
  if (!kitchen) return { ok: false, error: 'Pilih dapur tujuan.' };

  const lines = input.lines.map((l) => ({
    ...l,
    qty_ordered_kg: Number.isFinite(l.qty_ordered_kg) ? roundKg(l.qty_ordered_kg) : 0,
    kitchen_unit_price_rp: senToIdr(idrToSen(Number.isFinite(l.kitchen_unit_price_rp) ? l.kitchen_unit_price_rp : 0)),
    margin_per_kg_rp: senToIdr(idrToSen(Number.isFinite(l.margin_per_kg_rp) ? l.margin_per_kg_rp : 0)),
  }));

  const open = findOpenOrder(data, kitchen.id, ctx.today);
  const existingItemIds = open ? linesForDelivery(data, open.id).map((l) => l.item_id) : [];
  const error = validateOrderLines(data, lines, existingItemIds);
  if (error) return { ok: false, error };

  let next: T = data;
  let deliveryId: string;

  if (open) {
    deliveryId = open.id;
  } else {
    deliveryId = ctx.uid('deliv');
    const base = `${compactDate(ctx.today)}-${kitchen.kitchen_code.replace('-', '')}`;
    const deliveryNumber = nextDocNumber('SJ', base, data.deliveries.map((d) => d.delivery_number));
    const invoiceNumber = nextDocNumber('INV', base, data.invoices.map((i) => i.invoice_number));
    const delivery: KitchenDelivery = {
      id: deliveryId,
      delivery_number: deliveryNumber,
      kitchen_id: kitchen.id,
      delivery_date: ctx.today,
      status: 'IN_TRANSIT',
      courier_user_id: 'field-1',
      bast_signed_by_name: kitchen.pic_name,
      bast_photo_url: null,
      bast_verified_at: null,
      notes: null,
      created_at: ctx.nowIso,
      updated_at: ctx.nowIso,
    };
    const invoice: KitchenInvoice = {
      id: ctx.uid('inv'),
      invoice_number: invoiceNumber,
      kitchen_id: kitchen.id,
      delivery_id: deliveryId,
      invoice_date: ctx.today,
      due_date: addDays(ctx.today, DUE_DAYS),
      total_invoice_amount: 0,
      amount_paid: 0,
      payment_status: 'UNPAID',
      payment_proof_url: null,
      paid_at: null,
      verified_by: null,
      payment_bank_name: data.splitConfig.payment_bank_name ?? 'BRI',
      payment_account_number: data.splitConfig.payment_account_number ?? '0000-0000-0000-000',
      payment_account_holder: data.splitConfig.payment_account_holder ?? 'Bendahara Supplier MBG',
      created_at: ctx.nowIso,
      updated_at: ctx.nowIso,
    };
    next = { ...next, deliveries: [...next.deliveries, delivery], invoices: [...next.invoices, invoice] };
  }

  const newLines = lines.map((l) => buildLine(deliveryId, l, ctx.uid('ditem'), ctx.nowIso));
  next = { ...next, deliveryItems: [...next.deliveryItems, ...newLines] };
  next = recomputeOrder(next, deliveryId, ctx.nowIso);
  return { ok: true, data: next, delivery_id: deliveryId, merged: !!open, count: newLines.length };
}

/**
 * "💾 Simpan Timbangan Dapur" / "✓ Terima Sesuai Order": saves BAST weights.
 * Kitchen invoice is re-billed to accepted kg only (selisih/reject never billed).
 */
export function applyBastWeights<T extends MbgData>(
  data: T,
  inputs: UpdateBastInput[],
  nowIso: string
): EngineResult<T> {
  if (inputs.length === 0) return { ok: false, error: 'Tidak ada timbangan untuk disimpan.' };
  const touched = new Set<string>();
  const updates = new Map<string, KitchenDeliveryItem>();

  for (const input of inputs) {
    const line = data.deliveryItems.find((di) => di.id === input.delivery_item_id);
    if (!line) return { ok: false, error: 'Barang tidak ditemukan.' };
    const itemName = data.items.find((i) => i.id === line.item_id)?.name ?? 'Barang';
    if (isPaid(invoiceForDelivery(data, line.delivery_id))) {
      return { ok: false, error: `${itemName}: invoice dapur sudah lunas, timbangan terkunci.` };
    }
    if (!Number.isFinite(input.qty_accepted_kg) || input.qty_accepted_kg < 0) {
      return { ok: false, error: `${itemName}: isi berat diterima (kg).` };
    }
    const accepted = roundKg(input.qty_accepted_kg);
    if (accepted > roundKg(line.qty_dispatched_kg)) {
      return { ok: false, error: `${itemName}: berat diterima melebihi berat order.` };
    }
    const r = reconcileKitchenOrderLine({
      qty_ordered_kg: line.qty_dispatched_kg,
      qty_accepted_kg: accepted,
      kitchen_unit_price_rp: line.kitchen_unit_price_snapshot,
      margin_per_kg_rp: line.margin_per_kg_snapshot,
    });
    updates.set(line.id, {
      ...line,
      qty_accepted_kg: r.qty_accepted_kg,
      qty_shrinkage_kg: r.qty_shrinkage_kg,
      line_invoice_amount: r.line_invoice_amount,
      line_margin_amount: r.line_margin_amount,
      weighed_at: nowIso,
      rejection_reason:
        r.qty_shrinkage_kg > 0 ? input.rejection_reason?.trim() || 'Selisih/Reject saat timbang BAST' : null,
      updated_at: nowIso,
    });
    touched.add(line.delivery_id);
  }

  let next: T = {
    ...data,
    deliveryItems: data.deliveryItems.map((di) => updates.get(di.id) ?? di),
    deliveries: data.deliveries.map((d) => {
      if (!touched.has(d.id)) return d;
      const signer = inputs.find((i) => i.bast_signed_by_name)?.bast_signed_by_name;
      return signer ? { ...d, bast_signed_by_name: signer } : d;
    }),
  };
  for (const id of touched) next = recomputeOrder(next, id, nowIso);
  return { ok: true, data: next, count: updates.size };
}

/** Removes one line from an open order. Removing the last line deletes the whole order. */
export function removeOrderLine<T extends MbgData>(
  data: T,
  deliveryItemId: string,
  nowIso: string
): EngineResult<T> {
  const line = data.deliveryItems.find((di) => di.id === deliveryItemId);
  if (!line) return { ok: false, error: 'Barang tidak ditemukan.' };
  const invoice = invoiceForDelivery(data, line.delivery_id);
  if (isPaid(invoice)) {
    return { ok: false, error: 'Invoice dapur sudah lunas — order tidak bisa diubah.' };
  }
  if (data.ledgerEntries.some((le) => le.delivery_item_id === deliveryItemId && le.payout_status === 'PAID_OUT')) {
    return { ok: false, error: 'Bagi hasil barang ini sudah dicairkan — order tidak bisa diubah.' };
  }
  if (linesForDelivery(data, line.delivery_id).length <= 1) {
    return deleteKitchenOrder(data, line.delivery_id);
  }
  const next: T = {
    ...data,
    deliveryItems: data.deliveryItems.filter((di) => di.id !== deliveryItemId),
    ledgerEntries: data.ledgerEntries.filter((le) => le.delivery_item_id !== deliveryItemId),
  };
  return { ok: true, data: recomputeOrder(next, line.delivery_id, nowIso) };
}

/** Deletes an open order with its invoice and ledger rows (never a Lunas or paid-out order). */
export function deleteKitchenOrder<T extends MbgData>(data: T, deliveryId: string): EngineResult<T> {
  const delivery = data.deliveries.find((d) => d.id === deliveryId);
  if (!delivery) return { ok: false, error: 'Order tidak ditemukan.' };
  const invoice = invoiceForDelivery(data, deliveryId);
  if (isPaid(invoice)) return { ok: false, error: 'Invoice dapur sudah lunas — order tidak bisa dihapus.' };
  if (invoice && data.ledgerEntries.some((le) => le.invoice_id === invoice.id && le.payout_status === 'PAID_OUT')) {
    return { ok: false, error: 'Sebagian bagi hasil sudah dicairkan — order tidak bisa dihapus.' };
  }
  return {
    ok: true,
    data: {
      ...data,
      deliveries: data.deliveries.filter((d) => d.id !== deliveryId),
      deliveryItems: data.deliveryItems.filter((di) => di.delivery_id !== deliveryId),
      invoices: data.invoices.filter((i) => i.delivery_id !== deliveryId),
      ledgerEntries: invoice ? data.ledgerEntries.filter((le) => le.invoice_id !== invoice.id) : data.ledgerEntries,
    },
  };
}

/**
 * "✓ Tandai Lunas" — Invariant 4 atomic trigger simulation:
 * invoice PAID ⇒ all its ledger rows LOCKED_UNPAID → AVAILABLE_FOR_PAYOUT.
 * Only allowed once every line of the order has been weighed (final billing).
 */
export function markInvoicePaid<T extends MbgData>(data: T, invoiceId: string, nowIso: string): EngineResult<T> {
  const invoice = data.invoices.find((i) => i.id === invoiceId);
  if (!invoice) return { ok: false, error: 'Invoice tidak ditemukan.' };
  if (isPaid(invoice)) return { ok: false, error: 'Invoice sudah lunas.' };
  if (!isOrderFullyWeighed(data, invoice.delivery_id)) {
    return { ok: false, error: 'Belum semua barang ditimbang kurir — tagihan belum final.' };
  }
  if (idrToSen(invoice.total_invoice_amount) <= 0n) {
    return { ok: false, error: 'Total tagihan Rp 0 tidak bisa ditandai lunas.' };
  }
  return {
    ok: true,
    data: {
      ...data,
      invoices: data.invoices.map((inv) =>
        inv.id === invoiceId
          ? {
              ...inv,
              amount_paid: inv.total_invoice_amount,
              payment_status: 'PAID' as const,
              payment_proof_url: `https://storage.mbg.local/payments/${inv.invoice_number}.pdf`,
              paid_at: nowIso,
              verified_by: 'finance-1',
              updated_at: nowIso,
            }
          : inv
      ),
      ledgerEntries: data.ledgerEntries.map((le) =>
        le.invoice_id === invoiceId && le.payout_status === 'LOCKED_UNPAID'
          ? { ...le, payout_status: 'AVAILABLE_FOR_PAYOUT' as const, unlocked_at: nowIso, updated_at: nowIso }
          : le
      ),
    },
  };
}

/** Changes Tim/Koperasi split for every not-yet-paid-out ledger row. */
export function updateProfitSplit<T extends MbgData>(
  data: T,
  teamPct: number,
  coopPct: number,
  nowIso: string
): EngineResult<T> {
  if (pctToBasisPoints(teamPct) + pctToBasisPoints(coopPct) !== 10000n || teamPct < 0 || coopPct < 0) {
    return { ok: false, error: 'Porsi Tim + Koperasi wajib 100%.' };
  }
  let next: T = { ...data, splitConfig: { ...data.splitConfig, team_share_pct: teamPct, cooperative_share_pct: coopPct } };
  for (const d of next.deliveries) next = recomputeOrder(next, d.id, nowIso);
  return { ok: true, data: next };
}

/** Pencairan bagi hasil: only AVAILABLE_FOR_PAYOUT rows (from Lunas invoices) can be paid out. */
export function executePayout<T extends MbgData>(
  data: T,
  who: BeneficiaryType | 'BOTH',
  ctx: Pick<EngineCtx, 'nowIso' | 'today' | 'uid'>,
  notes?: string
): EngineResult<T> {
  if (who === 'BOTH') {
    const teamRes = executePayout(data, 'TEAM', ctx, notes);
    const coopRes = executePayout(teamRes.ok ? teamRes.data : data, 'COOPERATIVE', ctx, notes);
    if (!teamRes.ok && !coopRes.ok) return teamRes;
    return {
      ok: true,
      data: coopRes.ok ? coopRes.data : (teamRes as { ok: true; data: T }).data,
      count: (teamRes.ok ? (teamRes.count ?? 0) : 0) + (coopRes.ok ? (coopRes.count ?? 0) : 0),
    };
  }
  const eligible = data.ledgerEntries.filter(
    (le) => le.beneficiary_type === who && le.payout_status === 'AVAILABLE_FOR_PAYOUT'
  );
  if (eligible.length === 0) return { ok: false, error: 'Tidak ada saldo siap dicairkan.' };
  let totalSen = 0n;
  for (const e of eligible) totalSen += idrToSen(e.profit_amount);
  if (totalSen <= 0n) return { ok: false, error: 'Tidak ada saldo siap dicairkan.' };

  const seq = String(data.payoutBatches.length + 1).padStart(2, '0');
  const ref = `PAYOUT-${compactDate(ctx.today)}-${who}-${seq}`;
  const batchId = ctx.uid('payout');
  const invoiceCount = new Set(eligible.map((e) => e.invoice_id)).size;
  const batch: ProfitPayoutBatch = {
    id: batchId,
    payout_reference: ref,
    beneficiary_type: who,
    total_payout_amount: senToIdr(totalSen),
    transfer_proof_url: `https://storage.mbg.local/payouts/${ref}.pdf`,
    notes: notes?.trim() || `Pencairan bagi hasil (${who}) dari ${invoiceCount} invoice dapur lunas`,
    disbursed_by: 'owner-1',
    disbursed_at: ctx.nowIso,
    created_at: ctx.nowIso,
  };
  const ids = new Set(eligible.map((e) => e.id));
  return {
    ok: true,
    data: {
      ...data,
      payoutBatches: [batch, ...data.payoutBatches],
      ledgerEntries: data.ledgerEntries.map((le) =>
        ids.has(le.id)
          ? { ...le, payout_status: 'PAID_OUT' as const, payout_batch_id: batchId, paid_out_at: ctx.nowIso, updated_at: ctx.nowIso }
          : le
      ),
    },
  };
}

// ---------- Courier projection (Invariant 5) ----------

/**
 * Mirrors `v_safe_delivery_items_bast` (migration 0004): sanitized via
 * `sanitizeDeliveryForFieldTeam`, then enriched with non-financial context only.
 * Output never contains price, invoice amount, or margin fields.
 */
export function buildSafeCourierItems(
  data: Pick<MbgData, 'deliveryItems' | 'deliveries' | 'kitchens' | 'items' | 'invoices'>
): SafeCourierBastItem[] {
  return data.deliveryItems.map((di) => {
    const del = data.deliveries.find((d) => d.id === di.delivery_id);
    const kitchen = data.kitchens.find((k) => k.id === del?.kitchen_id);
    const item = data.items.find((i) => i.id === di.item_id);
    const safe = sanitizeDeliveryForFieldTeam({
      id: di.id,
      delivery_item_id: di.id,
      delivery_id: di.delivery_id,
      delivery_number: del?.delivery_number ?? 'SJ-UNKNOWN',
      delivery_date: del?.delivery_date ?? '',
      kitchen_id: kitchen?.id ?? 'unknown',
      kitchen_name: kitchen?.name ?? 'Dapur MBG',
      item_id: item?.id ?? di.item_id,
      item_name: item?.name ?? 'Bahan Baku MBG',
      qty_dispatched_kg: di.qty_dispatched_kg,
      qty_accepted_kg: di.qty_accepted_kg,
      qty_shrinkage_kg: di.qty_shrinkage_kg,
      rejection_reason: di.rejection_reason,
    });
    return {
      ...safe,
      kitchen_code: kitchen?.kitchen_code ?? '-',
      kitchen_pic_name: kitchen?.pic_name ?? '-',
      kitchen_pic_phone: kitchen?.pic_phone ?? '',
      is_weighed: di.weighed_at !== null,
      is_locked: isPaid(invoiceForDelivery(data, di.delivery_id)),
    };
  });
}
