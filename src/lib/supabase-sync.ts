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
import type { MbgData, UpdateBastInput } from './order-engine';

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
    admin_pin: '1234',
    coop_pin: '5678',
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
        paid_out_at: r.team_paid_out ? r.paid_out_at ?? DEFAULT_ISO : null,
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
        paid_out_at: r.coop_paid_out ? r.paid_out_at ?? DEFAULT_ISO : null,
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
 * Invokes `submit_courier_weighing` SECURITY DEFINER RPC for each weighed item.
 * Server triggers automatically recalculate `kitchen_invoices` and `profit_ledger_entries`.
 */
export async function submitCourierWeighingBatchRpc(
  supabase: SupabaseClient,
  lines: UpdateBastInput[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    for (const line of lines) {
      const parsed = parseShrinkReason(line.rejection_reason ?? null);
      const { error } = await supabase.rpc('submit_courier_weighing', {
        p_item_id: line.delivery_item_id,
        p_qty_accepted_kg: roundKg(line.qty_accepted_kg),
        p_shrinkage_reason: parsed.reason,
        p_shrinkage_note: parsed.note || null,
      });
      if (error) {
        return { ok: false, error: error.message };
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gagal menyimpan timbangan ke Supabase.' };
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

/**
 * Targeted cloud operations for Admin / Finance actions.
 */
export async function markInvoicePaidInSupabase(
  supabase: SupabaseClient,
  invoiceId: string,
  paidAtIso: string
): Promise<boolean> {
  const { error } = await supabase
    .from('kitchen_invoices')
    .update({ status: 'PAID', paid_at: paidAtIso, updated_at: paidAtIso })
    .eq('id', invoiceId);
  return !error;
}

export async function updateAppSettingsSplitInSupabase(
  supabase: SupabaseClient,
  teamSharePct: number,
  coopSharePct: number
): Promise<boolean> {
  const { error } = await supabase.from('app_settings').upsert(
    {
      id: 'default',
      team_share_pct: teamSharePct,
      coop_share_pct: coopSharePct,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );
  return !error;
}

export async function updatePaymentAccountInSupabase(
  supabase: SupabaseClient,
  account: {
    payment_bank_name: string;
    payment_account_number: string;
    payment_account_holder: string;
  }
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const [settingsRes, splitRes] = await Promise.all([
    supabase
      .from('app_settings')
      .update({
        payment_bank_name: account.payment_bank_name,
        payment_account_number: account.payment_account_number,
        payment_account_holder: account.payment_account_holder,
        updated_at: nowIso,
      })
      .eq('id', 'default'),
    supabase
      .from('profit_split_configs')
      .update({
        payment_bank_name: account.payment_bank_name,
        payment_account_number: account.payment_account_number,
        payment_account_holder: account.payment_account_holder,
      })
      .eq('is_active', true),
  ]);
  await supabase
    .from('kitchen_invoices')
    .update({
      payment_bank_name: account.payment_bank_name,
      payment_account_number: account.payment_account_number,
      payment_account_holder: account.payment_account_holder,
      updated_at: nowIso,
    })
    .neq('status', 'PAID');
  return !settingsRes.error && !splitRes.error;
}

export async function deleteKitchenFromSupabase(supabase: SupabaseClient, kitchenId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.from('kitchens').delete().eq('id', kitchenId);
  if (error) return { ok: false, error: 'Dapur tidak dapat dihapus karena masih memiliki histori order.' };
  return { ok: true };
}

export async function deleteProductFromSupabase(supabase: SupabaseClient, productId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.from('products').delete().eq('id', productId);
  if (error) return { ok: false, error: 'Barang tidak dapat dihapus karena masih digunakan di order dapur.' };
  return { ok: true };
}

export async function resetToSimulationSeedRpc(supabase: SupabaseClient): Promise<boolean> {
  const { error } = await supabase.rpc('reset_to_simulation_seed');
  return !error;
}

export async function clearAllTransactionsRpc(supabase: SupabaseClient): Promise<boolean> {
  const { error } = await supabase.rpc('clear_all_transactions');
  return !error;
}

export async function syncMbgDataToSupabase(
  supabase: SupabaseClient,
  prev: MbgData | null,
  next: MbgData
): Promise<boolean> {
  try {
    const rows = toSupabaseRows(next);

    // 1. Upsert master tables, app_settings & split config
    const [kRes, pRes, scRes, asRes] = await Promise.all([
      supabase.from('kitchens').upsert(rows.kitchens, { onConflict: 'id' }),
      supabase.from('products').upsert(rows.products, { onConflict: 'id' }),
      supabase.from('profit_split_configs').upsert([rows.splitConfig], { onConflict: 'id' }),
      supabase.from('app_settings').upsert([rows.appSettings], { onConflict: 'id' }),
    ]);
    if (kRes.error || pRes.error || scRes.error || asRes.error) return false;

    // 2. Delete removed kitchens, products, orders, or order items
    if (prev) {
      const nextKitchenIds = new Set(next.kitchens.map((k) => k.id));
      const deletedKitchenIds = prev.kitchens.filter((k) => !nextKitchenIds.has(k.id)).map((k) => k.id);
      if (deletedKitchenIds.length > 0) {
        await supabase.from('kitchens').delete().in('id', deletedKitchenIds);
      }

      const nextProductIds = new Set(next.items.map((i) => i.id));
      const deletedProductIds = prev.items.filter((i) => !nextProductIds.has(i.id)).map((i) => i.id);
      if (deletedProductIds.length > 0) {
        await supabase.from('products').delete().in('id', deletedProductIds);
      }

      const nextOrderIds = new Set(next.deliveries.map((d) => d.id));
      const deletedOrderIds = prev.deliveries.filter((d) => !nextOrderIds.has(d.id)).map((d) => d.id);
      if (deletedOrderIds.length > 0) {
        await supabase.from('kitchen_orders').delete().in('id', deletedOrderIds);
      }

      const nextItemIds = new Set(next.deliveryItems.map((di) => di.id));
      const deletedItemIds = prev.deliveryItems
        .filter((di) => !nextItemIds.has(di.id) && nextOrderIds.has(di.delivery_id))
        .map((di) => di.id);
      if (deletedItemIds.length > 0) {
        await supabase.from('kitchen_order_items').delete().in('id', deletedItemIds);
      }
    }

    // 3. Upsert orders, invoices, items, payout batches, and ledger entries in FK order
    if (rows.orders.length > 0) {
      const oRes = await supabase.from('kitchen_orders').upsert(rows.orders, { onConflict: 'id' });
      if (oRes.error) return false;
    }

    if (rows.invoices.length > 0) {
      const invRes = await supabase.from('kitchen_invoices').upsert(rows.invoices, { onConflict: 'id' });
      if (invRes.error) return false;
    }

    if (rows.orderItems.length > 0) {
      const oiRes = await supabase.from('kitchen_order_items').upsert(rows.orderItems, { onConflict: 'id' });
      if (oiRes.error) return false;
    }

    if (rows.payoutBatches.length > 0) {
      const pbRes = await supabase.from('profit_payout_batches').upsert(rows.payoutBatches, { onConflict: 'id' });
      if (pbRes.error) return false;
    }

    if (rows.ledgerEntries.length > 0) {
      const pleRes = await supabase.from('profit_ledger_entries').upsert(rows.ledgerEntries, { onConflict: 'id' });
      if (pleRes.error) return false;
    }

    return true;
  } catch {
    return false;
  }
}

export function subscribeToMbgRealtime(
  supabase: SupabaseClient,
  onRemoteChange: () => void,
  onStatusChange?: (connected: boolean) => void
): () => void {
  const channel = supabase
    .channel('mbg-order-driven-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kitchens' }, onRemoteChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, onRemoteChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kitchen_orders' }, onRemoteChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kitchen_order_items' }, onRemoteChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kitchen_invoices' }, onRemoteChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profit_ledger_entries' }, onRemoteChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profit_split_configs' }, onRemoteChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, onRemoteChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profit_payout_batches' }, onRemoteChange)
    .subscribe((status) => {
      if (onStatusChange) {
        onStatusChange(status === 'SUBSCRIBED');
      }
    });

  return () => {
    void supabase.removeChannel(channel);
  };
}
