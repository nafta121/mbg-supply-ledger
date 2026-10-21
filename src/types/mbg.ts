/**
 * Strict TypeScript Domain Definitions for MBG B2B Kitchen Order, Invoicing & Profit-Sharing Ledger
 * Stage 8 (Order-Driven Flow): Order Dapur -> Timbang BAST Kurir -> Invoice Dapur Gabungan -> Bagi Hasil.
 * Supplier stock batches and supplier settlements are NOT part of Phase 1.
 *
 * Invariant 1: All weights are dynamic decimal kilograms (`kg`, up to 3 decimals,
 *              `NUMERIC(12,3)` — e.g. 35, 12.5, 0.2, -0.5, formatted without trailing zeros)
 *              and all monetary values are in IDR (`NUMERIC(15,2)`).
 */

export type UserRole = 'FIELD_TEAM' | 'COOPERATIVE_VIEWER' | 'FINANCE' | 'OWNER_ADMIN';

export type DeliveryStatus = 'ALLOCATED' | 'IN_TRANSIT' | 'BAST_VERIFIED' | 'INVOICED';

/** Derived order progress shown on the "Order Dapur" list. */
export type OrderProgress = 'WAITING_COURIER' | 'PARTIALLY_WEIGHED' | 'BAST_DONE';

export type InvoicePaymentStatus = 'DRAFT' | 'ISSUED' | 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';

export type BeneficiaryType = 'TEAM' | 'COOPERATIVE';

export type LedgerPayoutStatus = 'LOCKED_UNPAID' | 'AVAILABLE_FOR_PAYOUT' | 'PAID_OUT';

export type BaseUnitKg = 'kg';

// 1. public.kitchens
export interface Kitchen {
  id: string;
  kitchen_code: string;
  name: string;
  address: string;
  pic_name: string;
  pic_phone: string;
  default_markup_per_kg: number; // NUMERIC(15,2)
  is_active: boolean;
  created_at: string;
}

// 3. public.items (Invariant 1: base_unit must always be 'kg')
export interface Item {
  id: string;
  sku: string;
  name: string;
  category: string;
  base_unit: BaseUnitKg;
  /** Default "Harga Dapur / kg" auto-filled on a new order line (editable per order). */
  default_kitchen_price_per_kg: number; // NUMERIC(15,2)
  /** Default "Margin Kita / kg" (basis bagi hasil Tim & Koperasi). */
  default_margin_per_kg: number; // NUMERIC(15,2)
  is_active: boolean;
  created_at: string;
}

// 4. public.kitchen_deliveries — header "Order Dapur" (1 order = 1 kartu kurir = 1 invoice)
export interface KitchenDelivery {
  id: string;
  delivery_number: string;
  kitchen_id: string;
  delivery_date: string;
  status: DeliveryStatus;
  courier_user_id: string | null;
  bast_signed_by_name: string | null;
  bast_photo_url: string | null;
  bast_verified_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// 5. public.kitchen_delivery_items — 1 baris barang di dalam Order Dapur
export interface KitchenDeliveryItem {
  id: string;
  delivery_id: string;
  item_id: string;
  qty_dispatched_kg: number; // Berat Order = Berat Kirim (dynamic decimal kg, NUMERIC(12,3))
  qty_accepted_kg: number; // Berat diterima dapur saat BAST (dynamic decimal kg, NUMERIC(12,3))
  qty_shrinkage_kg: number; // GENERATED: qty_dispatched_kg - qty_accepted_kg
  kitchen_unit_price_snapshot: number; // NUMERIC(15,2) — Harga Dapur / kg (immutable snapshot)
  margin_per_kg_snapshot: number; // NUMERIC(15,2) — Margin Kita / kg (immutable snapshot)
  line_invoice_amount: number; // GENERATED: ROUND(qty_accepted_kg * kitchen_unit_price_snapshot, 2)
  line_margin_amount: number; // GENERATED: ROUND(qty_accepted_kg * margin_per_kg_snapshot, 2)
  /** `null` = Perlu Ditimbang; set when the courier saves the BAST weight. */
  weighed_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentAccountInfo {
  payment_bank_name: string;
  payment_account_number: string;
  payment_account_holder: string;
}

// 6. public.kitchen_invoices — 1 Invoice Dapur Gabungan per Order Dapur
export interface KitchenInvoice {
  id: string;
  invoice_number: string;
  kitchen_id: string;
  delivery_id: string;
  invoice_date: string;
  due_date: string;
  total_invoice_amount: number; // NUMERIC(15,2) = Σ line_invoice_amount
  amount_paid: number; // NUMERIC(15,2)
  payment_status: InvoicePaymentStatus;
  payment_proof_url: string | null;
  paid_at: string | null;
  verified_by: string | null;
  payment_bank_name?: string;
  payment_account_number?: string;
  payment_account_holder?: string;
  created_at: string;
  updated_at: string;
}

// 7. public.profit_split_configs
export interface ProfitSplitConfig {
  id: string;
  config_name: string;
  team_share_pct: number; // NUMERIC(5,2)
  cooperative_share_pct: number; // NUMERIC(5,2)
  admin_pin?: string;
  coop_pin?: string;
  payment_bank_name?: string;
  payment_account_number?: string;
  payment_account_holder?: string;
  is_active: boolean;
  effective_from: string;
  created_at: string;
}

// 8. public.profit_payout_batches
export interface ProfitPayoutBatch {
  id: string;
  payout_reference: string;
  beneficiary_type: BeneficiaryType;
  total_payout_amount: number; // NUMERIC(15,2)
  transfer_proof_url: string;
  notes: string | null;
  disbursed_by: string;
  disbursed_at: string;
  created_at: string;
}

// 9. public.profit_ledger_entries (Invariant 4: Cash-Basis Profit Sharing)
export interface ProfitLedgerEntry {
  id: string;
  invoice_id: string;
  delivery_item_id: string;
  split_config_id: string;
  beneficiary_type: BeneficiaryType;
  qty_accepted_kg: number; // NUMERIC(10,3)
  unit_markup_snapshot: number; // NUMERIC(15,2) — margin per kg snapshot
  share_pct_snapshot: number; // NUMERIC(5,2)
  profit_amount: number; // NUMERIC(15,2)
  payout_status: LedgerPayoutStatus;
  payout_batch_id: string | null;
  unlocked_at: string | null;
  paid_out_at: string | null;
  created_at: string;
  updated_at: string;
}

// Security-Barrier View: public.v_safe_delivery_items_bast (Invariant 5: Strict RBAC for FIELD_TEAM)
export interface SafeDeliveryItemBastView {
  delivery_item_id: string;
  delivery_id: string;
  delivery_number: string;
  delivery_date: string;
  kitchen_id: string;
  kitchen_name: string;
  item_id: string;
  item_name: string;
  base_unit: BaseUnitKg;
  qty_dispatched_kg: number;
  qty_accepted_kg: number;
  qty_shrinkage_kg: number;
  rejection_reason: string | null;
}

// Courier projection of `v_safe_delivery_items_bast` (migration 0004).
// Adds only non-financial context for the kitchen-order courier card:
// kitchen code/PIC, per-line weighed flag, and whether the order is locked (invoice paid).
// Still contains NO price, invoice amount, or margin fields (Invariant 5).
export interface SafeCourierBastItem extends SafeDeliveryItemBastView {
  kitchen_code: string;
  kitchen_pic_name: string;
  kitchen_pic_phone: string;
  /** Line already weighed at the kitchen (BAST saved). */
  is_weighed: boolean;
  /** Order is closed (kitchen invoice already Lunas) — weights can no longer change. */
  is_locked: boolean;
}
