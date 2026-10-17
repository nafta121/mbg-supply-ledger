'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import type {
  BeneficiaryType,
  Item,
  Kitchen,
  KitchenDelivery,
  KitchenDeliveryItem,
  KitchenInvoice,
  ProfitLedgerEntry,
  ProfitPayoutBatch,
  ProfitSplitConfig,
  SafeCourierBastItem,
  SafeDeliveryItemBastView,
  Supplier,
  SupplierProcurementBatch,
  SupplierSettlement,
  UserRole,
} from '../types/mbg';
import {
  calculateProfitSplitEntry,
  gramsToKg,
  idrToSen,
  kgToGrams,
  reconcileKitchenDeliveryItem,
  sanitizeDeliveryForFieldTeam,
  senToIdr,
} from './financial-engine';

const STORAGE_KEY = 'mbg_supply_ledger_state_v3';
const SIM_DATE = '2026-10-16';

export type ActiveTab = 'batches' | 'matrix' | 'bast' | 'invoices' | 'ledger';

export interface MbgState {
  activeRole: UserRole;
  activeTab: ActiveTab;
  kitchens: Kitchen[];
  suppliers: Supplier[];
  items: Item[];
  batches: SupplierProcurementBatch[];
  deliveries: KitchenDelivery[];
  deliveryItems: KitchenDeliveryItem[];
  invoices: KitchenInvoice[];
  supplierSettlements: SupplierSettlement[];
  splitConfig: ProfitSplitConfig;
  ledgerEntries: ProfitLedgerEntry[];
  payoutBatches: ProfitPayoutBatch[];
}

export interface AddBatchInput {
  supplier_id: string;
  item_id: string;
  qty_received_kg: number;
  supplier_actual_cost_per_kg: number;
  notes?: string;
}

export interface BatchKitchenAllocationInput {
  supplier_batch_id: string;
  kitchen_unit_price_per_kg: number;
  allocations: Array<{
    kitchen_id: string;
    qty_dispatched_kg: number;
  }>;
}

export interface UpdateBastInput {
  delivery_item_id: string;
  qty_accepted_kg: number;
  rejection_reason?: string | null;
  bast_signed_by_name?: string;
}

/** Master data inputs (Admin only). `id` present = edit, absent = create. */
export interface KitchenMasterInput {
  id?: string;
  name: string;
  address: string;
  pic_name: string;
  pic_phone: string;
}

export interface SupplierMasterInput {
  id?: string;
  name: string;
  contact_person: string;
  phone: string;
  bank_name: string;
  bank_account_number: string;
  bank_account_holder: string;
}

export interface ItemMasterInput {
  id?: string;
  name: string;
  category: string;
}

export type MasterSaveResult = { ok: true } | { ok: false; error: string };

export interface MbgContextValue extends MbgState {
  setActiveRole: (role: UserRole) => void;
  setActiveTab: (tab: ActiveTab) => void;
  addSupplierBatch: (input: AddBatchInput) => void;
  allocateBatchToKitchens: (input: BatchKitchenAllocationInput) => void;
  updateBastAcceptance: (input: UpdateBastInput) => void;
  acceptFullBast: (delivery_item_id: string) => void;
  markInvoicePaid: (invoice_id: string) => void;
  markSupplierSettlementPaid: (settlement_id: string) => void;
  updateProfitSplitPercentage: (team_share_pct: number, cooperative_share_pct: number) => void;
  executePayout: (beneficiary_type: BeneficiaryType, notes?: string) => void;
  saveKitchen: (input: KitchenMasterInput) => MasterSaveResult;
  saveSupplier: (input: SupplierMasterInput) => MasterSaveResult;
  saveItem: (input: ItemMasterInput) => MasterSaveResult;
  resetSimulationData: () => void;
  getBatchRemainingKg: (batch_id: string) => number;
  getSafeBastItemsForFieldTeam: () => SafeDeliveryItemBastView[];
  /** Price-free courier projection (Invariant 5) used by the kitchen-centric view. */
  getSafeCourierItems: () => SafeCourierBastItem[];
  /** Saves BAST weights for several items of one kitchen stop at once. */
  saveKitchenBast: (lines: UpdateBastInput[]) => void;
}

// ---------- Master data (pure helpers) ----------
// Editing master records never touches price snapshots on deliveries/invoices
// (Invariant 3) — historical rows reference master data by id only.

const clean = (v: string | null | undefined): string => (v ?? '').trim();
const orNull = (v: string | null | undefined): string | null => clean(v) || null;

function nextCode(prefix: string, suffix: string, existing: string[]): string {
  const taken = new Set(existing);
  let n = existing.length + 1;
  let code = `${prefix}${String(n).padStart(2, '0')}${suffix}`;
  while (taken.has(code)) {
    n += 1;
    code = `${prefix}${String(n).padStart(2, '0')}${suffix}`;
  }
  return code;
}

export function validateKitchenInput(input: KitchenMasterInput): string | null {
  if (!clean(input.name)) return 'Nama dapur wajib diisi.';
  if (!clean(input.pic_name)) return 'Nama PIC wajib diisi.';
  if (!clean(input.pic_phone)) return 'No. WA PIC wajib diisi.';
  return null;
}

export function validateSupplierInput(input: SupplierMasterInput): string | null {
  if (!clean(input.name)) return 'Nama supplier wajib diisi.';
  return null;
}

export function validateItemInput(input: ItemMasterInput): string | null {
  if (!clean(input.name)) return 'Nama bahan baku wajib diisi.';
  return null;
}

export function upsertKitchenRecord(
  list: Kitchen[],
  input: KitchenMasterInput,
  nowIso: string
): Kitchen[] {
  const fields = {
    name: clean(input.name),
    address: clean(input.address) || '-',
    pic_name: clean(input.pic_name),
    pic_phone: clean(input.pic_phone),
  };
  if (input.id) {
    return list.map((k) => (k.id === input.id ? { ...k, ...fields } : k));
  }
  const code = nextCode('DPR-', '', list.map((k) => k.kitchen_code));
  return [
    ...list,
    {
      id: `kitchen-${code.toLowerCase()}-${Date.now()}`,
      kitchen_code: code,
      ...fields,
      default_markup_per_kg: 0,
      is_active: true,
      created_at: nowIso,
    },
  ];
}

export function upsertSupplierRecord(
  list: Supplier[],
  input: SupplierMasterInput,
  nowIso: string
): Supplier[] {
  const fields = {
    name: clean(input.name),
    contact_person: orNull(input.contact_person),
    phone: orNull(input.phone),
    bank_name: orNull(input.bank_name),
    bank_account_number: orNull(input.bank_account_number),
    bank_account_holder: orNull(input.bank_account_holder),
  };
  if (input.id) {
    return list.map((s) => (s.id === input.id ? { ...s, ...fields } : s));
  }
  const code = nextCode('SUP-', '', list.map((s) => s.supplier_code));
  return [
    ...list,
    {
      id: `sup-${code.toLowerCase()}-${Date.now()}`,
      supplier_code: code,
      ...fields,
      is_active: true,
      created_at: nowIso,
    },
  ];
}

export function upsertItemRecord(list: Item[], input: ItemMasterInput, nowIso: string): Item[] {
  const fields = {
    name: clean(input.name),
    category: clean(input.category) || 'Lainnya',
    base_unit: 'kg' as const, // Invariant 1: unit is always locked to kg
  };
  if (input.id) {
    return list.map((i) => (i.id === input.id ? { ...i, ...fields } : i));
  }
  const sku = nextCode('ITM', '-KG', list.map((i) => i.sku));
  return [
    ...list,
    {
      id: `item-${sku.toLowerCase()}-${Date.now()}`,
      sku,
      ...fields,
      is_active: true,
      created_at: nowIso,
    },
  ];
}

/** `#B05` — chronological batch sequence (batches are stored newest-first). */
export function batchShortCode(batchId: string, batches: SupplierProcurementBatch[]): string {
  const idx = batches.findIndex((b) => b.id === batchId);
  if (idx < 0) return '#B--';
  return `#B${String(batches.length - idx).padStart(2, '0')}`;
}

export function formatKg(kg: number): string {
  const exact = gramsToKg(kgToGrams(kg));
  return `${exact.toFixed(3)} kg`;
}

export function formatIdr(idr: number): string {
  const exact = senToIdr(idrToSen(idr));
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(exact);
}

const KITCHEN_LOCATIONS: Array<{ name: string; pic: string; area: string }> = [
  { name: 'SPPG Dapur 01 - Tebet (Dapur A)', pic: 'Budi Santoso', area: 'Jl. Tebet Raya No. 12, Jakarta Selatan' },
  { name: 'SPPG Dapur 02 - Cawang (Dapur B)', pic: 'Siti Aminah', area: 'Jl. Dewi Sartika No. 45, Jakarta Timur' },
  { name: 'SPPG Dapur 03 - Kalibata (Dapur C)', pic: 'Hendra Wijaya', area: 'Jl. Raya Kalibata No. 8, Jakarta Selatan' },
  { name: 'SPPG Dapur 04 - Pasar Minggu (Dapur D)', pic: 'Rina Kusuma', area: 'Jl. Ragunan Raya No. 19, Jakarta Selatan' },
  { name: 'SPPG Dapur 05 - Pancoran (Dapur E)', pic: 'Agus Pratama', area: 'Jl. Pancoran Barat No. 3, Jakarta Selatan' },
  { name: 'SPPG Dapur 06 - Manggarai', pic: 'Dewi Sartika', area: 'Jl. Sultan Agung No. 21, Jakarta Selatan' },
  { name: 'SPPG Dapur 07 - Matraman', pic: 'Eko Nugroho', area: 'Jl. Matraman Raya No. 54, Jakarta Timur' },
  { name: 'SPPG Dapur 08 - Jatinegara', pic: 'Fajar Hidayat', area: 'Jl. Jatinegara Timur No. 77, Jakarta Timur' },
  { name: 'SPPG Dapur 09 - Kramat Jati', pic: 'Gita Permata', area: 'Jl. Raya Bogor KM 19, Jakarta Timur' },
  { name: 'SPPG Dapur 10 - Cililitan', pic: 'Hadi Sucipto', area: 'Jl. Mayjen Sutoyo No. 14, Jakarta Timur' },
  { name: 'SPPG Dapur 11 - Pejaten', pic: 'Indah Lestari', area: 'Jl. Pejaten Barat No. 30, Jakarta Selatan' },
  { name: 'SPPG Dapur 12 - Kemang', pic: 'Joko Susilo', area: 'Jl. Kemang Raya No. 62, Jakarta Selatan' },
  { name: 'SPPG Dapur 13 - Mampang', pic: 'Kartika Sari', area: 'Jl. Mampang Prapatan No. 88, Jakarta Selatan' },
  { name: 'SPPG Dapur 14 - Kuningan', pic: 'Lukman Hakim', area: 'Jl. HR Rasuna Said Kav. 10, Jakarta Selatan' },
  { name: 'SPPG Dapur 15 - Setiabudi', pic: 'Maya Anggraini', area: 'Jl. Setiabudi Utara No. 5, Jakarta Selatan' },
  { name: 'SPPG Dapur 16 - Cipete', pic: 'Nanda Putra', area: 'Jl. Cipete Raya No. 41, Jakarta Selatan' },
  { name: 'SPPG Dapur 17 - Fatmawati', pic: 'Oki Setiawan', area: 'Jl. RS Fatmawati No. 17, Jakarta Selatan' },
  { name: 'SPPG Dapur 18 - Cilandak', pic: 'Putri Maharani', area: 'Jl. Cilandak KKO No. 25, Jakarta Selatan' },
  { name: 'SPPG Dapur 19 - Jagakarsa', pic: 'Qori Rahman', area: 'Jl. Moh. Kahfi II No. 9, Jakarta Selatan' },
  { name: 'SPPG Dapur 20 - Lenteng Agung', pic: 'Rudi Hermawan', area: 'Jl. Raya Lenteng Agung No. 33, Jakarta Selatan' },
  { name: 'SPPG Dapur 21 - Duren Sawit', pic: 'Sari Wulandari', area: 'Jl. Kolonel Sugiono No. 50, Jakarta Timur' },
  { name: 'SPPG Dapur 22 - Pondok Bambu', pic: 'Taufik Hidayat', area: 'Jl. Pahlawan Revolusi No. 16, Jakarta Timur' },
  { name: 'SPPG Dapur 23 - Klender', pic: 'Umar Bakri', area: 'Jl. I Gusti Ngurah Rai No. 72, Jakarta Timur' },
  { name: 'SPPG Dapur 24 - Rawamangun', pic: 'Vina Panduwinata', area: 'Jl. Pemuda No. 29, Jakarta Timur' },
  { name: 'SPPG Dapur 25 - Pulogadung', pic: 'Wahyu Kurniawan', area: 'Jl. Perintis Kemerdekaan No. 64, Jakarta Timur' },
];

export function createInitialSeedState(): MbgState {
  const nowIso = '2026-10-16T06:00:00.000Z';

  // 1. 25 Kitchens (SPPG Dapur 01 s/d 25)
  const kitchens: Kitchen[] = KITCHEN_LOCATIONS.map((loc, idx) => {
    const num = String(idx + 1).padStart(2, '0');
    return {
      id: `kitchen-${num}`,
      kitchen_code: `DPR-${num}`,
      name: loc.name,
      address: loc.area,
      pic_name: loc.pic,
      pic_phone: `0812-9000-00${num}`,
      default_markup_per_kg: idx < 3 ? 4000 : 3000,
      is_active: true,
      created_at: nowIso,
    };
  });

  // 2. 3 Suppliers
  const suppliers: Supplier[] = [
    {
      id: 'sup-a',
      supplier_code: 'SUP-A',
      name: 'CV Tani Makmur',
      contact_person: 'H. Ahmad Subarjo',
      phone: '0811-2233-4401',
      bank_name: 'BRI',
      bank_account_number: '0123-01-009876-30-1',
      bank_account_holder: 'CV Tani Makmur',
      is_active: true,
      created_at: nowIso,
    },
    {
      id: 'sup-b',
      supplier_code: 'SUP-B',
      name: 'UD Berkah Unggas',
      contact_person: 'Hj. Rahmawati',
      phone: '0811-2233-4402',
      bank_name: 'Bank Mandiri',
      bank_account_number: '124-00-0987654-3',
      bank_account_holder: 'UD Berkah Unggas',
      is_active: true,
      created_at: nowIso,
    },
    {
      id: 'sup-c',
      supplier_code: 'SUP-C',
      name: 'PT Pangan Nusantara Segar',
      contact_person: 'Ir. Gunawan Wibisono',
      phone: '0811-2233-4403',
      bank_name: 'BCA',
      bank_account_number: '542-039811-2',
      bank_account_holder: 'PT Pangan Nusantara Segar',
      is_active: true,
      created_at: nowIso,
    },
  ];

  // 3. 5 Commodities (base_unit = 'kg' strictly)
  const items: Item[] = [
    {
      id: 'item-ayam',
      sku: 'AYM-FIL-KG',
      name: 'Daging Ayam Fillet Tanpa Tulang',
      category: 'Protein Hewani',
      base_unit: 'kg',
      is_active: true,
      created_at: nowIso,
    },
    {
      id: 'item-sapi',
      sku: 'SAP-GIL-KG',
      name: 'Daging Sapi Giling Segar',
      category: 'Protein Hewani',
      base_unit: 'kg',
      is_active: true,
      created_at: nowIso,
    },
    {
      id: 'item-telur',
      sku: 'TLR-AYM-KG',
      name: 'Telur Ayam Negeri Grade A',
      category: 'Protein Hewani',
      base_unit: 'kg',
      is_active: true,
      created_at: nowIso,
    },
    {
      id: 'item-beras',
      sku: 'BRS-PRM-KG',
      name: 'Beras Putih Premium SPPG',
      category: 'Karbohidrat Utama',
      base_unit: 'kg',
      is_active: true,
      created_at: nowIso,
    },
    {
      id: 'item-wortel',
      sku: 'SYR-WRT-KG',
      name: 'Wortel & Sayur Brastagi Bersih',
      category: 'Sayuran Segar',
      base_unit: 'kg',
      is_active: true,
      created_at: nowIso,
    },
  ];

  // 4. Active Profit Split Config (Tim 60% vs Koperasi 40%)
  const splitConfig: ProfitSplitConfig = {
    id: 'split-default-60-40',
    config_name: 'Skema Bagi Hasil Standar Tim 60% : Koperasi 40%',
    team_share_pct: 60.0,
    cooperative_share_pct: 40.0,
    is_active: true,
    effective_from: SIM_DATE,
    created_at: nowIso,
  };

  // 5. Procurement Batches (matching docs/01 + extra batch for live matrix allocation demo)
  const batches: SupplierProcurementBatch[] = [
    {
      id: 'batch-sup-a-ayam',
      batch_code: 'BATCH-20261016-SUPA-AYM',
      supplier_id: 'sup-a',
      item_id: 'item-ayam',
      procurement_date: SIM_DATE,
      qty_procured_kg: 150.0,
      supplier_actual_cost_per_kg: 36000.0,
      notes: 'Pengadaan Ayam Fillet Batch 1 (CV Tani Makmur) untuk Dapur 01-03',
      created_by: 'owner-1',
      created_at: nowIso,
    },
    {
      id: 'batch-sup-b-ayam',
      batch_code: 'BATCH-20261016-SUPB-AYM',
      supplier_id: 'sup-b',
      item_id: 'item-ayam',
      procurement_date: SIM_DATE,
      qty_procured_kg: 100.0,
      supplier_actual_cost_per_kg: 37000.0,
      notes: 'Pengadaan Ayam Fillet Batch 2 (UD Berkah Unggas) untuk Dapur 04-05',
      created_by: 'owner-1',
      created_at: nowIso,
    },
    {
      id: 'batch-sup-c-telur',
      batch_code: 'BATCH-20261016-SUPC-TLR',
      supplier_id: 'sup-c',
      item_id: 'item-telur',
      procurement_date: SIM_DATE,
      qty_procured_kg: 500.0,
      supplier_actual_cost_per_kg: 26500.0,
      notes: 'Stok Siap Alokasi ke 25 Dapur MBG (Telur Ayam Negeri)',
      created_by: 'owner-1',
      created_at: nowIso,
    },
  ];

  // 6. Seed 5 Kitchen Deliveries & Delivery Items from docs/01-domain-workflows-and-formulas.md
  //    + Stage 6: 2 pending Telur deliveries to DPR-01 & DPR-02 so the courier view
  //    shows kitchens with multiple items grouped on one card.
  interface SeedScenario {
    kitchenIdx: number;
    batchId: string;
    supplierId: string;
    itemId: string;
    dispatchedKg: number;
    acceptedKg: number;
    costSnapshot: number;
    priceSnapshot: number;
    rejectionReason: string | null;
    invoiceStatus: 'PAID' | 'ISSUED' | 'UNPAID';
    amountPaid: number;
    deliveryStatus?: 'INVOICED' | 'IN_TRANSIT';
  }
  const seedScenarios: SeedScenario[] = [
    {
      kitchenIdx: 0, // Dapur A (01)
      batchId: 'batch-sup-a-ayam',
      supplierId: 'sup-a',
      itemId: 'item-ayam',
      dispatchedKg: 50.0,
      acceptedKg: 50.0,
      costSnapshot: 36000.0,
      priceSnapshot: 40000.0,
      rejectionReason: null,
      invoiceStatus: 'PAID' as const,
      amountPaid: 2000000.0,
    },
    {
      kitchenIdx: 1, // Dapur B (02) - Susut 1.250 kg
      batchId: 'batch-sup-a-ayam',
      supplierId: 'sup-a',
      itemId: 'item-ayam',
      dispatchedKg: 50.0,
      acceptedKg: 48.75,
      costSnapshot: 36000.0,
      priceSnapshot: 40000.0,
      rejectionReason: 'Susut — susut air/perjalanan saat timbang BAST di Dapur 02',
      invoiceStatus: 'PAID' as const,
      amountPaid: 1950000.0,
    },
    {
      kitchenIdx: 2, // Dapur C (03) - ISSUED (Belum Bayar)
      batchId: 'batch-sup-a-ayam',
      supplierId: 'sup-a',
      itemId: 'item-ayam',
      dispatchedKg: 50.0,
      acceptedKg: 50.0,
      costSnapshot: 36000.0,
      priceSnapshot: 40000.0,
      rejectionReason: null,
      invoiceStatus: 'ISSUED' as const,
      amountPaid: 0.0,
    },
    {
      kitchenIdx: 3, // Dapur D (04) - Reject 1.750 kg
      batchId: 'batch-sup-b-ayam',
      supplierId: 'sup-b',
      itemId: 'item-ayam',
      dispatchedKg: 50.0,
      acceptedKg: 48.25,
      costSnapshot: 37000.0,
      priceSnapshot: 40000.0,
      rejectionReason: 'Barang Rusak/Reject — ayam memar dikembalikan ke Supplier',
      invoiceStatus: 'PAID' as const,
      amountPaid: 1930000.0,
    },
    {
      kitchenIdx: 4, // Dapur E (05) - UNPAID
      batchId: 'batch-sup-b-ayam',
      supplierId: 'sup-b',
      itemId: 'item-ayam',
      dispatchedKg: 50.0,
      acceptedKg: 50.0,
      costSnapshot: 37000.0,
      priceSnapshot: 40000.0,
      rejectionReason: null,
      invoiceStatus: 'UNPAID' as const,
      amountPaid: 0.0,
    },
    // Stage 6: pending multi-item stops (same flow as Admin allocation — UNPAID / LOCKED_UNPAID).
    {
      kitchenIdx: 0, // DPR-01 Tebet: Ayam (done) + Telur (pending BAST)
      batchId: 'batch-sup-c-telur',
      supplierId: 'sup-c',
      itemId: 'item-telur',
      dispatchedKg: 20.0,
      acceptedKg: 20.0,
      costSnapshot: 26500.0,
      priceSnapshot: 30500.0,
      rejectionReason: null,
      invoiceStatus: 'UNPAID',
      amountPaid: 0.0,
      deliveryStatus: 'IN_TRANSIT',
    },
    {
      kitchenIdx: 1, // DPR-02 Cawang: Ayam (done) + Telur (pending BAST)
      batchId: 'batch-sup-c-telur',
      supplierId: 'sup-c',
      itemId: 'item-telur',
      dispatchedKg: 20.0,
      acceptedKg: 20.0,
      costSnapshot: 26500.0,
      priceSnapshot: 30500.0,
      rejectionReason: null,
      invoiceStatus: 'UNPAID',
      amountPaid: 0.0,
      deliveryStatus: 'IN_TRANSIT',
    },
  ];

  const deliveries: KitchenDelivery[] = [];
  const deliveryItems: KitchenDeliveryItem[] = [];
  const invoices: KitchenInvoice[] = [];
  const ledgerEntries: ProfitLedgerEntry[] = [];

  seedScenarios.forEach((sc, idx) => {
    const num = String(idx + 1).padStart(2, '0');
    const kitchen = kitchens[sc.kitchenIdx]!;
    const deliveryId = `deliv-${num}`;
    const deliveryItemId = `ditem-${num}`;
    const invoiceId = `inv-${num}`;
    const inTransit = sc.deliveryStatus === 'IN_TRANSIT';
    const docSuffix = inTransit
      ? `${kitchen.kitchen_code.replace('-', '')}-${num}`
      : `DPR${num}`;

    const reconciled = reconcileKitchenDeliveryItem({
      supplier_batch_id: sc.batchId,
      qty_dispatched_kg: sc.dispatchedKg,
      qty_accepted_kg: sc.acceptedKg,
      supplier_actual_cost_snapshot: sc.costSnapshot,
      kitchen_unit_price_snapshot: sc.priceSnapshot,
    });

    deliveries.push({
      id: deliveryId,
      delivery_number: `SJ-20261016-${docSuffix}`,
      kitchen_id: kitchen.id,
      delivery_date: SIM_DATE,
      status: inTransit ? 'IN_TRANSIT' : 'INVOICED',
      courier_user_id: 'field-1',
      bast_signed_by_name: kitchen.pic_name,
      bast_photo_url: inTransit ? null : `https://storage.mbg.local/bast/SJ-20261016-${docSuffix}.jpg`,
      bast_verified_at: inTransit ? null : nowIso,
      notes: sc.rejectionReason,
      created_at: nowIso,
      updated_at: nowIso,
    });

    deliveryItems.push({
      id: deliveryItemId,
      delivery_id: deliveryId,
      item_id: sc.itemId,
      supplier_batch_id: sc.batchId,
      qty_dispatched_kg: reconciled.qty_dispatched_kg,
      qty_accepted_kg: reconciled.qty_accepted_kg,
      qty_shrinkage_kg: reconciled.qty_shrinkage_kg,
      supplier_actual_cost_snapshot: reconciled.supplier_actual_cost_snapshot,
      kitchen_unit_price_snapshot: reconciled.kitchen_unit_price_snapshot,
      line_invoice_amount: reconciled.kitchen_line_total,
      line_supplier_payable_amount: reconciled.supplier_net_payable,
      line_supplier_claim_amount: reconciled.supplier_shrinkage_deduction,
      line_total_markup_amount: senToIdr(
        idrToSen(reconciled.kitchen_line_total) - idrToSen(reconciled.supplier_net_payable)
      ),
      rejection_reason: sc.rejectionReason,
      created_at: nowIso,
      updated_at: nowIso,
    });

    invoices.push({
      id: invoiceId,
      invoice_number: `INV-20261016-${docSuffix}`,
      kitchen_id: kitchen.id,
      delivery_id: deliveryId,
      invoice_date: SIM_DATE,
      due_date: '2026-10-23',
      total_invoice_amount: reconciled.kitchen_line_total,
      amount_paid: sc.amountPaid,
      payment_status: sc.invoiceStatus,
      payment_proof_url:
        sc.invoiceStatus === 'PAID'
          ? `https://storage.mbg.local/payments/INV-20261016-DPR${num}.pdf`
          : null,
      paid_at: sc.invoiceStatus === 'PAID' ? '2026-10-20T10:00:00.000Z' : null,
      verified_by: sc.invoiceStatus === 'PAID' ? 'finance-1' : null,
      created_at: nowIso,
      updated_at: nowIso,
    });

    const split = calculateProfitSplitEntry({
      qty_accepted_kg: reconciled.qty_accepted_kg,
      supplier_actual_cost_snapshot: reconciled.supplier_actual_cost_snapshot,
      kitchen_unit_price_snapshot: reconciled.kitchen_unit_price_snapshot,
      team_share_pct: splitConfig.team_share_pct,
      cooperative_share_pct: splitConfig.cooperative_share_pct,
      invoice_payment_status: sc.invoiceStatus,
      amount_paid: sc.amountPaid,
      total_invoice_amount: reconciled.kitchen_line_total,
    });

    ledgerEntries.push(
      {
        id: `ledger-${num}-team`,
        invoice_id: invoiceId,
        delivery_item_id: deliveryItemId,
        split_config_id: splitConfig.id,
        beneficiary_type: 'TEAM',
        qty_accepted_kg: split.qty_accepted_kg,
        unit_markup_snapshot: split.unit_markup,
        share_pct_snapshot: split.team_share_pct,
        profit_amount: split.team_share_amount,
        payout_status: split.payout_status,
        payout_batch_id: null,
        unlocked_at: split.payout_status === 'AVAILABLE_FOR_PAYOUT' ? '2026-10-20T10:00:00.000Z' : null,
        paid_out_at: null,
        created_at: nowIso,
        updated_at: nowIso,
      },
      {
        id: `ledger-${num}-coop`,
        invoice_id: invoiceId,
        delivery_item_id: deliveryItemId,
        split_config_id: splitConfig.id,
        beneficiary_type: 'COOPERATIVE',
        qty_accepted_kg: split.qty_accepted_kg,
        unit_markup_snapshot: split.unit_markup,
        share_pct_snapshot: split.cooperative_share_pct,
        profit_amount: split.koperasi_share_amount,
        payout_status: split.payout_status,
        payout_batch_id: null,
        unlocked_at: split.payout_status === 'AVAILABLE_FOR_PAYOUT' ? '2026-10-20T10:00:00.000Z' : null,
        paid_out_at: null,
        created_at: nowIso,
        updated_at: nowIso,
      }
    );
  });

  const supplierSettlements = recomputeSupplierSettlements(batches, deliveryItems, []);

  return {
    activeRole: 'OWNER_ADMIN',
    activeTab: 'batches',
    kitchens,
    suppliers,
    items,
    batches,
    deliveries,
    deliveryItems,
    invoices,
    supplierSettlements,
    splitConfig,
    ledgerEntries,
    payoutBatches: [],
  };
}

/**
 * Mirrors `v_safe_delivery_items_bast` (migration 0002): sanitized via
 * `sanitizeDeliveryForFieldTeam`, then enriched with non-financial context only.
 * Output never contains cost/price/invoice/markup fields (Invariant 5).
 */
export function buildSafeCourierItems(
  state: Pick<MbgState, 'deliveryItems' | 'deliveries' | 'kitchens' | 'items' | 'batches'>
): SafeCourierBastItem[] {
  return state.deliveryItems.map((di) => {
    const del = state.deliveries.find((d) => d.id === di.delivery_id);
    const kitchen = state.kitchens.find((k) => k.id === del?.kitchen_id);
    const item = state.items.find((i) => i.id === di.item_id);
    const batch = state.batches.find((b) => b.id === di.supplier_batch_id);
    const safe = sanitizeDeliveryForFieldTeam({
      ...di,
      delivery_item_id: di.id,
      delivery_id: di.delivery_id,
      delivery_number: del?.delivery_number ?? 'SJ-UNKNOWN',
      delivery_date: del?.delivery_date ?? SIM_DATE,
      kitchen_id: kitchen?.id ?? 'unknown',
      kitchen_name: kitchen?.name ?? 'Dapur MBG',
      item_id: item?.id ?? di.item_id,
      item_name: item?.name ?? 'Bahan Baku MBG',
    });
    return {
      ...safe,
      batch_code: batch?.batch_code ?? '-',
      kitchen_code: kitchen?.kitchen_code ?? '-',
      kitchen_pic_name: kitchen?.pic_name ?? '-',
      kitchen_pic_phone: kitchen?.pic_phone ?? '',
      delivery_status: del?.status ?? 'ALLOCATED',
    };
  });
}

function recomputeSupplierSettlements(
  batches: SupplierProcurementBatch[],
  deliveryItems: KitchenDeliveryItem[],
  existingSettlements: SupplierSettlement[]
): SupplierSettlement[] {
  const nowIso = new Date().toISOString();
  const results: SupplierSettlement[] = [];

  for (const batch of batches) {
    const itemsForBatch = deliveryItems.filter((di) => di.supplier_batch_id === batch.id);
    if (itemsForBatch.length === 0) {
      continue;
    }

    let dispatchedGrams = 0n;
    let acceptedGrams = 0n;
    for (const di of itemsForBatch) {
      dispatchedGrams += kgToGrams(di.qty_dispatched_kg);
      acceptedGrams += kgToGrams(di.qty_accepted_kg);
    }

    const reconciled = reconcileKitchenDeliveryItem({
      supplier_batch_id: batch.id,
      qty_dispatched_kg: gramsToKg(dispatchedGrams),
      qty_accepted_kg: gramsToKg(acceptedGrams),
      supplier_actual_cost_snapshot: batch.supplier_actual_cost_per_kg,
      kitchen_unit_price_snapshot: batch.supplier_actual_cost_per_kg,
    });

    const existing = existingSettlements.find((s) => s.supplier_batch_id === batch.id);
    results.push({
      id: existing?.id ?? `stl-${batch.id}`,
      settlement_number:
        existing?.settlement_number ??
        `STL-${batch.batch_code.replace('BATCH-', '')}`,
      supplier_id: batch.supplier_id,
      supplier_batch_id: batch.id,
      total_dispatched_kg: reconciled.qty_dispatched_kg,
      total_accepted_by_kitchens_kg: reconciled.qty_accepted_kg,
      total_shrinkage_claim_kg: reconciled.qty_shrinkage_kg,
      supplier_actual_cost_per_kg: batch.supplier_actual_cost_per_kg,
      gross_payable_amount: reconciled.supplier_gross_payable,
      shrinkage_claim_deduction_amount: reconciled.supplier_shrinkage_deduction,
      net_payable_amount: reconciled.supplier_net_payable,
      status: existing?.status === 'PAID' ? 'PAID' : 'READY_TO_PAY',
      payment_proof_url: existing?.payment_proof_url ?? null,
      paid_at: existing?.paid_at ?? null,
      created_at: existing?.created_at ?? nowIso,
      updated_at: nowIso,
    });
  }

  return results;
}

const MbgContext = createContext<MbgContextValue | null>(null);

export function MbgProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<MbgState>(() => createInitialSeedState());
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as MbgState;
        if (parsed && Array.isArray(parsed.kitchens) && parsed.kitchens.length > 0) {
          setState(parsed);
        }
      }
    } catch {
      // Fallback to default seed data if localStorage is unavailable or corrupt
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Ignore storage quota errors
    }
  }, [state, hydrated]);

  const setActiveRole = (role: UserRole) => {
    setState((prev) => {
      let nextTab = prev.activeTab;
      if (role === 'FIELD_TEAM') {
        // Single-courier focus mode: always land on "Kirim Dapur" (Tab3FieldBast).
        nextTab = 'bast';
      } else if (role === 'COOPERATIVE_VIEWER' && nextTab === 'batches') {
        nextTab = 'ledger';
      }
      return { ...prev, activeRole: role, activeTab: nextTab };
    });
  };

  const setActiveTab = (tab: ActiveTab) => {
    setState((prev) => ({ ...prev, activeTab: tab }));
  };

  const addSupplierBatch = (input: AddBatchInput) => {
    setState((prev) => {
      const supplier = prev.suppliers.find((s) => s.id === input.supplier_id);
      const item = prev.items.find((i) => i.id === input.item_id);
      if (!supplier || !item) return prev;

      const seq = String(prev.batches.length + 1).padStart(2, '0');
      const skuPrefix = item.sku.split('-')[0] ?? 'ITM';
      const newBatch: SupplierProcurementBatch = {
        id: `batch-${Date.now()}`,
        batch_code: `BATCH-20261016-${supplier.supplier_code.replace('-', '')}-${skuPrefix}${seq}`,
        supplier_id: supplier.id,
        item_id: item.id,
        procurement_date: SIM_DATE,
        qty_procured_kg: gramsToKg(kgToGrams(input.qty_received_kg)),
        supplier_actual_cost_per_kg: senToIdr(idrToSen(input.supplier_actual_cost_per_kg)),
        notes: input.notes?.trim() || `Batch pengadaan ${item.name} dari ${supplier.name}`,
        created_by: 'owner-1',
        created_at: new Date().toISOString(),
      };

      return {
        ...prev,
        batches: [newBatch, ...prev.batches],
      };
    });
  };

  const allocateBatchToKitchens = (input: BatchKitchenAllocationInput) => {
    setState((prev) => {
      const batch = prev.batches.find((b) => b.id === input.supplier_batch_id);
      if (!batch) return prev;

      const validAllocations = input.allocations.filter((a) => kgToGrams(a.qty_dispatched_kg) > 0n);
      if (validAllocations.length === 0) return prev;

      const nowIso = new Date().toISOString();
      const nextDeliveries = [...prev.deliveries];
      const nextDeliveryItems = [...prev.deliveryItems];
      const nextInvoices = [...prev.invoices];
      const nextLedgerEntries = [...prev.ledgerEntries];

      for (const alloc of validAllocations) {
        const kitchen = prev.kitchens.find((k) => k.id === alloc.kitchen_id);
        if (!kitchen) continue;

        const reconciled = reconcileKitchenDeliveryItem({
          supplier_batch_id: batch.id,
          qty_dispatched_kg: alloc.qty_dispatched_kg,
          qty_accepted_kg: alloc.qty_dispatched_kg, // Default 100% until BAST modifies if shrinkage occurs
          supplier_actual_cost_snapshot: batch.supplier_actual_cost_per_kg,
          kitchen_unit_price_snapshot: input.kitchen_unit_price_per_kg,
        });

        const seqNum = String(nextDeliveries.length + 1).padStart(2, '0');
        const deliveryId = `deliv-${Date.now()}-${kitchen.id}`;
        const deliveryItemId = `ditem-${Date.now()}-${kitchen.id}`;
        const invoiceId = `inv-${Date.now()}-${kitchen.id}`;

        nextDeliveries.push({
          id: deliveryId,
          delivery_number: `SJ-20261016-${kitchen.kitchen_code.replace('-', '')}-${seqNum}`,
          kitchen_id: kitchen.id,
          delivery_date: SIM_DATE,
          status: 'IN_TRANSIT',
          courier_user_id: 'field-1',
          bast_signed_by_name: kitchen.pic_name,
          bast_photo_url: null,
          bast_verified_at: null,
          notes: null,
          created_at: nowIso,
          updated_at: nowIso,
        });

        nextDeliveryItems.push({
          id: deliveryItemId,
          delivery_id: deliveryId,
          item_id: batch.item_id,
          supplier_batch_id: batch.id,
          qty_dispatched_kg: reconciled.qty_dispatched_kg,
          qty_accepted_kg: reconciled.qty_accepted_kg,
          qty_shrinkage_kg: reconciled.qty_shrinkage_kg,
          supplier_actual_cost_snapshot: reconciled.supplier_actual_cost_snapshot,
          kitchen_unit_price_snapshot: reconciled.kitchen_unit_price_snapshot,
          line_invoice_amount: reconciled.kitchen_line_total,
          line_supplier_payable_amount: reconciled.supplier_net_payable,
          line_supplier_claim_amount: reconciled.supplier_shrinkage_deduction,
          line_total_markup_amount: senToIdr(
            idrToSen(reconciled.kitchen_line_total) - idrToSen(reconciled.supplier_net_payable)
          ),
          rejection_reason: null,
          created_at: nowIso,
          updated_at: nowIso,
        });

        nextInvoices.push({
          id: invoiceId,
          invoice_number: `INV-20261016-${kitchen.kitchen_code.replace('-', '')}-${seqNum}`,
          kitchen_id: kitchen.id,
          delivery_id: deliveryId,
          invoice_date: SIM_DATE,
          due_date: '2026-10-23',
          total_invoice_amount: reconciled.kitchen_line_total,
          amount_paid: 0,
          payment_status: 'UNPAID',
          payment_proof_url: null,
          paid_at: null,
          verified_by: null,
          created_at: nowIso,
          updated_at: nowIso,
        });

        const split = calculateProfitSplitEntry({
          qty_accepted_kg: reconciled.qty_accepted_kg,
          supplier_actual_cost_snapshot: reconciled.supplier_actual_cost_snapshot,
          kitchen_unit_price_snapshot: reconciled.kitchen_unit_price_snapshot,
          team_share_pct: prev.splitConfig.team_share_pct,
          cooperative_share_pct: prev.splitConfig.cooperative_share_pct,
          invoice_payment_status: 'UNPAID',
          amount_paid: 0,
          total_invoice_amount: reconciled.kitchen_line_total,
        });

        nextLedgerEntries.push(
          {
            id: `ledger-${Date.now()}-${kitchen.id}-team`,
            invoice_id: invoiceId,
            delivery_item_id: deliveryItemId,
            split_config_id: prev.splitConfig.id,
            beneficiary_type: 'TEAM',
            qty_accepted_kg: split.qty_accepted_kg,
            unit_markup_snapshot: split.unit_markup,
            share_pct_snapshot: split.team_share_pct,
            profit_amount: split.team_share_amount,
            payout_status: 'LOCKED_UNPAID',
            payout_batch_id: null,
            unlocked_at: null,
            paid_out_at: null,
            created_at: nowIso,
            updated_at: nowIso,
          },
          {
            id: `ledger-${Date.now()}-${kitchen.id}-coop`,
            invoice_id: invoiceId,
            delivery_item_id: deliveryItemId,
            split_config_id: prev.splitConfig.id,
            beneficiary_type: 'COOPERATIVE',
            qty_accepted_kg: split.qty_accepted_kg,
            unit_markup_snapshot: split.unit_markup,
            share_pct_snapshot: split.cooperative_share_pct,
            profit_amount: split.koperasi_share_amount,
            payout_status: 'LOCKED_UNPAID',
            payout_batch_id: null,
            unlocked_at: null,
            paid_out_at: null,
            created_at: nowIso,
            updated_at: nowIso,
          }
        );
      }

      const nextSettlements = recomputeSupplierSettlements(
        prev.batches,
        nextDeliveryItems,
        prev.supplierSettlements
      );

      return {
        ...prev,
        deliveries: nextDeliveries,
        deliveryItems: nextDeliveryItems,
        invoices: nextInvoices,
        ledgerEntries: nextLedgerEntries,
        supplierSettlements: nextSettlements,
      };
    });
  };

  const updateBastAcceptance = (input: UpdateBastInput) => {
    setState((prev) => {
      const targetItem = prev.deliveryItems.find((di) => di.id === input.delivery_item_id);
      if (!targetItem) return prev;

      const reconciled = reconcileKitchenDeliveryItem({
        supplier_batch_id: targetItem.supplier_batch_id,
        qty_dispatched_kg: targetItem.qty_dispatched_kg,
        qty_accepted_kg: input.qty_accepted_kg,
        supplier_actual_cost_snapshot: targetItem.supplier_actual_cost_snapshot,
        kitchen_unit_price_snapshot: targetItem.kitchen_unit_price_snapshot,
      });

      const nowIso = new Date().toISOString();
      const nextDeliveryItems = prev.deliveryItems.map((di) => {
        if (di.id !== targetItem.id) return di;
        return {
          ...di,
          qty_accepted_kg: reconciled.qty_accepted_kg,
          qty_shrinkage_kg: reconciled.qty_shrinkage_kg,
          line_invoice_amount: reconciled.kitchen_line_total,
          line_supplier_payable_amount: reconciled.supplier_net_payable,
          line_supplier_claim_amount: reconciled.supplier_shrinkage_deduction,
          line_total_markup_amount: senToIdr(
            idrToSen(reconciled.kitchen_line_total) - idrToSen(reconciled.supplier_net_payable)
          ),
          rejection_reason:
            reconciled.qty_shrinkage_kg > 0
              ? input.rejection_reason || 'Susut/Reject saat timbang terima BAST di Dapur'
              : null,
          updated_at: nowIso,
        };
      });

      const nextDeliveries = prev.deliveries.map((del) => {
        if (del.id !== targetItem.delivery_id) return del;
        return {
          ...del,
          status: del.status === 'INVOICED' ? ('INVOICED' as const) : ('BAST_VERIFIED' as const),
          bast_signed_by_name: input.bast_signed_by_name || del.bast_signed_by_name,
          bast_verified_at: nowIso,
          notes:
            reconciled.qty_shrinkage_kg > 0
              ? input.rejection_reason || 'Susut/Reject tercatat di BAST'
              : null,
          updated_at: nowIso,
        };
      });

      const linkedInvoice = prev.invoices.find((inv) => inv.delivery_id === targetItem.delivery_id);
      const nextInvoices = prev.invoices.map((inv) => {
        if (inv.delivery_id !== targetItem.delivery_id) return inv;
        const nextAmountPaid =
          inv.payment_status === 'PAID' ? reconciled.kitchen_line_total : inv.amount_paid;
        return {
          ...inv,
          total_invoice_amount: reconciled.kitchen_line_total,
          amount_paid: nextAmountPaid,
          updated_at: nowIso,
        };
      });

      const invoiceStatus = linkedInvoice?.payment_status ?? 'UNPAID';
      const split = calculateProfitSplitEntry({
        qty_accepted_kg: reconciled.qty_accepted_kg,
        supplier_actual_cost_snapshot: reconciled.supplier_actual_cost_snapshot,
        kitchen_unit_price_snapshot: reconciled.kitchen_unit_price_snapshot,
        team_share_pct: prev.splitConfig.team_share_pct,
        cooperative_share_pct: prev.splitConfig.cooperative_share_pct,
        invoice_payment_status: invoiceStatus,
      });

      const nextLedgerEntries = prev.ledgerEntries.map((le) => {
        if (le.delivery_item_id !== targetItem.id || le.payout_status === 'PAID_OUT') return le;
        return {
          ...le,
          qty_accepted_kg: split.qty_accepted_kg,
          unit_markup_snapshot: split.unit_markup,
          profit_amount:
            le.beneficiary_type === 'TEAM' ? split.team_share_amount : split.koperasi_share_amount,
          updated_at: nowIso,
        };
      });

      const nextSettlements = recomputeSupplierSettlements(
        prev.batches,
        nextDeliveryItems,
        prev.supplierSettlements
      );

      return {
        ...prev,
        deliveries: nextDeliveries,
        deliveryItems: nextDeliveryItems,
        invoices: nextInvoices,
        ledgerEntries: nextLedgerEntries,
        supplierSettlements: nextSettlements,
      };
    });
  };

  const acceptFullBast = (delivery_item_id: string) => {
    const item = state.deliveryItems.find((di) => di.id === delivery_item_id);
    if (!item) return;
    updateBastAcceptance({
      delivery_item_id,
      qty_accepted_kg: item.qty_dispatched_kg,
      rejection_reason: null,
    });
  };

  const saveKitchenBast = (lines: UpdateBastInput[]) => {
    // Each call is a functional state update, so all lines of one kitchen stop
    // are applied in order within the same render batch.
    for (const line of lines) updateBastAcceptance(line);
  };

  const markInvoicePaid = (invoice_id: string) => {
    setState((prev) => {
      const targetInv = prev.invoices.find((i) => i.id === invoice_id);
      if (!targetInv || targetInv.payment_status === 'PAID') return prev;

      const nowIso = new Date().toISOString();
      const nextInvoices = prev.invoices.map((inv) => {
        if (inv.id !== invoice_id) return inv;
        return {
          ...inv,
          amount_paid: inv.total_invoice_amount,
          payment_status: 'PAID' as const,
          payment_proof_url: `https://storage.mbg.local/payments/${inv.invoice_number}.pdf`,
          paid_at: nowIso,
          verified_by: 'finance-1',
          updated_at: nowIso,
        };
      });

      // Invariant 4 Atomic Trigger Simulation: LOCKED_UNPAID -> AVAILABLE_FOR_PAYOUT
      const nextLedgerEntries = prev.ledgerEntries.map((le) => {
        if (le.invoice_id !== invoice_id) return le;
        if (le.payout_status === 'LOCKED_UNPAID') {
          return {
            ...le,
            payout_status: 'AVAILABLE_FOR_PAYOUT' as const,
            unlocked_at: nowIso,
            updated_at: nowIso,
          };
        }
        return le;
      });

      return {
        ...prev,
        invoices: nextInvoices,
        ledgerEntries: nextLedgerEntries,
      };
    });
  };

  const markSupplierSettlementPaid = (settlement_id: string) => {
    setState((prev) => {
      const nowIso = new Date().toISOString();
      return {
        ...prev,
        supplierSettlements: prev.supplierSettlements.map((stl) =>
          stl.id === settlement_id
            ? {
                ...stl,
                status: 'PAID' as const,
                payment_proof_url: `https://storage.mbg.local/settlements/${stl.settlement_number}.pdf`,
                paid_at: nowIso,
                updated_at: nowIso,
              }
            : stl
        ),
      };
    });
  };

  const updateProfitSplitPercentage = (team_share_pct: number, cooperative_share_pct: number) => {
    setState((prev) => {
      const nowIso = new Date().toISOString();
      const nextSplitConfig: ProfitSplitConfig = {
        ...prev.splitConfig,
        team_share_pct,
        cooperative_share_pct,
      };

      const nextLedgerEntries = prev.ledgerEntries.map((le) => {
        if (le.payout_status === 'PAID_OUT') return le;
        const ditem = prev.deliveryItems.find((d) => d.id === le.delivery_item_id);
        const inv = prev.invoices.find((i) => i.id === le.invoice_id);
        if (!ditem || !inv) return le;

        const split = calculateProfitSplitEntry({
          qty_accepted_kg: ditem.qty_accepted_kg,
          supplier_actual_cost_snapshot: ditem.supplier_actual_cost_snapshot,
          kitchen_unit_price_snapshot: ditem.kitchen_unit_price_snapshot,
          team_share_pct,
          cooperative_share_pct,
          invoice_payment_status: inv.payment_status,
        });

        return {
          ...le,
          share_pct_snapshot:
            le.beneficiary_type === 'TEAM' ? split.team_share_pct : split.cooperative_share_pct,
          profit_amount:
            le.beneficiary_type === 'TEAM' ? split.team_share_amount : split.koperasi_share_amount,
          updated_at: nowIso,
        };
      });

      return {
        ...prev,
        splitConfig: nextSplitConfig,
        ledgerEntries: nextLedgerEntries,
      };
    });
  };

  const executePayout = (beneficiary_type: BeneficiaryType, notes?: string) => {
    setState((prev) => {
      const eligible = prev.ledgerEntries.filter(
        (le) => le.beneficiary_type === beneficiary_type && le.payout_status === 'AVAILABLE_FOR_PAYOUT'
      );
      if (eligible.length === 0) return prev;

      let totalSen = 0n;
      for (const e of eligible) {
        totalSen += idrToSen(e.profit_amount);
      }

      const nowIso = new Date().toISOString();
      const seq = String(prev.payoutBatches.length + 1).padStart(2, '0');
      const batchId = `payout-${Date.now()}`;
      const newPayoutBatch: ProfitPayoutBatch = {
        id: batchId,
        payout_reference: `PAYOUT-20261020-${beneficiary_type}-${seq}`,
        beneficiary_type,
        total_payout_amount: senToIdr(totalSen),
        transfer_proof_url: `https://storage.mbg.local/payouts/PAYOUT-20261020-${beneficiary_type}-${seq}.pdf`,
        notes:
          notes?.trim() ||
          `Pencairan Bagi Hasil Cash-Basis (${beneficiary_type}) untuk ${eligible.length} invoice PAID`,
        disbursed_by: 'owner-1',
        disbursed_at: nowIso,
        created_at: nowIso,
      };

      const eligibleIds = new Set(eligible.map((e) => e.id));
      const nextLedgerEntries = prev.ledgerEntries.map((le) => {
        if (!eligibleIds.has(le.id)) return le;
        return {
          ...le,
          payout_status: 'PAID_OUT' as const,
          payout_batch_id: batchId,
          paid_out_at: nowIso,
          updated_at: nowIso,
        };
      });

      return {
        ...prev,
        payoutBatches: [newPayoutBatch, ...prev.payoutBatches],
        ledgerEntries: nextLedgerEntries,
      };
    });
  };

  const saveKitchen = (input: KitchenMasterInput): MasterSaveResult => {
    const error = validateKitchenInput(input);
    if (error) return { ok: false, error };
    setState((prev) => ({
      ...prev,
      kitchens: upsertKitchenRecord(prev.kitchens, input, new Date().toISOString()),
    }));
    return { ok: true };
  };

  const saveSupplier = (input: SupplierMasterInput): MasterSaveResult => {
    const error = validateSupplierInput(input);
    if (error) return { ok: false, error };
    setState((prev) => ({
      ...prev,
      suppliers: upsertSupplierRecord(prev.suppliers, input, new Date().toISOString()),
    }));
    return { ok: true };
  };

  const saveItem = (input: ItemMasterInput): MasterSaveResult => {
    const error = validateItemInput(input);
    if (error) return { ok: false, error };
    setState((prev) => ({
      ...prev,
      items: upsertItemRecord(prev.items, input, new Date().toISOString()),
    }));
    return { ok: true };
  };

  const resetSimulationData = () => {
    const fresh = createInitialSeedState();
    setState(fresh);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
    } catch {
      // Ignore storage errors
    }
  };

  const getBatchRemainingKg = (batch_id: string): number => {
    const batch = state.batches.find((b) => b.id === batch_id);
    if (!batch) return 0;
    const procuredGrams = kgToGrams(batch.qty_procured_kg);
    let allocatedGrams = 0n;
    for (const di of state.deliveryItems) {
      if (di.supplier_batch_id === batch_id) {
        allocatedGrams += kgToGrams(di.qty_dispatched_kg);
      }
    }
    const diff = procuredGrams - allocatedGrams;
    return gramsToKg(diff > 0n ? diff : 0n);
  };

  const getSafeBastItemsForFieldTeam = (): SafeDeliveryItemBastView[] => {
    return state.deliveryItems.map((di) => {
      const del = state.deliveries.find((d) => d.id === di.delivery_id);
      const kitchen = state.kitchens.find((k) => k.id === del?.kitchen_id);
      const item = state.items.find((i) => i.id === di.item_id);
      return sanitizeDeliveryForFieldTeam({
        ...di,
        delivery_item_id: di.id,
        delivery_id: di.delivery_id,
        delivery_number: del?.delivery_number ?? 'SJ-UNKNOWN',
        delivery_date: del?.delivery_date ?? SIM_DATE,
        kitchen_id: kitchen?.id ?? 'unknown',
        kitchen_name: kitchen?.name ?? 'Dapur MBG',
        item_id: item?.id ?? di.item_id,
        item_name: item?.name ?? 'Bahan Baku MBG',
      });
    });
  };

  const getSafeCourierItems = (): SafeCourierBastItem[] => buildSafeCourierItems(state);

  const value: MbgContextValue = {
    ...state,
    setActiveRole,
    setActiveTab,
    addSupplierBatch,
    allocateBatchToKitchens,
    updateBastAcceptance,
    acceptFullBast,
    saveKitchenBast,
    markInvoicePaid,
    markSupplierSettlementPaid,
    updateProfitSplitPercentage,
    executePayout,
    saveKitchen,
    saveSupplier,
    saveItem,
    resetSimulationData,
    getBatchRemainingKg,
    getSafeBastItemsForFieldTeam,
    getSafeCourierItems,
  };

  return React.createElement(MbgContext.Provider, { value }, children);
}

export function useMbgStore(): MbgContextValue {
  const ctx = useContext(MbgContext);
  if (!ctx) {
    throw new Error('useMbgStore must be used within an MbgProvider');
  }
  return ctx;
}
