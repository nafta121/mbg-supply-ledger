'use client';

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { BeneficiaryType, Item, Kitchen, ProfitSplitConfig, SafeCourierBastItem, UserRole } from '../types/mbg';
import { idrToSen, senToIdr, toWholeKg } from './financial-engine';
import {
  applyBastWeights,
  buildSafeCourierItems,
  createKitchenOrder,
  type CreateOrderInput,
  deleteKitchenOrder,
  type EngineCtx,
  type EngineResult,
  executePayout as executePayoutEngine,
  markInvoicePaid as markInvoicePaidEngine,
  type MbgData,
  type OrderLineInput,
  removeOrderLine as removeOrderLineEngine,
  type UpdateBastInput,
  updateProfitSplit,
} from './order-engine';
import { fetchMbgDataFromSupabase, subscribeToMbgRealtime, syncMbgDataToSupabase } from './supabase-sync';
import { createClient as createSupabaseClient, isSupabaseConfigured } from '../utils/supabase/client';

export { buildSafeCourierItems } from './order-engine';
export type { CreateOrderInput, OrderLineInput, UpdateBastInput } from './order-engine';

// v5 (Stage 8): order-driven model (no supplier batches) — older local state is discarded.
const STORAGE_KEY = 'mbg_supply_ledger_state_v5';
/** Business date of the simulation ("hari ini" for Order Dapur & kurir). */
export const BUSINESS_DATE = '2026-10-16';

export type ActiveTab = 'orders' | 'bast' | 'invoices' | 'ledger';

export interface MbgState extends MbgData {
  activeRole: UserRole;
  activeTab: ActiveTab;
}

/** Master data inputs (Admin only). `id` present = edit, absent = create. */
export interface KitchenMasterInput {
  id?: string;
  name: string;
  address: string;
  pic_name: string;
  pic_phone: string;
}

export interface ItemMasterInput {
  id?: string;
  name: string;
  category: string;
  /** Typed rupiah text, e.g. "14.000". */
  default_kitchen_price_per_kg: string;
  /** Typed rupiah text, e.g. "2.000". */
  default_margin_per_kg: string;
}

export type MasterSaveResult = { ok: true } | { ok: false; error: string };
export type ActionResult = { ok: true; merged?: boolean; count?: number } | { ok: false; error: string };

export interface MbgContextValue extends MbgState {
  setActiveRole: (role: UserRole) => void;
  setActiveTab: (tab: ActiveTab) => void;
  /** "Simpan Order & Kirim ke Daftar Kurir". */
  createOrder: (input: CreateOrderInput) => ActionResult;
  removeOrderLine: (delivery_item_id: string) => ActionResult;
  deleteOrder: (delivery_id: string) => ActionResult;
  /** Saves BAST weights for several items of one kitchen order at once. */
  saveKitchenBast: (lines: UpdateBastInput[]) => ActionResult;
  markInvoicePaid: (invoice_id: string) => ActionResult;
  updateProfitSplitPercentage: (team_share_pct: number, cooperative_share_pct: number) => ActionResult;
  executePayout: (beneficiary_type: BeneficiaryType, notes?: string) => ActionResult;
  saveKitchen: (input: KitchenMasterInput) => MasterSaveResult;
  saveItem: (input: ItemMasterInput) => MasterSaveResult;
  resetSimulationData: () => void;
  /** Price-free courier projection (Invariant 5) used by the Timbang screen. */
  getSafeCourierItems: () => SafeCourierBastItem[];
}

// ---------- Master data (pure helpers) ----------
// Editing master records never touches price snapshots on orders/invoices
// (Invariant 3) — historical rows reference master data by id only.

const clean = (v: string | null | undefined): string => (v ?? '').trim();

/** "14.000" / "Rp 14.000" → 14000 (digits only; empty → 0). */
function rupiahFromText(raw: string | null | undefined): number {
  const digits = clean(raw).replace(/\D/g, '');
  return digits ? Number(digits) : 0;
}

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

export function validateItemInput(input: ItemMasterInput): string | null {
  if (!clean(input.name)) return 'Nama barang wajib diisi.';
  const price = rupiahFromText(input.default_kitchen_price_per_kg);
  const margin = rupiahFromText(input.default_margin_per_kg);
  if (margin > price) return 'Margin default tidak boleh melebihi harga dapur default.';
  return null;
}

export function upsertKitchenRecord(list: Kitchen[], input: KitchenMasterInput, nowIso: string): Kitchen[] {
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

export function upsertItemRecord(list: Item[], input: ItemMasterInput, nowIso: string): Item[] {
  const fields = {
    name: clean(input.name),
    category: clean(input.category) || 'Lainnya',
    base_unit: 'kg' as const, // Invariant 1: unit is always locked to kg
    default_kitchen_price_per_kg: senToIdr(idrToSen(rupiahFromText(input.default_kitchen_price_per_kg))),
    default_margin_per_kg: senToIdr(idrToSen(rupiahFromText(input.default_margin_per_kg))),
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

/** `35 kg` — whole kilograms only, never `35.000 kg` (Invariant 1). */
export function formatKg(kg: number): string {
  return `${toWholeKg(kg)} kg`;
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

// ---------- Seed data (real Phase-1 scenario) ----------

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

const SEED_ITEMS: Array<Pick<Item, 'id' | 'sku' | 'name' | 'category' | 'default_kitchen_price_per_kg' | 'default_margin_per_kg'>> = [
  { id: 'item-wortel', sku: 'SYR-WRT-KG', name: 'Wortel', category: 'Sayuran Segar', default_kitchen_price_per_kg: 14000, default_margin_per_kg: 2000 },
  { id: 'item-kubis', sku: 'SYR-KBS-KG', name: 'Kubis', category: 'Sayuran Segar', default_kitchen_price_per_kg: 10000, default_margin_per_kg: 1500 },
  { id: 'item-ayam', sku: 'AYM-FIL-KG', name: 'Daging Ayam Fillet', category: 'Protein Hewani', default_kitchen_price_per_kg: 40000, default_margin_per_kg: 4000 },
  { id: 'item-telur', sku: 'TLR-AYM-KG', name: 'Telur Ayam', category: 'Protein Hewani', default_kitchen_price_per_kg: 30500, default_margin_per_kg: 3000 },
  { id: 'item-beras', sku: 'BRS-PRM-KG', name: 'Beras', category: 'Karbohidrat Utama', default_kitchen_price_per_kg: 15000, default_margin_per_kg: 1500 },
];

function unwrap<T extends MbgData>(res: EngineResult<T>, step: string): T {
  if (!res.ok) throw new Error(`Seed gagal (${step}): ${res.error}`);
  return res.data;
}

/**
 * Seed (16 Okt 2026) — 5 Order Dapur, harga dapur & margin per kg, berat kilogram bulat:
 * - DPR-01: Wortel 35 + Kubis 25 → ditimbang utuh, invoice LUNAS (Rp 740.000).
 * - DPR-02: Daging Ayam 50 (diterima 49, susut -1) + Telur 20 → LUNAS.
 * - DPR-03: Wortel 35 (diterima 33, reject -2) + Beras 50 → Selesai BAST, Belum Bayar.
 * - DPR-04: Wortel 35 + Kubis 50 + Daging Ayam 50 → Menunggu Kurir.
 * - DPR-05: Daging Ayam 50 (tertimbang) + Telur 25 (belum) → Sebagian Tertimbang.
 * Muatan kurir: Wortel 105 kg • Kubis 75 kg • Daging Ayam 150 kg • Telur 45 kg • Beras 50 kg.
 */
export function createInitialSeedState(): MbgState {
  const nowIso = '2026-10-16T06:00:00.000Z';
  let n = 0;
  const ctx: EngineCtx = {
    nowIso,
    today: BUSINESS_DATE,
    uid: (prefix) => `${prefix}-${String(++n).padStart(2, '0')}`,
  };

  const kitchens: Kitchen[] = KITCHEN_LOCATIONS.map((loc, idx) => {
    const num = String(idx + 1).padStart(2, '0');
    return {
      id: `kitchen-${num}`,
      kitchen_code: `DPR-${num}`,
      name: loc.name,
      address: loc.area,
      pic_name: loc.pic,
      pic_phone: `0812-9000-00${num}`,
      default_markup_per_kg: 0,
      is_active: true,
      created_at: nowIso,
    };
  });

  const items: Item[] = SEED_ITEMS.map((it) => ({
    ...it,
    base_unit: 'kg',
    is_active: true,
    created_at: nowIso,
  }));

  const splitConfig: ProfitSplitConfig = {
    id: 'split-default-60-40',
    config_name: 'Skema Bagi Hasil Standar Tim 60% : Koperasi 40%',
    team_share_pct: 60.0,
    cooperative_share_pct: 40.0,
    is_active: true,
    effective_from: BUSINESS_DATE,
    created_at: nowIso,
  };

  let data: MbgData = {
    kitchens,
    items,
    deliveries: [],
    deliveryItems: [],
    invoices: [],
    splitConfig,
    ledgerEntries: [],
    payoutBatches: [],
  };

  const line = (item_id: string, qty: number): OrderLineInput => {
    const it = items.find((i) => i.id === item_id)!;
    return {
      item_id,
      qty_ordered_kg: qty,
      kitchen_unit_price_rp: it.default_kitchen_price_per_kg,
      margin_per_kg_rp: it.default_margin_per_kg,
    };
  };
  const order = (kitchenIdx: number, lines: OrderLineInput[]) => {
    const res = createKitchenOrder(data, { kitchen_id: kitchens[kitchenIdx]!.id, lines }, ctx);
    data = unwrap(res, `order ${kitchenIdx + 1}`);
    if (!res.ok || !res.delivery_id) throw new Error('Seed gagal: order tanpa id');
    return res.delivery_id;
  };
  const weigh = (deliveryId: string, weights: Array<[string, number, string | null]>) => {
    const inputs: UpdateBastInput[] = weights.map(([itemId, kg, reason]) => {
      const di = data.deliveryItems.find((d) => d.delivery_id === deliveryId && d.item_id === itemId)!;
      return { delivery_item_id: di.id, qty_accepted_kg: kg, rejection_reason: reason };
    });
    data = unwrap(applyBastWeights(data, inputs, '2026-10-16T09:00:00.000Z'), 'timbang');
  };
  const pay = (deliveryId: string) => {
    const inv = data.invoices.find((i) => i.delivery_id === deliveryId)!;
    data = unwrap(markInvoicePaidEngine(data, inv.id, '2026-10-16T15:00:00.000Z'), 'lunas');
  };

  const o1 = order(0, [line('item-wortel', 35), line('item-kubis', 25)]);
  weigh(o1, [
    ['item-wortel', 35, null],
    ['item-kubis', 25, null],
  ]);
  pay(o1);

  const o2 = order(1, [line('item-ayam', 50), line('item-telur', 20)]);
  weigh(o2, [
    ['item-ayam', 49, 'Susut — susut air/perjalanan'],
    ['item-telur', 20, null],
  ]);
  pay(o2);

  const o3 = order(2, [line('item-wortel', 35), line('item-beras', 50)]);
  weigh(o3, [
    ['item-wortel', 33, 'Barang Rusak/Reject — wortel patah/busuk'],
    ['item-beras', 50, null],
  ]);

  order(3, [line('item-wortel', 35), line('item-kubis', 50), line('item-ayam', 50)]);

  const o5 = order(4, [line('item-ayam', 50), line('item-telur', 25)]);
  weigh(o5, [['item-ayam', 50, null]]);

  return { activeRole: 'OWNER_ADMIN', activeTab: 'orders', ...data };
}

// ---------- React store ----------

const MbgContext = createContext<MbgContextValue | null>(null);

let runtimeSeq = 0;
function runtimeCtx(): EngineCtx {
  return {
    nowIso: new Date().toISOString(),
    today: BUSINESS_DATE,
    uid: (prefix) => `${prefix}-${Date.now().toString(36)}-${(runtimeSeq += 1)}`,
  };
}

function isCompatibleState(parsed: unknown): parsed is MbgState {
  const s = parsed as Partial<MbgState> | null;
  return (
    !!s &&
    Array.isArray(s.kitchens) &&
    s.kitchens.length > 0 &&
    Array.isArray(s.items) &&
    Array.isArray(s.deliveryItems) &&
    Array.isArray(s.invoices) &&
    Array.isArray(s.ledgerEntries) &&
    !!s.splitConfig
  );
}

export function MbgProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<MbgState>(() => createInitialSeedState());
  const [hydrated, setHydrated] = useState(false);
  // Latest committed state, so several actions inside one click handler
  // (e.g. "Cairkan Semua") build on each other instead of a stale render.
  const stateRef = useRef<MbgState>(state);

  const commit = (next: MbgState) => {
    stateRef.current = next;
    setState(next);
  };

  const commitAndSync = (next: MbgState) => {
    const prev = stateRef.current;
    commit(next);
    if (isSupabaseConfigured) {
      const supabase = createSupabaseClient();
      void syncMbgDataToSupabase(supabase, prev, next);
    }
  };

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (isCompatibleState(parsed)) commit(parsed);
      }
    } catch {
      // Fallback to default seed data if localStorage is unavailable or corrupt
    }
    setHydrated(true);

    if (!isSupabaseConfigured) return;

    const supabase = createSupabaseClient();
    let active = true;

    const pullRemote = async () => {
      const remoteData = await fetchMbgDataFromSupabase(supabase);
      if (!active) return;
      if (remoteData) {
        commit({
          ...stateRef.current,
          ...remoteData,
        });
      } else {
        // Seed remote database if tables exist and are currently empty
        void syncMbgDataToSupabase(supabase, null, stateRef.current);
      }
    };

    void pullRemote();
    const unsubscribe = subscribeToMbgRealtime(supabase, () => {
      void pullRemote();
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Ignore storage quota errors
    }
  }, [state, hydrated]);

  const run = (fn: (current: MbgState) => EngineResult<MbgState>): ActionResult => {
    const res = fn(stateRef.current);
    if (!res.ok) return { ok: false, error: res.error };
    commitAndSync(res.data);
    return { ok: true, merged: res.merged, count: res.count };
  };

  const setActiveRole = (role: UserRole) => {
    const prev = stateRef.current;
    let nextTab = prev.activeTab;
    if (role === 'FIELD_TEAM') {
      // Single-courier focus mode: always land on "Timbang".
      nextTab = 'bast';
    } else if (role === 'COOPERATIVE_VIEWER' && nextTab === 'orders') {
      nextTab = 'ledger';
    }
    commit({ ...prev, activeRole: role, activeTab: nextTab });
  };

  const setActiveTab = (tab: ActiveTab) => commit({ ...stateRef.current, activeTab: tab });

  const createOrder = (input: CreateOrderInput) => run((s) => createKitchenOrder(s, input, runtimeCtx()));

  const removeOrderLine = (id: string) => run((s) => removeOrderLineEngine(s, id, runtimeCtx().nowIso));

  const deleteOrder = (id: string) => run((s) => deleteKitchenOrder(s, id));

  const saveKitchenBast = (lines: UpdateBastInput[]) =>
    run((s) => applyBastWeights(s, lines, runtimeCtx().nowIso));

  const markInvoicePaid = (id: string) => run((s) => markInvoicePaidEngine(s, id, runtimeCtx().nowIso));

  const updateProfitSplitPercentage = (team: number, coop: number) =>
    run((s) => updateProfitSplit(s, team, coop, runtimeCtx().nowIso));

  const executePayout = (who: BeneficiaryType, notes?: string) =>
    run((s) => executePayoutEngine(s, who, runtimeCtx(), notes));

  const saveKitchen = (input: KitchenMasterInput): MasterSaveResult => {
    const error = validateKitchenInput(input);
    if (error) return { ok: false, error };
    const s = stateRef.current;
    commitAndSync({ ...s, kitchens: upsertKitchenRecord(s.kitchens, input, new Date().toISOString()) });
    return { ok: true };
  };

  const saveItem = (input: ItemMasterInput): MasterSaveResult => {
    const error = validateItemInput(input);
    if (error) return { ok: false, error };
    const s = stateRef.current;
    commitAndSync({ ...s, items: upsertItemRecord(s.items, input, new Date().toISOString()) });
    return { ok: true };
  };

  const resetSimulationData = () => {
    const fresh = createInitialSeedState();
    commitAndSync(fresh);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
    } catch {
      // Ignore storage errors
    }
  };

  const getSafeCourierItems = (): SafeCourierBastItem[] => buildSafeCourierItems(state);

  const value: MbgContextValue = {
    ...state,
    setActiveRole,
    setActiveTab,
    createOrder,
    removeOrderLine,
    deleteOrder,
    saveKitchenBast,
    markInvoicePaid,
    updateProfitSplitPercentage,
    executePayout,
    saveKitchen,
    saveItem,
    resetSimulationData,
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
