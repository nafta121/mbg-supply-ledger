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
  SafeCourierBastItem,
} from '../types/mbg';
import { composeShrinkReason, parseShrinkReason, type ShrinkReason } from './courier-view';
import {
  gramsToKg,
  idrToSen,
  kgToGrams,
  multiplyWeightGramsByPriceSen,
  roundKg,
  senToIdr,
} from './financial-engine';
import type { CreateOrderInput, MbgData, UpdateBastInput } from './order-engine';

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
  admin_pin: string;
  coop_pin: string;
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

export interface CourierKitchenOrderViewRow {
  order_id: string;
  order_code: string;
  order_date?: string;
  order_status?: string;
  kitchen_id: string;
  kitchen_code: string;
  kitchen_name: string;
  pic_name?: string;
  pic_phone?: string;
  kitchen_pic_name?: string;
  kitchen_pic_phone?: string;
  item_id?: string;
  order_item_id?: string;
  product_id?: string;
  product_name_snapshot?: string;
  product_name?: string;
  base_unit?: 'kg';
  qty_ordered_kg: number | string;
  qty_accepted_kg: number | string | null;
  qty_shrinkage_kg?: number | string;
  is_weighed: boolean;
  shrinkage_reason: string | null;
  shrinkage_note: string | null;
  is_locked?: boolean;
}

// ---------- Pure conversion helpers (MbgData <-> Supabase DB rows) ----------

const num = (v: number | string | null | undefined): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

export function toSupabaseRows(data: MbgData): {
  kitchens: KitchenRow[];
  products: ProductRow[];
  orders: KitchenOrderRow[];
  orderItems: KitchenOrderItemRow[];
  invoices: KitchenInvoiceRow[];
  ledgerEntries: ProfitLedgerRow[];
  splitConfig: ProfitSplitConfigRow;
  appSettings: AppSettingsRow;
  payoutBatches: ProfitPayoutBatchRow[];
} {
  const itemById = new Map(data.items.map((i) => [i.id, i]));
  const deliveryById = new Map(data.deliveries.map((d) => [d.id, d]));
  const invoiceById = new Map(data.invoices.map((i) => [i.id, i]));

  const kitchens: KitchenRow[] = data.kitchens.map((k) => ({
    id: k.id,
    code: k.kitchen_code,
    name: k.name,
    address: k.address || '-',
    pic_name: k.pic_name,
    pic_phone: k.pic_phone,
    default_markup_per_kg: k.default_markup_per_kg,
    is_active: k.is_active,
    created_at: k.created_at,
  }));

  const products: ProductRow[] = data.items.map((i) => ({
    id: i.id,
    code: i.sku,
    name: i.name,
    category: i.category,
    default_kitchen_price_rp: i.default_kitchen_price_per_kg,
    default_margin_per_kg_rp: i.default_margin_per_kg,
    is_active: i.is_active,
    created_at: i.created_at,
  }));

  const orders: KitchenOrderRow[] = data.deliveries.map((d) => ({
    id: d.id,
    order_code: d.delivery_number,
    kitchen_id: d.kitchen_id,
    order_date: d.delivery_date,
    status: d.status,
    bast_signed_by_name: d.bast_signed_by_name,
    bast_verified_at: d.bast_verified_at,
    notes: d.notes,
    created_at: d.created_at,
    updated_at: d.updated_at,
  }));

  const orderItems: KitchenOrderItemRow[] = data.deliveryItems.map((di) => {
    const prod = itemById.get(di.item_id);
    const parsedReason = parseShrinkReason(di.rejection_reason);
    const isWeighed = di.weighed_at !== null;
    return {
      id: di.id,
      order_id: di.delivery_id,
      product_id: di.item_id,
      product_name_snapshot: prod?.name ?? di.item_id,
      qty_ordered_kg: roundKg(di.qty_dispatched_kg),
      qty_accepted_kg: isWeighed ? roundKg(di.qty_accepted_kg) : null,
      kitchen_unit_price_rp: di.kitchen_unit_price_snapshot,
      margin_per_kg_rp: di.margin_per_kg_snapshot,
      is_weighed: isWeighed,
      weighed_at: di.weighed_at,
      shrinkage_reason: parsedReason.reason,
      shrinkage_note: parsedReason.note || null,
      created_at: di.created_at,
      updated_at: di.updated_at,
    };
  });

  const bankName = data.splitConfig.payment_bank_name ?? 'BRI';
  const accountNumber = data.splitConfig.payment_account_number ?? '0000-0000-0000-000';
  const accountHolder = data.splitConfig.payment_account_holder ?? 'Bendahara Supplier MBG';

  const invoices: KitchenInvoiceRow[] = data.invoices.map((inv) => ({
    id: inv.id,
    invoice_code: inv.invoice_number,
    order_id: inv.delivery_id,
    kitchen_id: inv.kitchen_id,
    invoice_date: inv.invoice_date,
    due_date: inv.due_date,
    total_amount_rp: inv.total_invoice_amount,
    amount_paid_rp: inv.amount_paid,
    status: inv.payment_status === 'PAID' ? 'PAID' : 'UNPAID',
    paid_at: inv.paid_at,
    payment_bank_name: inv.payment_bank_name ?? bankName,
    payment_account_number: inv.payment_account_number ?? accountNumber,
    payment_account_holder: inv.payment_account_holder ?? accountHolder,
    created_at: inv.created_at,
    updated_at: inv.updated_at,
  }));

  const byDeliveryItem = new Map<string, { team?: ProfitLedgerEntry; coop?: ProfitLedgerEntry }>();
  for (const le of data.ledgerEntries) {
    const pair = byDeliveryItem.get(le.delivery_item_id) ?? {};
    if (le.beneficiary_type === 'TEAM') pair.team = le;
    else pair.coop = le;
    byDeliveryItem.set(le.delivery_item_id, pair);
  }

  const ledgerEntries: ProfitLedgerRow[] = [];
  for (const [deliveryItemId, pair] of byDeliveryItem.entries()) {
    const sample = pair.team ?? pair.coop;
    if (!sample) continue;
    const inv = invoiceById.get(sample.invoice_id);
    const deliv = inv ? deliveryById.get(inv.delivery_id) : undefined;
    const kitchenId = inv?.kitchen_id ?? deliv?.kitchen_id ?? data.kitchens[0]?.id ?? 'kitchen-01';
    const orderId = inv?.delivery_id ?? deliv?.id ?? null;
    const teamAmt = pair.team?.profit_amount ?? 0;
    const coopAmt = pair.coop?.profit_amount ?? 0;
    const gross = senToIdr(idrToSen(teamAmt) + idrToSen(coopAmt));
    const teamPaid = pair.team?.payout_status === 'PAID_OUT';
    const coopPaid = pair.coop?.payout_status === 'PAID_OUT';
    let combinedStatus: 'LOCKED_UNPAID' | 'AVAILABLE_FOR_PAYOUT' | 'PAID_OUT' = 'LOCKED_UNPAID';
    if (teamPaid && coopPaid) {
      combinedStatus = 'PAID_OUT';
    } else if (
      pair.team?.payout_status === 'AVAILABLE_FOR_PAYOUT' ||
      pair.coop?.payout_status === 'AVAILABLE_FOR_PAYOUT' ||
      teamPaid ||
      coopPaid
    ) {
      combinedStatus = 'AVAILABLE_FOR_PAYOUT';
    }

    ledgerEntries.push({
      id: `ple-${deliveryItemId}`,
      invoice_id: sample.invoice_id,
      order_id: orderId,
      order_item_id: deliveryItemId,
      kitchen_id: kitchenId,
      gross_margin_rp: gross,
      team_share_pct: pair.team?.share_pct_snapshot ?? data.splitConfig.team_share_pct,
      coop_share_pct: pair.coop?.share_pct_snapshot ?? data.splitConfig.cooperative_share_pct,
      team_amount_rp: teamAmt,
      coop_amount_rp: coopAmt,
      status: combinedStatus,
      team_paid_out: teamPaid,
      coop_paid_out: coopPaid,
      team_payout_batch_id: pair.team?.payout_batch_id ?? null,
      coop_payout_batch_id: pair.coop?.payout_batch_id ?? null,
      team_paid_out_at: pair.team?.paid_out_at ?? null,
      coop_paid_out_at: pair.coop?.paid_out_at ?? null,
      unlocked_at: pair.team?.unlocked_at ?? pair.coop?.unlocked_at ?? null,
      paid_out_at: pair.team?.paid_out_at ?? pair.coop?.paid_out_at ?? null,
      created_at: sample.created_at,
      updated_at: sample.updated_at,
    });
  }

  const splitConfig: ProfitSplitConfigRow = {
    id: data.splitConfig.id,
    config_name: data.splitConfig.config_name,
    team_share_pct: data.splitConfig.team_share_pct,
    cooperative_share_pct: data.splitConfig.cooperative_share_pct,
    payment_bank_name: bankName,
    payment_account_number: accountNumber,
    payment_account_holder: accountHolder,
    is_active: data.splitConfig.is_active,
    effective_from: data.splitConfig.effective_from,
    created_at: data.splitConfig.created_at,
  };

  const appSettings: AppSettingsRow = {
    id: 'default',
    team_share_pct: data.splitConfig.team_share_pct,
    coop_share_pct: data.splitConfig.cooperative_share_pct,
    admin_pin: data.splitConfig.admin_pin || '1122',
    coop_pin: data.splitConfig.coop_pin || '3344',
    payment_bank_name: bankName,
    payment_account_number: accountNumber,
    payment_account_holder: accountHolder,
  };

  const payoutBatches: ProfitPayoutBatchRow[] = data.payoutBatches.map((pb) => ({
    id: pb.id,
    payout_reference: pb.payout_reference,
    beneficiary_type: pb.beneficiary_type,
    total_payout_amount: pb.total_payout_amount,
    transfer_proof_url: pb.transfer_proof_url,
    notes: pb.notes,
    disbursed_by: pb.disbursed_by,
    disbursed_at: pb.disbursed_at,
    created_at: pb.created_at,
  }));

  return {
    kitchens,
    products,
    orders,
    orderItems,
    invoices,
    ledgerEntries,
    splitConfig,
    appSettings,
    payoutBatches,
  };
}

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
  const cfgAdminPin = appSetting?.admin_pin || '1122';
  const cfgCoopPin = appSetting?.coop_pin || '3344';
  const cfgBankName = appSetting?.payment_bank_name || scRow?.payment_bank_name || 'BRI';
  const cfgAccountNumber = appSetting?.payment_account_number || scRow?.payment_account_number || '0000-0000-0000-000';
  const cfgAccountHolder =
    appSetting?.payment_account_holder || scRow?.payment_account_holder || 'Bendahara Supplier MBG';

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
      payment_bank_name: inv.payment_bank_name || cfgBankName,
      payment_account_number: inv.payment_account_number || cfgAccountNumber,
      payment_account_holder: inv.payment_account_holder || cfgAccountHolder,
      created_at: inv.created_at ?? DEFAULT_ISO,
      updated_at: inv.updated_at ?? DEFAULT_ISO,
    };
  });

  const splitConfig: ProfitSplitConfig = {
    id: scRow?.id ?? 'split-default-60-40',
    config_name: scRow?.config_name ?? `Skema Bagi Hasil Standar Tim ${teamPctVal}% : Koperasi ${coopPctVal}%`,
    team_share_pct: teamPctVal,
    cooperative_share_pct: coopPctVal,
    admin_pin: cfgAdminPin,
    coop_pin: cfgCoopPin,
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

/** Converts rows from `v_courier_kitchen_orders` into `SafeCourierBastItem[]` (Invariant 5 — zero prices). */
export function fromCourierViewRows(rows: CourierKitchenOrderViewRow[]): SafeCourierBastItem[] {
  return rows.map((r) => {
    const orderedKg = roundKg(r.qty_ordered_kg);
    const acceptedKg = r.is_weighed && r.qty_accepted_kg !== null ? roundKg(r.qty_accepted_kg) : orderedKg;
    const shrinkKg = Math.max(0, gramsToKg(kgToGrams(orderedKg) - kgToGrams(acceptedKg)));
    const rejectionReason = r.shrinkage_reason
      ? composeShrinkReason((r.shrinkage_reason as ShrinkReason) ?? 'Susut', r.shrinkage_note ?? '')
      : null;

    const itemId = r.order_item_id ?? r.item_id ?? '';
    const productName = r.product_name_snapshot ?? r.product_name ?? '';
    const picName = r.pic_name ?? r.kitchen_pic_name ?? '';
    const picPhone = r.pic_phone ?? r.kitchen_pic_phone ?? '';

    return {
      delivery_item_id: itemId,
      delivery_id: r.order_id,
      delivery_number: r.order_code,
      delivery_date: r.order_date ?? DEFAULT_DATE,
      kitchen_id: r.kitchen_id,
      kitchen_name: r.kitchen_name,
      item_id: r.product_id ?? productName,
      item_name: productName,
      base_unit: 'kg',
      qty_dispatched_kg: orderedKg,
      qty_accepted_kg: acceptedKg,
      qty_shrinkage_kg: shrinkKg,
      rejection_reason: rejectionReason,
      kitchen_code: r.kitchen_code,
      kitchen_pic_name: picName,
      kitchen_pic_phone: picPhone,
      is_weighed: r.is_weighed,
      is_locked: Boolean(r.is_locked),
    };
  });
}

// ---------- Direct Cloud Fetching & RPC Operations ----------

/**
 * Fetches ONLY from `v_courier_kitchen_orders` for role `FIELD_TEAM` (Lapangan).
 * Guarantees zero price/margin columns ever appear in the browser Network Inspector (Invariant 5).
 */
export async function fetchCourierOrdersFromSupabase(
  supabase: SupabaseClient
): Promise<SafeCourierBastItem[] | null> {
  try {
    const { data, error } = await supabase
      .from('v_courier_kitchen_orders')
      .select(
        'order_id,order_code,order_date,order_status,kitchen_id,kitchen_code,kitchen_name,pic_name,pic_phone,item_id,order_item_id,product_id,product_name_snapshot,qty_ordered_kg,qty_accepted_kg,qty_shrinkage_kg,is_weighed,shrinkage_reason,shrinkage_note,is_locked'
      );
    if (error || !data) return null;
    return fromCourierViewRows(data as CourierKitchenOrderViewRow[]);
  } catch {
    return null;
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
 * RPC #2: Invokes atomic `rpc_submit_courier_weighing_batch(p_items JSONB)` SECURITY DEFINER RPC
 * in a single database transaction (no N+1 loop).
 * PostgreSQL updates all items and executes `fn_recalculate_order_financials` for each order.
 */
export async function submitCourierWeighingBatchRpc(
  supabase: SupabaseClient,
  lines: UpdateBastInput[]
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  try {
    const payload = lines.map((line) => {
      const parsed = parseShrinkReason(line.rejection_reason ?? null);
      return {
        item_id: line.delivery_item_id,
        qty_accepted_kg: roundKg(line.qty_accepted_kg),
        shrinkage_reason: parsed.reason,
        shrinkage_note: parsed.note || null,
      };
    });
    const { error } = await supabase.rpc('rpc_submit_courier_weighing_batch', {
      p_items: payload,
    });
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true, count: lines.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gagal menyimpan timbangan ke Supabase.' };
  }
}

/**
 * RPC #3: Invokes `rpc_mark_invoice_paid(p_invoice_id)` in PostgreSQL.
 * Validates all items are weighed, marks invoice PAID, and unlocks `profit_ledger_entries`
 * from `LOCKED_UNPAID` to `AVAILABLE_FOR_PAYOUT`.
 */
export async function markInvoicePaidRpc(
  supabase: SupabaseClient,
  invoiceId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
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
 * RPC #5: Invokes `rpc_update_app_settings(p_team_pct, p_coop_pct, p_bank_name, p_account_number, p_account_holder)`.
 * Validates `team + coop = 100`, updates `app_settings` + UNPAID invoice bank snapshots,
 * and recalculates all orders without payouts via `fn_recalculate_order_financials`.
 */
export async function updateAppSettingsRpc(
  supabase: SupabaseClient,
  params: {
    teamSharePct: number;
    coopSharePct: number;
    bankName?: string | null;
    accountNumber?: string | null;
    accountHolder?: string | null;
  }
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { error } = await supabase.rpc('rpc_update_app_settings', {
      p_team_pct: params.teamSharePct,
      p_coop_pct: params.coopSharePct,
      p_bank_name: params.bankName ?? null,
      p_account_number: params.accountNumber ?? null,
      p_account_holder: params.accountHolder ?? null,
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
 * RPC #6: Invokes `rpc_admin_reset_data(p_mode, p_admin_pin)` in PostgreSQL.
 * Verifies `p_admin_pin` against `app_settings.admin_pin` before running `CLEAR_TRANSACTIONS` or `RESET_SEED`.
 */
export async function adminResetDataRpc(
  supabase: SupabaseClient,
  mode: 'CLEAR_TRANSACTIONS' | 'RESET_SEED',
  adminPin: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { error } = await supabase.rpc('rpc_admin_reset_data', {
      p_mode: mode,
      p_admin_pin: adminPin,
    });
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gagal mengeksekusi reset data di Supabase.' };
  }
}

/**
 * Targeted deletion of a single order item; if the order has 0 remaining items, removes the empty order.
 * Database trigger `trg_kitchen_order_items_recalc` automatically runs `fn_recalculate_order_financials`.
 */
export async function deleteOrderItemFromSupabase(
  supabase: SupabaseClient,
  itemId: string,
  orderId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { error } = await supabase.from('kitchen_order_items').delete().eq('id', itemId);
    if (error) return { ok: false, error: error.message };

    const { count } = await supabase
      .from('kitchen_order_items')
      .select('id', { count: 'exact', head: true })
      .eq('order_id', orderId);
    if (count === 0) {
      await supabase.from('kitchen_orders').delete().eq('id', orderId);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gagal menghapus baris order di Supabase.' };
  }
}

export async function deleteKitchenOrderFromSupabase(
  supabase: SupabaseClient,
  orderId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { error } = await supabase.from('kitchen_orders').delete().eq('id', orderId);
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
export async function fetchMbgDataFromSupabase(supabase: SupabaseClient): Promise<MbgData | null> {
  try {
    const [
      kitchensRes,
      productsRes,
      ordersRes,
      orderItemsRes,
      invoicesRes,
      ledgerRes,
      splitRes,
      settingsRes,
      payoutsRes,
    ] = await Promise.all([
      supabase.from('kitchens').select('*').order('code', { ascending: true }),
      supabase.from('products').select('*').order('code', { ascending: true }),
      supabase.from('kitchen_orders').select('*').order('created_at', { ascending: true }),
      supabase.from('kitchen_order_items').select('*').order('created_at', { ascending: true }),
      supabase.from('kitchen_invoices').select('*').order('created_at', { ascending: true }),
      supabase.from('profit_ledger_entries').select('*').order('created_at', { ascending: true }),
      supabase.from('profit_split_configs').select('*').order('created_at', { ascending: false }),
      supabase.from('app_settings').select('*').eq('id', 'default'),
      supabase.from('profit_payout_batches').select('*').order('disbursed_at', { ascending: false }),
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

    return fromSupabaseRows({
      kitchens: kitchensRes.data as KitchenRow[],
      products: productsRes.data as ProductRow[],
      orders: (ordersRes.data ?? []) as KitchenOrderRow[],
      orderItems: (orderItemsRes.data ?? []) as KitchenOrderItemRow[],
      invoices: (invoicesRes.data ?? []) as KitchenInvoiceRow[],
      ledgerEntries: (ledgerRes.data ?? []) as ProfitLedgerRow[],
      splitConfigs: (splitRes.data ?? []) as ProfitSplitConfigRow[],
      appSettings: (settingsRes.data ?? []) as AppSettingsRow[],
      payoutBatches: (payoutsRes.data ?? []) as ProfitPayoutBatchRow[],
    });
  } catch {
    return null;
  }
}

export async function markInvoicePaidInSupabase(
  supabase: SupabaseClient,
  invoiceId: string,
  _paidAtIso?: string
): Promise<boolean> {
  const res = await markInvoicePaidRpc(supabase, invoiceId);
  return res.ok;
}

export async function updateAppSettingsSplitInSupabase(
  supabase: SupabaseClient,
  teamSharePct: number,
  coopSharePct: number
): Promise<boolean> {
  const res = await updateAppSettingsRpc(supabase, { teamSharePct, coopSharePct });
  return res.ok;
}

export async function updatePaymentAccountInSupabase(
  supabase: SupabaseClient,
  account: {
    payment_bank_name: string;
    payment_account_number: string;
    payment_account_holder: string;
  },
  teamSharePct = 60,
  coopSharePct = 40
): Promise<boolean> {
  const res = await updateAppSettingsRpc(supabase, {
    teamSharePct,
    coopSharePct,
    bankName: account.payment_bank_name,
    accountNumber: account.payment_account_number,
    accountHolder: account.payment_account_holder,
  });
  return res.ok;
}

export async function deleteKitchenFromSupabase(
  supabase: SupabaseClient,
  kitchenId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.from('kitchens').delete().eq('id', kitchenId);
  if (error) return { ok: false, error: 'Dapur tidak dapat dihapus karena masih memiliki histori order.' };
  return { ok: true };
}

export async function deleteProductFromSupabase(
  supabase: SupabaseClient,
  productId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.from('products').delete().eq('id', productId);
  if (error) return { ok: false, error: 'Barang tidak dapat dihapus karena masih digunakan di order dapur.' };
  return { ok: true };
}

export async function resetToSimulationSeedRpc(
  supabase: SupabaseClient,
  adminPin: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  return adminResetDataRpc(supabase, 'RESET_SEED', adminPin);
}

export async function clearAllTransactionsRpc(
  supabase: SupabaseClient,
  adminPin: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  return adminResetDataRpc(supabase, 'CLEAR_TRANSACTIONS', adminPin);
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
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profit_split_configs' }, debouncedChange)
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
