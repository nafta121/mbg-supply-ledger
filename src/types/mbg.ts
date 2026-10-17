/**
 * Strict TypeScript Domain Definitions for MBG B2B Supply Chain, Invoicing & Profit-Sharing Ledger
 * Mirrors the 12 core PostgreSQL tables and security-barrier view `v_safe_delivery_items_bast`.
 *
 * Invariant 1: All weights are in base unit `kg` (precision to 0.001 kg = 1 gram)
 *              and all monetary values are in IDR (`NUMERIC(15,2)`).
 */

export type UserRole = 'FIELD_TEAM' | 'COOPERATIVE_VIEWER' | 'FINANCE' | 'OWNER_ADMIN';

export type DeliveryStatus = 'ALLOCATED' | 'IN_TRANSIT' | 'BAST_VERIFIED' | 'INVOICED';

export type InvoicePaymentStatus = 'DRAFT' | 'ISSUED' | 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';

export type SettlementStatus = 'PENDING_BAST' | 'READY_TO_PAY' | 'PAID';

export type BeneficiaryType = 'TEAM' | 'COOPERATIVE';

export type LedgerPayoutStatus = 'LOCKED_UNPAID' | 'AVAILABLE_FOR_PAYOUT' | 'PAID_OUT';

export type BaseUnitKg = 'kg';

// 1. public.users
export interface User {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// 2. public.kitchens
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

// 3. public.suppliers
export interface Supplier {
  id: string;
  supplier_code: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_account_holder: string | null;
  is_active: boolean;
  created_at: string;
}

// 4. public.items (Invariant 1: base_unit must always be 'kg')
export interface Item {
  id: string;
  sku: string;
  name: string;
  category: string;
  base_unit: BaseUnitKg;
  is_active: boolean;
  created_at: string;
}

// 5. public.supplier_procurement_batches (Invariant 3: Actual Cost per Batch)
export interface SupplierProcurementBatch {
  id: string;
  batch_code: string;
  supplier_id: string;
  item_id: string;
  procurement_date: string;
  qty_procured_kg: number; // NUMERIC(10,3)
  supplier_actual_cost_per_kg: number; // NUMERIC(15,2)
  notes: string | null;
  created_by: string | null;
  created_at: string;
}

// 6. public.kitchen_deliveries
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

// 7. public.kitchen_delivery_items
export interface KitchenDeliveryItem {
  id: string;
  delivery_id: string;
  item_id: string;
  supplier_batch_id: string;
  qty_dispatched_kg: number; // NUMERIC(10,3)
  qty_accepted_kg: number; // NUMERIC(10,3)
  qty_shrinkage_kg: number; // GENERATED: qty_dispatched_kg - qty_accepted_kg
  supplier_actual_cost_snapshot: number; // NUMERIC(15,2)
  kitchen_unit_price_snapshot: number; // NUMERIC(15,2)
  line_invoice_amount: number; // GENERATED: ROUND(qty_accepted_kg * kitchen_unit_price_snapshot, 2)
  line_supplier_payable_amount: number; // GENERATED: ROUND(qty_accepted_kg * supplier_actual_cost_snapshot, 2)
  line_supplier_claim_amount: number; // GENERATED: ROUND((qty_dispatched_kg - qty_accepted_kg) * supplier_actual_cost_snapshot, 2)
  line_total_markup_amount: number; // GENERATED: ROUND(qty_accepted_kg * (kitchen_unit_price_snapshot - supplier_actual_cost_snapshot), 2)
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

// 8. public.kitchen_invoices
export interface KitchenInvoice {
  id: string;
  invoice_number: string;
  kitchen_id: string;
  delivery_id: string;
  invoice_date: string;
  due_date: string;
  total_invoice_amount: number; // NUMERIC(15,2)
  amount_paid: number; // NUMERIC(15,2)
  payment_status: InvoicePaymentStatus;
  payment_proof_url: string | null;
  paid_at: string | null;
  verified_by: string | null;
  created_at: string;
  updated_at: string;
}

// 9. public.supplier_settlements (Invariant 2: Zero-Shrinkage Risk / Supplier bears shrinkage)
export interface SupplierSettlement {
  id: string;
  settlement_number: string;
  supplier_id: string;
  supplier_batch_id: string;
  total_dispatched_kg: number; // NUMERIC(10,3)
  total_accepted_by_kitchens_kg: number; // NUMERIC(10,3)
  total_shrinkage_claim_kg: number; // GENERATED: total_dispatched_kg - total_accepted_by_kitchens_kg
  supplier_actual_cost_per_kg: number; // NUMERIC(15,2)
  gross_payable_amount: number; // GENERATED: ROUND(total_dispatched_kg * supplier_actual_cost_per_kg, 2)
  shrinkage_claim_deduction_amount: number; // GENERATED: ROUND((total_dispatched_kg - total_accepted_by_kitchens_kg) * supplier_actual_cost_per_kg, 2)
  net_payable_amount: number; // GENERATED: ROUND(total_accepted_by_kitchens_kg * supplier_actual_cost_per_kg, 2)
  status: SettlementStatus;
  payment_proof_url: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

// 10. public.profit_split_configs
export interface ProfitSplitConfig {
  id: string;
  config_name: string;
  team_share_pct: number; // NUMERIC(5,2)
  cooperative_share_pct: number; // NUMERIC(5,2)
  is_active: boolean;
  effective_from: string;
  created_at: string;
}

// 11. public.profit_payout_batches
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

// 12. public.profit_ledger_entries (Invariant 4: Cash-Basis Profit Sharing)
export interface ProfitLedgerEntry {
  id: string;
  invoice_id: string;
  delivery_item_id: string;
  split_config_id: string;
  beneficiary_type: BeneficiaryType;
  qty_accepted_kg: number; // NUMERIC(10,3)
  unit_markup_snapshot: number; // NUMERIC(15,2)
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

// Extended courier projection of `v_safe_delivery_items_bast` (migration 0002).
// Adds only non-financial context for the kitchen-centric courier view:
// batch code (traceability), kitchen code/PIC, and delivery status.
// Still contains NO cost, price, invoice, or markup fields (Invariant 5).
export interface SafeCourierBastItem extends SafeDeliveryItemBastView {
  batch_code: string;
  kitchen_code: string;
  kitchen_pic_name: string;
  kitchen_pic_phone: string;
  delivery_status: DeliveryStatus;
}
