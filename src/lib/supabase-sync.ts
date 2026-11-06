/**
 * Supabase real-time synchronization & atomic RPC/CRUD layer for MBG Order-Driven Workflow (Stage 8).
 *
 * 100% Pure Supabase Cloud Backend (Single Source of Truth in PostgreSQL):
 * - Role `FIELD_TEAM` (Lapangan): ONLY queries `v_courier_kitchen_orders` and invokes
 *   `submit_courier_weighing` RPC (Invariant 5: zero price/margin exposure in Network Inspector).
 * - Roles `OWNER_ADMIN` / `FINANCE` / `COOPERATIVE_VIEWER`: queries relational tables
 *   (`kitchens`, `products`, `kitchen_orders`, `kitchen_order_items`, `kitchen_invoices`,
 *   `profit_ledger_entries`, `app_settings`, `profit_payout_batches`) and executes direct
 *   Supabase `INSERT` / `UPDATE` / `DELETE` / `RPC` operations.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  BeneficiaryType,
  Item,
  Kitchen,
  KitchenDelivery,
  KitchenDeliveryItem,
  KitchenInvoice,
  LedgerPayoutStatus,
  ProfitLedgerEntry,
  ProfitPayoutBatch,
  ProfitSplitConfig,
} from '../types/mbg';
import { composeShrinkReason, type ShrinkReason } from './courier-view';
import {
  DEFAULT_PAYMENT_INFO,
  gramsToKg,
  idrToSen,
  kgToGrams,
  multiplyWeightGramsByPriceSen,
  roundKg,
  senToIdr,
} from './financial-engine';
import type { CreateOrderInput, MbgData, UpdateOrderInput } from './order-engine';

const DEFAULT_DATE = '2026-10-16';
const DEFAULT_ISO = '2026-10-16T06:00:00.000Z';

// ---------- Row interfaces matching 0005, 0006 & 0007 migrations ----------

export interface KitchenRow {
  id: string;
  code: string;
  name: string;
  address?: string | null;
  pic_name: string;
  pic_phone: string;
  default_markup_per_kg?: number | string | null;
  is_active: boolean;
  created_at?: string | null;
}

export interface ProductRow {
  id: string;
  code: string;
  name: string;
  category?: string | null;
  default_kitchen_price_rp: number | string;
  default_margin_per_kg_rp: number | string;
  is_active: boolean;
  created_at?: string | null;
}

export interface KitchenOrderRow {
  id: string;
  order_code: string;
  kitchen_id: string;
  order_date: string;
  status: string;
  bast_signed_by_name?: string | null;
  bast_verified_at?: string | null;
  notes?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface KitchenOrderItemRow {
  id: string;
  order_id: string;
  product_id: string;
  product_name_snapshot: string;
  qty_ordered_kg: number | string;
  qty_accepted_kg: number | string | null;
  kitchen_unit_price_rp: number | string;
  margin_per_kg_rp: number | string;
  is_weighed: boolean;
  weighed_at?: string | null;
  shrinkage_reason?: string | null;
  shrinkage_note?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface KitchenInvoiceRow {
  id: string;
  invoice_code: string;
  order_id: string;
  kitchen_id: string;
  invoice_date?: string | null;
  due_date?: string | null;
  total_amount_rp: number | string;
  amount_paid_rp?: number | string | null;
  status: 'UNPAID' | 'PAID';
  paid_at?: string | null;
  supplier_name?: string | null;
  payment_bank_name?: string | null;
  payment_account_number?: string | null;
  payment_account_holder?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ProfitLedgerRow {
  id: string;
  invoice_id: string;
  order_id?: string | null;
  order_item_id?: string | null;
  kitchen_id: string;
  gross_margin_rp: number | string;
  team_share_pct: number | string;
  coop_share_pct: number | string;
  team_amount_rp: number | string;
  coop_amount_rp: number | string;
  status: 'LOCKED_UNPAID' | 'AVAILABLE_FOR_PAYOUT' | 'PAID_OUT';
  team_paid_out: boolean;
  coop_paid_out: boolean;
  team_payout_batch_id?: string | null;
  coop_payout_batch_id?: string | null;
  team_paid_out_at?: string | null;
  coop_paid_out_at?: string | null;
  unlocked_at?: string | null;
  paid_out_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ProfitSplitConfigRow {
  id: string;
  config_name: string;
  team_share_pct: number | string;
  cooperative_share_pct: number | string;
  supplier_name?: string | null;
  payment_bank_name?: string | null;
  payment_account_number?: string | null;
  payment_account_holder?: string | null;
  is_active: boolean;
  effective_from: string;
  created_at?: string | null;
}

export interface AppSettingsRow {
  id: string;
  team_share_pct: number | string;
  coop_share_pct: number | string;
  supplier_name?: string | null;
  payment_bank_name?: string | null;
  payment_account_number?: string | null;
  payment_account_holder?: string | null;
  updated_at?: string | null;
}

export interface ProfitPayoutBatchRow {
  id: string;
  payout_reference: string;
  beneficiary_type: 'TEAM' | 'COOPERATIVE';
  total_payout_amount: number | string;
  transfer_proof_url: string;
  notes?: string | null;
  disbursed_by: string;
  disbursed_at: string;
  created_at?: string | null;
}

// ---------- Pure conversion helpers (Supabase DB rows -> MbgData) ----------

const num = (v: number | string | null | undefined): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

export function fromSupabaseRows(rows: {
  kitchens: KitchenRow[];
  products: ProductRow[];
  orders: KitchenOrderRow[];
  orderItems: KitchenOrderItemRow[];
  invoices: KitchenInvoiceRow[];
  ledgerEntries: ProfitLedgerRow[];
  splitConfigs: ProfitSplitConfigRow[];
  appSettings?: AppSettingsRow[];
  payoutBatches: ProfitPayoutBatchRow[];
}): MbgData {
  const kitchens: Kitchen[] = rows.kitchens.map((k) => ({
    id: k.id,
    kitchen_code: k.code,
    name: k.name,
    address: k.address ?? '-',
    pic_name: k.pic_name,
    pic_phone: k.pic_phone,
    default_markup_per_kg: num(k.default_markup_per_kg),
    is_active: k.is_active,
    created_at: k.created_at ?? DEFAULT_ISO,
  }));

  const items: Item[] = rows.products.map((p) => ({
    id: p.id,
    sku: p.code,
    name: p.name,
    category: p.category ?? 'Lainnya',
    base_unit: 'kg',
    default_kitchen_price_per_kg: num(p.default_kitchen_price_rp),
    default_margin_per_kg: num(p.default_margin_per_kg_rp),
    is_active: p.is_active,
    created_at: p.created_at ?? DEFAULT_ISO,
  }));

  const deliveries: KitchenDelivery[] = rows.orders.map((o) => ({
    id: o.id,
    delivery_number: o.order_code,
    kitchen_id: o.kitchen_id,
    delivery_date: o.order_date,
    status: o.status === 'BAST_VERIFIED' ? 'BAST_VERIFIED' : 'IN_TRANSIT',
    courier_user_id: null,
    bast_signed_by_name: o.bast_signed_by_name ?? null,
    bast_photo_url: null,
    bast_verified_at: o.bast_verified_at ?? null,
    notes: o.notes ?? null,
    created_at: o.created_at ?? DEFAULT_ISO,
    updated_at: o.updated_at ?? DEFAULT_ISO,
  }));

  const deliveryItems: KitchenDeliveryItem[] = rows.orderItems.map((oi) => {
    const orderedKg = roundKg(oi.qty_ordered_kg);
    const acceptedKg = oi.is_weighed && oi.qty_accepted_kg !== null ? roundKg(oi.qty_accepted_kg) : orderedKg;
    const shrinkKg = Math.max(0, gramsToKg(kgToGrams(orderedKg) - kgToGrams(acceptedKg)));
    const unitPrice = num(oi.kitchen_unit_price_rp);
    const marginPerKg = num(oi.margin_per_kg_rp);
    const acceptedGrams = kgToGrams(acceptedKg);
    const lineInvoice = senToIdr(multiplyWeightGramsByPriceSen(acceptedGrams, idrToSen(unitPrice)));
    const lineMargin = senToIdr(multiplyWeightGramsByPriceSen(acceptedGrams, idrToSen(marginPerKg)));
    const rejectionReason = oi.shrinkage_reason
      ? composeShrinkReason((oi.shrinkage_reason as ShrinkReason) ?? 'Susut', oi.shrinkage_note ?? '')
      : null;

    return {
      id: oi.id,
      delivery_id: oi.order_id,
      item_id: oi.product_id,
      qty_dispatched_kg: orderedKg,
      qty_accepted_kg: acceptedKg,
      qty_shrinkage_kg: shrinkKg,
      kitchen_unit_price_snapshot: unitPrice,
      margin_per_kg_snapshot: marginPerKg,
      line_invoice_amount: lineInvoice,
      line_margin_amount: lineMargin,
      weighed_at: oi.is_weighed ? oi.weighed_at ?? oi.updated_at ?? DEFAULT_ISO : null,
      rejection_reason: rejectionReason,
      created_at: oi.created_at ?? DEFAULT_ISO,
      updated_at: oi.updated_at ?? DEFAULT_ISO,
    };
  });

  const appSetting = rows.appSettings?.[0];
  const scRow = rows.splitConfigs[0];
  const teamPctVal = appSetting ? num(appSetting.team_share_pct) : scRow ? num(scRow.team_share_pct) : 60.0;
  const coopPctVal = appSetting ? num(appSetting.coop_share_pct) : scRow ? num(scRow.cooperative_share_pct) : 40.0;
  const cfgSupplierName = appSetting?.supplier_name || scRow?.supplier_name || DEFAULT_PAYMENT_INFO.supplier_name;
  const cfgBankName = appSetting?.payment_bank_name || scRow?.payment_bank_name || DEFAULT_PAYMENT_INFO.payment_bank_name;
  const cfgAccountNumber =
    appSetting?.payment_account_number || scRow?.payment_account_number || DEFAULT_PAYMENT_INFO.payment_account_number;
  const cfgAccountHolder =
    appSetting?.payment_account_holder || scRow?.payment_account_holder || DEFAULT_PAYMENT_INFO.payment_account_holder;

  const invoices: KitchenInvoice[] = rows.invoices.map((inv) => {
    const total = num(inv.total_amount_rp);
    const paid = inv.status === 'PAID';
    return {
      id: inv.id,
      invoice_number: inv.invoice_code,
      kitchen_id: inv.kitchen_id,
      delivery_id: inv.order_id,
      invoice_date: inv.invoice_date ?? DEFAULT_DATE,
      due_date: inv.due_date ?? '2026-10-23',
      total_invoice_amount: total,
      amount_paid: paid ? total : num(inv.amount_paid_rp),
      payment_status: paid ? 'PAID' : 'UNPAID',
      payment_proof_url: null,
      paid_at: inv.paid_at ?? null,
      verified_by: null,
      supplier_name: (paid ? inv.supplier_name : cfgSupplierName || inv.supplier_name) || cfgSupplierName,
      payment_bank_name: (paid ? inv.payment_bank_name : cfgBankName || inv.payment_bank_name) || cfgBankName,
      payment_account_number:
        (paid ? inv.payment_account_number : cfgAccountNumber || inv.payment_account_number) || cfgAccountNumber,
      payment_account_holder:
        (paid ? inv.payment_account_holder : cfgAccountHolder || inv.payment_account_holder) || cfgAccountHolder,
      created_at: inv.created_at ?? DEFAULT_ISO,
      updated_at: inv.updated_at ?? DEFAULT_ISO,
    };
  });

  const splitConfig: ProfitSplitConfig = {
    id: scRow?.id ?? 'split-default-60-40',
    config_name: scRow?.config_name ?? `Skema Bagi Hasil Standar Tim ${teamPctVal}% : Koperasi ${coopPctVal}%`,
    team_share_pct: teamPctVal,
    cooperative_share_pct: coopPctVal,
    supplier_name: cfgSupplierName,
    payment_bank_name: cfgBankName,
    payment_account_number: cfgAccountNumber,
    payment_account_holder: cfgAccountHolder,
    is_active: true,
    effective_from: scRow?.effective_from ?? DEFAULT_DATE,
    created_at: scRow?.created_at ?? DEFAULT_ISO,
  };

  const itemById = new Map(deliveryItems.map((di) => [di.id, di]));
  const invById = new Map(invoices.map((inv) => [inv.id, inv]));

  const ledgerEntries: ProfitLedgerEntry[] = [];
  for (const r of rows.ledgerEntries) {
    const di = r.order_item_id ? itemById.get(r.order_item_id) : undefined;
    const inv = invById.get(r.invoice_id);
    const acceptedKg = di?.qty_accepted_kg ?? 0;
    const unitMargin = di?.margin_per_kg_snapshot ?? 0;
    const baseStatus: LedgerPayoutStatus =
      inv?.payment_status === 'PAID' || r.status === 'AVAILABLE_FOR_PAYOUT' || r.status === 'PAID_OUT'
        ? 'AVAILABLE_FOR_PAYOUT'
        : 'LOCKED_UNPAID';

    const teamStatus: LedgerPayoutStatus = r.team_paid_out ? 'PAID_OUT' : baseStatus;
    const coopStatus: LedgerPayoutStatus = r.coop_paid_out ? 'PAID_OUT' : baseStatus;
    const deliveryItemId = r.order_item_id ?? r.id;

    ledgerEntries.push(
      {
        id: `${r.id}-team`,
        invoice_id: r.invoice_id,
        delivery_item_id: deliveryItemId,
        split_config_id: splitConfig.id,
        beneficiary_type: 'TEAM',
        qty_accepted_kg: acceptedKg,
        unit_markup_snapshot: unitMargin,
        share_pct_snapshot: num(r.team_share_pct),
        profit_amount: num(r.team_amount_rp),
        payout_status: teamStatus,
        payout_batch_id: r.team_payout_batch_id ?? null,
        unlocked_at: r.unlocked_at ?? null,
        paid_out_at: r.team_paid_out ? r.team_paid_out_at ?? r.paid_out_at ?? DEFAULT_ISO : null,
        created_at: r.created_at ?? DEFAULT_ISO,
        updated_at: r.updated_at ?? DEFAULT_ISO,
      },
      {
        id: `${r.id}-coop`,
        invoice_id: r.invoice_id,
        delivery_item_id: deliveryItemId,
        split_config_id: splitConfig.id,
        beneficiary_type: 'COOPERATIVE',
        qty_accepted_kg: acceptedKg,
        unit_markup_snapshot: unitMargin,
        share_pct_snapshot: num(r.coop_share_pct),
        profit_amount: num(r.coop_amount_rp),
        payout_status: coopStatus,
        payout_batch_id: r.coop_payout_batch_id ?? null,
        unlocked_at: r.unlocked_at ?? null,
        paid_out_at: r.coop_paid_out ? r.coop_paid_out_at ?? r.paid_out_at ?? DEFAULT_ISO : null,
        created_at: r.created_at ?? DEFAULT_ISO,
        updated_at: r.updated_at ?? DEFAULT_ISO,
      }
    );
  }

  const payoutBatches: ProfitPayoutBatch[] = rows.payoutBatches.map((pb) => ({
    id: pb.id,
    payout_reference: pb.payout_reference,
    beneficiary_type: pb.beneficiary_type,
    total_payout_amount: num(pb.total_payout_amount),
    transfer_proof_url: pb.transfer_proof_url,
    notes: pb.notes ?? null,
    disbursed_by: pb.disbursed_by,
    disbursed_at: pb.disbursed_at,
    created_at: pb.created_at ?? DEFAULT_ISO,
  }));

  return {
    kitchens,
    items,
    deliveries,
    deliveryItems,
    invoices,
    splitConfig,
    ledgerEntries,
    payoutBatches,
  };
}

// ---------- Direct Cloud Fetching & RPC Operations (Cloudflare Hyperdrive + Supabase JS Fallback) ----------

type HyperdriveEndpointState = 'unknown' | 'active' | 'unavailable';
let hyperdriveEndpointState: HyperdriveEndpointState = 'unknown';
let verifiedAdminPin: string | null = null;
let latestHyperdriveSnapshot: MbgData | null = null;

const SWR_STORAGE_KEY = 'mbg_swr_snapshot_v1';

export function setHyperdriveEndpointStateForTest(state: HyperdriveEndpointState): void {
  hyperdriveEndpointState = state;
}

export function setVerifiedAdminPinForTest(pin: string | null): void {
  verifiedAdminPin = pin;
}

export function consumeLatestHyperdriveSnapshot(): MbgData | null {
  const snap = latestHyperdriveSnapshot;
  latestHyperdriveSnapshot = null;
  return snap;
}

export function readSwrSnapshot(): MbgData | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SWR_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MbgData;
    if (!parsed || !Array.isArray(parsed.kitchens) || !Array.isArray(parsed.deliveries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeSwrSnapshot(data: MbgData): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(
      SWR_STORAGE_KEY,
      JSON.stringify({
        kitchens: data.kitchens,
        items: data.items,
        deliveries: data.deliveries,
        deliveryItems: data.deliveryItems,
        invoices: data.invoices,
        splitConfig: data.splitConfig,
        ledgerEntries: data.ledgerEntries,
        payoutBatches: data.payoutBatches,
      })
    );
  } catch {
    // Ignore storage quota errors
  }
}

function getActiveAdminPin(): string | undefined {
  if (typeof window !== 'undefined') {
    const stored = window.sessionStorage.getItem('mbg_admin_pin');
    if (stored) return stored;
  }
  return verifiedAdminPin ?? undefined;
}

function shouldTryHyperdrive(requireConfirmedActive = false): boolean {
  if (hyperdriveEndpointState === 'unavailable') return false;
  if (hyperdriveEndpointState === 'active') return true;
  if (requireConfirmedActive) return false;
  return typeof window !== 'undefined' && typeof fetch === 'function';
}

async function postHyperdriveAction(
  body: Record<string, unknown>
): Promise<{ handled: false } | { handled: true; data: Record<string, unknown> }> {
  if (!shouldTryHyperdrive(true)) return { handled: false };
  try {
    const isVerifyPin = body.action === 'verify_role_pin';
    const adminPin = isVerifyPin ? undefined : getActiveAdminPin();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPin) headers['x-admin-pin'] = adminPin;
    const payload: Record<string, unknown> = isVerifyPin
      ? body
      : { ...body, includeSnapshot: true, ...(adminPin ? { adminPin } : {}) };
    const res = await fetch('/api/hyperdrive', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (res.status === 503) {
      hyperdriveEndpointState = 'unavailable';
      return { handled: false };
    }
    const json = (await res.json()) as Record<string, unknown>;
    if (json.ok && json.snapshot && typeof json.snapshot === 'object') {
      latestHyperdriveSnapshot = json.snapshot as MbgData;
      writeSwrSnapshot(latestHyperdriveSnapshot);
    }
    return { handled: true, data: json };
  } catch {
    return { handled: false };
  }
}

/**
 * RPC #1: Invokes `rpc_upsert_kitchen_order(p_kitchen_id, p_order_date, p_items, p_notes)`.
 * PostgreSQL creates/merges the order, inserts `kitchen_order_items`, and executes
 * `fn_recalculate_order_financials` to compute `kitchen_invoices` & `profit_ledger_entries`.
 */
export async function upsertKitchenOrderRpc(
  supabase: SupabaseClient,
  input: CreateOrderInput & { notes?: string | null },
  orderDate: string
): Promise<{ ok: true; order_id: string; order_code: string; merged: boolean; count: number } | { ok: false; error: string }> {
  const hd = await postHyperdriveAction({ action: 'upsert_order', input, orderDate });
  if (hd.handled) {
    if (!hd.data.ok) return { ok: false, error: String(hd.data.error ?? 'Gagal menyimpan order.') };
    return {
      ok: true,
      order_id: String(hd.data.order_id ?? ''),
      order_code: String(hd.data.order_code ?? ''),
      merged: Boolean(hd.data.merged),
      count: Number(hd.data.count ?? input.lines.length),
    };
  }
  try {
    const payload = input.lines.map((l) => ({
      product_id: l.item_id,
      item_id: l.item_id,
      qty_ordered_kg: roundKg(l.qty_ordered_kg),
      kitchen_unit_price_rp: l.kitchen_unit_price_rp,
      margin_per_kg_rp: l.margin_per_kg_rp,
    }));
    const { data, error } = await supabase.rpc('rpc_upsert_kitchen_order', {
      p_kitchen_id: input.kitchen_id,
      p_order_date: orderDate,
      p_items: payload,
      p_notes: input.notes ?? null,
    });
    if (error) {
      return { ok: false, error: error.message };
    }
    const res = (data ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      order_id: String(res.order_id ?? ''),
      order_code: String(res.order_code ?? ''),
      merged: Boolean(res.merged),
      count: Number(res.count ?? payload.length),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gagal menyimpan order ke Supabase.' };
  }
}

/**
 * RPC #1b: Invokes `rpc_update_kitchen_order(p_order_id, p_kitchen_id, p_order_date, p_items)`
 * to edit an existing order/invoice's date, kitchen, items, qty, price, and margin in PostgreSQL.
 */
export async function updateKitchenOrderRpc(
  supabase: SupabaseClient,
  input: UpdateOrderInput
): Promise<{ ok: true; order_id: string; count: number } | { ok: false; error: string }> {
  const hd = await postHyperdriveAction({ action: 'update_order', input });
  if (hd.handled) {
    if (!hd.data.ok) return { ok: false, error: String(hd.data.error ?? 'Gagal memperbarui order/invoice.') };
    return {
      ok: true,
      order_id: String(hd.data.order_id ?? input.delivery_id),
      count: Number(hd.data.count ?? input.lines.length),
    };
  }
  try {
    const payload = input.lines.map((l) => ({
      id: l.id ?? null,
      product_id: l.item_id,
      item_id: l.item_id,
      qty_ordered_kg: roundKg(l.qty_ordered_kg),
      qty_accepted_kg: l.qty_accepted_kg != null ? roundKg(l.qty_accepted_kg) : null,
      kitchen_unit_price_rp: l.kitchen_unit_price_rp,
      margin_per_kg_rp: l.margin_per_kg_rp,
    }));
    const { data, error } = await supabase.rpc('rpc_update_kitchen_order', {
      p_order_id: input.delivery_id,
      p_kitchen_id: input.kitchen_id,
      p_order_date: input.order_date,
      p_items: payload,
    });
    if (error) {
      return { ok: false, error: error.message };
    }
    const res = (data ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      order_id: String(res.order_id ?? input.delivery_id),
      count: Number(res.count ?? payload.length),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gagal memperbarui order/invoice di Supabase.' };
  }
}

/**
 * RPC #2: Invokes `rpc_mark_invoice_paid(p_invoice_id)` in PostgreSQL.
 * Validates all items are weighed, marks invoice PAID, and unlocks `profit_ledger_entries`
 * from `LOCKED_UNPAID` to `AVAILABLE_FOR_PAYOUT`.
 */
export async function markInvoicePaidRpc(
  supabase: SupabaseClient,
  invoiceId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const hd = await postHyperdriveAction({ action: 'mark_invoice_paid', invoiceId });
  if (hd.handled) {
    return hd.data.ok ? { ok: true } : { ok: false, error: String(hd.data.error ?? 'Gagal menandai invoice lunas.') };
  }
  try {
    const { error } = await supabase.rpc('rpc_mark_invoice_paid', {
      p_invoice_id: invoiceId,
    });
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gagal menandai invoice lunas di Supabase.' };
  }
}

/**
 * RPC #4: Invokes `rpc_execute_profit_payout(p_target, p_entry_ids)` in PostgreSQL.
 * Disburses `TEAM`, `COOPERATIVE`, or `BOTH` on `AVAILABLE_FOR_PAYOUT` entries,
 * records separate `team_paid_out_at` / `coop_paid_out_at`, and transitions to `PAID_OUT` when both are paid.
 */
export async function executeProfitPayoutRpc(
  supabase: SupabaseClient,
  target: BeneficiaryType | 'BOTH',
  entryIds?: string[] | null
): Promise<{ ok: true; count: number; total_payout_rp: number } | { ok: false; error: string }> {
  const hd = await postHyperdriveAction({ action: 'execute_payout', target, entryIds: entryIds ?? null });
  if (hd.handled) {
    if (!hd.data.ok) return { ok: false, error: String(hd.data.error ?? 'Gagal mencairkan bagi hasil.') };
    return {
      ok: true,
      count: Number(hd.data.count ?? 0),
      total_payout_rp: Number(hd.data.total_payout_rp ?? 0),
    };
  }
  try {
    const { data, error } = await supabase.rpc('rpc_execute_profit_payout', {
      p_target: target,
      p_entry_ids: entryIds && entryIds.length > 0 ? entryIds : null,
    });
    if (error) {
      return { ok: false, error: error.message };
    }
    const res = (data ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      count: Number(res.count ?? 0),
      total_payout_rp: Number(res.total_payout_rp ?? 0),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gagal mencairkan bagi hasil di Supabase.' };
  }
}

/**
 * RPC #5: Invokes `rpc_update_app_settings(p_team_pct, p_coop_pct, p_bank_name, p_account_number, p_account_holder, p_supplier_name)`.
 * Validates `team + coop = 100`, updates `app_settings` + UNPAID invoice bank snapshots,
 * and recalculates all orders without payouts via `fn_recalculate_order_financials`.
 */
export async function updateAppSettingsRpc(
  supabase: SupabaseClient,
  params: {
    teamSharePct: number;
    coopSharePct: number;
    supplierName?: string | null;
    bankName?: string | null;
    accountNumber?: string | null;
    accountHolder?: string | null;
  }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const hd = await postHyperdriveAction({ action: 'update_app_settings', params });
  if (hd.handled) {
    return hd.data.ok ? { ok: true } : { ok: false, error: String(hd.data.error ?? 'Gagal menyimpan pengaturan.') };
  }
  try {
    const { error } = await supabase.rpc('rpc_update_app_settings', {
      p_team_pct: params.teamSharePct,
      p_coop_pct: params.coopSharePct,
      p_bank_name: params.bankName ?? null,
      p_account_number: params.accountNumber ?? null,
      p_account_holder: params.accountHolder ?? null,
      p_supplier_name: params.supplierName ?? null,
    });
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gagal menyimpan pengaturan ke Supabase.' };
  }
}

/**
 * Targeted deletion of a single order item.
 * Database trigger `trg_kitchen_order_items_recalc` automatically runs `fn_recalculate_order_financials`.
 */
export async function deleteOrderItemFromSupabase(
  supabase: SupabaseClient,
  itemId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const hd = await postHyperdriveAction({ action: 'delete_order_item', itemId });
  if (hd.handled) {
    return hd.data.ok ? { ok: true } : { ok: false, error: String(hd.data.error ?? 'Gagal menghapus baris order.') };
  }
  try {
    const { error } = await supabase.from('kitchen_order_items').delete().eq('id', itemId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gagal menghapus baris order di Supabase.' };
  }
}

export async function deleteKitchenOrderFromSupabase(
  supabase: SupabaseClient,
  orderId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const hd = await postHyperdriveAction({ action: 'delete_order', orderId });
  if (hd.handled) {
    return hd.data.ok ? { ok: true } : { ok: false, error: String(hd.data.error ?? 'Gagal menghapus order.') };
  }
  try {
    const [{ data: paidInv }, { data: paidOut }] = await Promise.all([
      supabase.from('kitchen_invoices').select('id').eq('order_id', orderId).eq('status', 'PAID').limit(1),
      supabase
        .from('profit_ledger_entries')
        .select('id')
        .eq('order_id', orderId)
        .or('team_paid_out.eq.true,coop_paid_out.eq.true')
        .limit(1),
    ]);
    if ((paidInv && paidInv.length > 0) || (paidOut && paidOut.length > 0)) {
      return { ok: false, error: 'Order sudah dikunci (Invoice Lunas / Bagi Hasil Cair) dan tidak bisa dihapus.' };
    }
    const { error } = await supabase
      .from('kitchen_orders')
      .delete()
      .eq('id', orderId)
      .neq('status', 'BAST_LOCKED');
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gagal menghapus order di Supabase.' };
  }
}

export async function upsertKitchenInSupabase(
  supabase: SupabaseClient,
  kitchen: Kitchen
): Promise<{ ok: true } | { ok: false; error: string }> {
  const hd = await postHyperdriveAction({ action: 'upsert_kitchen', kitchen });
  if (hd.handled) {
    return hd.data.ok ? { ok: true } : { ok: false, error: String(hd.data.error ?? 'Gagal menyimpan dapur.') };
  }
  try {
    const row: KitchenRow = {
      id: kitchen.id,
      code: kitchen.kitchen_code,
      name: kitchen.name,
      address: kitchen.address,
      pic_name: kitchen.pic_name,
      pic_phone: kitchen.pic_phone,
      default_markup_per_kg: kitchen.default_markup_per_kg,
      is_active: kitchen.is_active,
      created_at: kitchen.created_at,
    };
    const { error } = await supabase.from('kitchens').upsert(row, { onConflict: 'id' });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gagal menyimpan dapur ke Supabase.' };
  }
}

export async function upsertProductInSupabase(
  supabase: SupabaseClient,
  item: Item
): Promise<{ ok: true } | { ok: false; error: string }> {
  const hd = await postHyperdriveAction({ action: 'upsert_product', item });
  if (hd.handled) {
    return hd.data.ok ? { ok: true } : { ok: false, error: String(hd.data.error ?? 'Gagal menyimpan barang.') };
  }
  try {
    const row: ProductRow = {
      id: item.id,
      code: item.sku,
      name: item.name,
      category: item.category,
      default_kitchen_price_rp: item.default_kitchen_price_per_kg,
      default_margin_per_kg_rp: item.default_margin_per_kg,
      is_active: item.is_active,
      created_at: item.created_at,
    };
    const { error } = await supabase.from('products').upsert(row, { onConflict: 'id' });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gagal menyimpan barang ke Supabase.' };
  }
}

/**
 * Fetches full relational data from Supabase for Admin / Finance / Cooperative roles.
 */
const APP_SETTINGS_PUBLIC_COLS =
  'id, team_share_pct, coop_share_pct, supplier_name, payment_bank_name, payment_account_number, payment_account_holder, updated_at';

async function selectPagedRows<T>(
  supabase: SupabaseClient,
  table: string,
  orderCol: string,
  maxRows = 5000
): Promise<{ data: T[] | null; error: unknown }> {
  const pageSize = 1000;
  const out: T[] = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const res = await supabase
      .from(table)
      .select('*')
      .order(orderCol, { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (res.error) return { data: null, error: res.error };
    const batch = (res.data ?? []) as T[];
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return { data: out, error: null };
}

export async function verifyRolePinRpc(
  supabase: SupabaseClient,
  role: string,
  pin: string
): Promise<boolean> {
  const hd = await postHyperdriveAction({ action: 'verify_role_pin', role, pin });
  if (hd.handled) {
    const ok = Boolean(hd.data.ok);
    if (ok && role === 'OWNER_ADMIN') verifiedAdminPin = pin;
    return ok;
  }
  try {
    const { data, error } = await supabase.rpc('rpc_verify_role_pin', { p_role: role, p_pin: pin });
    if (error || !data || typeof data !== 'object') return false;
    const ok = Boolean((data as { ok?: boolean }).ok);
    if (ok && role === 'OWNER_ADMIN') verifiedAdminPin = pin;
    return ok;
  } catch {
    return false;
  }
}

export async function fetchMbgDataFromSupabase(supabase: SupabaseClient): Promise<MbgData | null> {
  if (shouldTryHyperdrive(false)) {
    try {
      const res = await fetch('/api/hyperdrive', { method: 'GET', cache: 'no-store' });
      if (res.status === 503) {
        hyperdriveEndpointState = 'unavailable';
      } else if (res.ok) {
        const json = (await res.json()) as { ok?: boolean; data?: MbgData };
        if (json.ok && json.data) {
          hyperdriveEndpointState = 'active';
          writeSwrSnapshot(json.data);
          return json.data;
        }
      }
    } catch {
      hyperdriveEndpointState = 'unavailable';
    }
  }

  try {
    const [
      kitchensRes,
      productsRes,
      ordersRes,
      orderItemsRes,
      invoicesRes,
      ledgerRes,
      settingsRes,
      payoutsRes,
    ] = await Promise.all([
      supabase.from('kitchens').select('*').order('code', { ascending: true }),
      supabase.from('products').select('*').order('code', { ascending: true }),
      selectPagedRows<KitchenOrderRow>(supabase, 'kitchen_orders', 'created_at', 2000),
      selectPagedRows<KitchenOrderItemRow>(supabase, 'kitchen_order_items', 'created_at', 5000),
      selectPagedRows<KitchenInvoiceRow>(supabase, 'kitchen_invoices', 'created_at', 2000),
      selectPagedRows<ProfitLedgerRow>(supabase, 'profit_ledger_entries', 'created_at', 5000),
      supabase.from('app_settings').select(APP_SETTINGS_PUBLIC_COLS).eq('id', 'default'),
      supabase.from('profit_payout_batches').select('*').order('disbursed_at', { ascending: false }).limit(1000),
    ]);

    if (
      kitchensRes.error ||
      productsRes.error ||
      ordersRes.error ||
      orderItemsRes.error ||
      invoicesRes.error ||
      ledgerRes.error
    ) {
      return null;
    }

    if (!kitchensRes.data || !productsRes.data) {
      return null;
    }

    let appSettingsRows = settingsRes.data as AppSettingsRow[] | null;
    if (settingsRes.error) {
      const fallbackRes = await supabase
        .from('app_settings')
        .select('id, team_share_pct, coop_share_pct, payment_bank_name, payment_account_number, payment_account_holder, updated_at')
        .eq('id', 'default');
      if (fallbackRes.error) return null;
      appSettingsRows = (fallbackRes.data ?? []) as AppSettingsRow[];
    }

    return fromSupabaseRows({
      kitchens: kitchensRes.data as KitchenRow[],
      products: productsRes.data as ProductRow[],
      orders: (ordersRes.data ?? []) as KitchenOrderRow[],
      orderItems: (orderItemsRes.data ?? []) as KitchenOrderItemRow[],
      invoices: (invoicesRes.data ?? []) as KitchenInvoiceRow[],
      ledgerEntries: (ledgerRes.data ?? []) as ProfitLedgerRow[],
      splitConfigs: [],
      appSettings: appSettingsRows ?? [],
      payoutBatches: (payoutsRes.data ?? []) as ProfitPayoutBatchRow[],
    });
  } catch {
    return null;
  }
}

export async function deleteKitchenFromSupabase(
  supabase: SupabaseClient,
  kitchenId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const hd = await postHyperdriveAction({ action: 'delete_kitchen', kitchenId });
  if (hd.handled) {
    return hd.data.ok
      ? { ok: true }
      : { ok: false, error: 'Dapur tidak dapat dihapus karena masih memiliki histori order.' };
  }
  const { error } = await supabase.from('kitchens').delete().eq('id', kitchenId);
  if (error) return { ok: false, error: 'Dapur tidak dapat dihapus karena masih memiliki histori order.' };
  return { ok: true };
}

export async function deleteProductFromSupabase(
  supabase: SupabaseClient,
  productId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const hd = await postHyperdriveAction({ action: 'delete_product', productId });
  if (hd.handled) {
    return hd.data.ok
      ? { ok: true }
      : { ok: false, error: 'Barang tidak dapat dihapus karena masih digunakan di order dapur.' };
  }
  const { error } = await supabase.from('products').delete().eq('id', productId);
  if (error) return { ok: false, error: 'Barang tidak dapat dihapus karena masih digunakan di order dapur.' };
  return { ok: true };
}

export function subscribeToMbgRealtime(
  supabase: SupabaseClient,
  onRemoteChange: () => void,
  onStatusChange?: (connected: boolean) => void
): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onRemoteChange();
    }, 250);
  };

  const channel = supabase
    .channel('mbg-order-driven-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kitchens' }, debouncedChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, debouncedChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kitchen_orders' }, debouncedChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kitchen_order_items' }, debouncedChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kitchen_invoices' }, debouncedChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profit_ledger_entries' }, debouncedChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, debouncedChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profit_payout_batches' }, debouncedChange)
    .subscribe((status) => {
      if (onStatusChange) {
        onStatusChange(status === 'SUBSCRIBED');
      }
    });

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    void supabase.removeChannel(channel);
  };
}
