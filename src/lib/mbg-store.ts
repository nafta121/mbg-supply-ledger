'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
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
import { getSupabaseClient, isSupabaseConfigured } from './supabase';
import {
  clearAllTransactionsRpc,
  deleteKitchenFromSupabase,
  deleteProductFromSupabase,
  fetchCourierOrdersFromSupabase,
  fetchMbgDataFromSupabase,
  markInvoicePaidInSupabase,
  resetToSimulationSeedRpc,
  submitCourierWeighingBatchRpc,
  subscribeToMbgRealtime,
  syncMbgDataToSupabase,
  updateAppSettingsSplitInSupabase,
} from './supabase-sync';

export { buildSafeCourierItems } from './order-engine';
export type { CreateOrderInput, OrderLineInput, UpdateBastInput } from './order-engine';

/** Business date of the operational day ("hari ini" for Order Dapur & kurir). */
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
  /** True while initial data is loading from Supabase PostgreSQL. */
  isLoading: boolean;
  /** True while an INSERT / UPDATE / DELETE / RPC is in-flight to Supabase. */
  isSyncing: boolean;
  /** True when connected to the live Supabase cloud backend. */
  isSupabaseLive: boolean;
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
  deleteKitchen: (kitchen_id: string) => MasterSaveResult;
  deleteItem: (item_id: string) => MasterSaveResult;
  /** Restores simulation seed data in Supabase via `reset_to_simulation_seed()` RPC. */
  resetSimulationData: () => void;
  /** Truncates/clears transactions in Supabase while keeping Master Dapur & Master Barang. */
  clearAllTransactions: () => void;
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

// ---------- Canonical Seed Builder (used by unit tests & reset_to_simulation_seed parity) ----------

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

export function createEmptyCloudState(): MbgState {
  const nowIso = '2026-10-16T06:00:00.000Z';
  const splitConfig: ProfitSplitConfig = {
    id: 'split-default-60-40',
    config_name: 'Skema Bagi Hasil Standar Tim 60% : Koperasi 40%',
    team_share_pct: 60.0,
    cooperative_share_pct: 40.0,
    is_active: true,
    effective_from: BUSINESS_DATE,
    created_at: nowIso,
  };
  return {
    activeRole: 'OWNER_ADMIN',
    activeTab: 'orders',
    kitchens: [],
    items: [],
    deliveries: [],
    deliveryItems: [],
    invoices: [],
    splitConfig,
    ledgerEntries: [],
    payoutBatches: [],
  };
}

/**
 * Canonical simulation seed (16 Okt 2026) — matches `reset_to_simulation_seed()` in PostgreSQL.
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

// ---------- 100% Pure Supabase Cloud React Store (No localStorage business data) ----------

const MbgContext = createContext<MbgContextValue | null>(null);

let runtimeSeq = 0;
function runtimeCtx(): EngineCtx {
  return {
    nowIso: new Date().toISOString(),
    today: BUSINESS_DATE,
    uid: (prefix) => `${prefix}-${Date.now().toString(36)}-${(runtimeSeq += 1)}`,
  };
}

export function MbgProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<MbgState>(() => createEmptyCloudState());
  const [courierItems, setCourierItems] = useState<SafeCourierBastItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [isSupabaseLive, setIsSupabaseLive] = useState<boolean>(isSupabaseConfigured);

  const stateRef = useRef<MbgState>(state);
  const courierItemsRef = useRef<SafeCourierBastItem[]>(courierItems);

  const commit = useCallback((next: MbgState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const commitCourier = useCallback((items: SafeCourierBastItem[]) => {
    courierItemsRef.current = items;
    setCourierItems(items);
  }, []);

  /**
   * Pulls data from Supabase according to the active role:
   * - `FIELD_TEAM` (Lapangan): ONLY queries `v_courier_kitchen_orders` (zero price/margin columns).
   * - `OWNER_ADMIN` / `FINANCE` / `COOPERATIVE_VIEWER`: queries relational tables.
   */
  const pullFromSupabase = useCallback(
    async (roleOverride?: UserRole) => {
      if (!isSupabaseConfigured) {
        setIsLoading(false);
        return;
      }
      const supabase = getSupabaseClient();
      const role = roleOverride ?? stateRef.current.activeRole;

      if (role === 'FIELD_TEAM') {
        const safeRows = await fetchCourierOrdersFromSupabase(supabase);
        if (safeRows) {
          commitCourier(safeRows);
          setIsSupabaseLive(true);
        }
        setIsLoading(false);
        return;
      }

      const remoteData = await fetchMbgDataFromSupabase(supabase);
      if (remoteData) {
        const next: MbgState = {
          ...stateRef.current,
          activeRole: role,
          ...remoteData,
        };
        commit(next);
        commitCourier(buildSafeCourierItems(next));
        setIsSupabaseLive(true);
      }
      setIsLoading(false);
    },
    [commit, commitCourier]
  );

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setIsLoading(false);
      return;
    }
    const supabase = getSupabaseClient();
    void pullFromSupabase();

    const unsubscribe = subscribeToMbgRealtime(
      supabase,
      () => {
        void pullFromSupabase();
      },
      (connected) => {
        if (connected) setIsSupabaseLive(true);
      }
    );

    return () => {
      unsubscribe();
    };
  }, [pullFromSupabase]);

  const commitAndSyncCloud = (next: MbgState) => {
    const prev = stateRef.current;
    commit(next);
    commitCourier(buildSafeCourierItems(next));
    if (isSupabaseConfigured) {
      setIsSyncing(true);
      const supabase = getSupabaseClient();
      void syncMbgDataToSupabase(supabase, prev, next).finally(() => {
        setIsSyncing(false);
      });
    }
  };

  const run = (fn: (current: MbgState) => EngineResult<MbgState>): ActionResult => {
    const res = fn(stateRef.current);
    if (!res.ok) return { ok: false, error: res.error };
    commitAndSyncCloud(res.data);
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
    void pullFromSupabase(role);
  };

  const setActiveTab = (tab: ActiveTab) => commit({ ...stateRef.current, activeTab: tab });

  const createOrder = (input: CreateOrderInput) => run((s) => createKitchenOrder(s, input, runtimeCtx()));

  const removeOrderLine = (id: string) => run((s) => removeOrderLineEngine(s, id, runtimeCtx().nowIso));

  const deleteOrder = (id: string) => run((s) => deleteKitchenOrder(s, id));

  /**
   * Saves courier BAST weights:
   * - Always calls `submit_courier_weighing` SECURITY DEFINER RPC in Supabase so server triggers
   *   automatically recalculate `kitchen_invoices` and `profit_ledger_entries`.
   * - When `activeRole === 'FIELD_TEAM'`, updates `courierItems` and refreshes from `v_courier_kitchen_orders`
   *   without ever touching price tables.
   */
  const saveKitchenBast = (lines: UpdateBastInput[]): ActionResult => {
    if (lines.length === 0) return { ok: false, error: 'Pilih minimal 1 barang untuk disimpan.' };

    if (stateRef.current.activeRole === 'FIELD_TEAM') {
      const currentMap = new Map(courierItemsRef.current.map((c) => [c.delivery_item_id, c]));
      for (const l of lines) {
        const row = currentMap.get(l.delivery_item_id);
        if (!row) return { ok: false, error: 'Barang pengiriman tidak ditemukan.' };
        if (row.is_locked) return { ok: false, error: 'Invoice dapur sudah lunas — timbangan terkunci.' };
        const kg = toWholeKg(l.qty_accepted_kg);
        if (kg < 0) return { ok: false, error: 'Berat diterima tidak boleh negatif.' };
        if (kg > row.qty_dispatched_kg) {
          return {
            ok: false,
            error: `${row.item_name}: berat diterima (${kg} kg) melebihi berat order (${row.qty_dispatched_kg} kg).`,
          };
        }
      }

      // Optimistic update on price-free courier view items
      const patchById = new Map(lines.map((l) => [l.delivery_item_id, l]));
      const updatedCourier = courierItemsRef.current.map((item) => {
        const p = patchById.get(item.delivery_item_id);
        if (!p) return item;
        const acceptedKg = toWholeKg(p.qty_accepted_kg);
        const shrinkKg = Math.max(0, item.qty_dispatched_kg - acceptedKg);
        return {
          ...item,
          qty_accepted_kg: acceptedKg,
          qty_shrinkage_kg: shrinkKg,
          rejection_reason: shrinkKg > 0 ? p.rejection_reason ?? 'Susut' : null,
          is_weighed: true,
        };
      });
      commitCourier(updatedCourier);

      if (isSupabaseConfigured) {
        setIsSyncing(true);
        const supabase = getSupabaseClient();
        void submitCourierWeighingBatchRpc(supabase, lines)
          .then(() => pullFromSupabase('FIELD_TEAM'))
          .finally(() => setIsSyncing(false));
      }
      return { ok: true, count: lines.length };
    }

    const res = applyBastWeights(stateRef.current, lines, runtimeCtx().nowIso);
    if (!res.ok) return { ok: false, error: res.error };
    commit(res.data);
    commitCourier(buildSafeCourierItems(res.data));

    if (isSupabaseConfigured) {
      setIsSyncing(true);
      const supabase = getSupabaseClient();
      void submitCourierWeighingBatchRpc(supabase, lines)
        .then(() => pullFromSupabase())
        .finally(() => setIsSyncing(false));
    }
    return { ok: true, count: res.count };
  };

  const markInvoicePaid = (id: string): ActionResult => {
    const nowIso = runtimeCtx().nowIso;
    const res = markInvoicePaidEngine(stateRef.current, id, nowIso);
    if (!res.ok) return { ok: false, error: res.error };
    commit(res.data);
    commitCourier(buildSafeCourierItems(res.data));

    if (isSupabaseConfigured) {
      setIsSyncing(true);
      const supabase = getSupabaseClient();
      void markInvoicePaidInSupabase(supabase, id, nowIso)
        .then(() => pullFromSupabase())
        .finally(() => setIsSyncing(false));
    }
    return { ok: true };
  };

  const updateProfitSplitPercentage = (team: number, coop: number): ActionResult => {
    const res = updateProfitSplit(stateRef.current, team, coop, runtimeCtx().nowIso);
    if (!res.ok) return { ok: false, error: res.error };
    commit(res.data);

    if (isSupabaseConfigured) {
      setIsSyncing(true);
      const supabase = getSupabaseClient();
      void updateAppSettingsSplitInSupabase(supabase, team, coop)
        .then(() => pullFromSupabase())
        .finally(() => setIsSyncing(false));
    }
    return { ok: true };
  };

  const executePayout = (who: BeneficiaryType, notes?: string) =>
    run((s) => executePayoutEngine(s, who, runtimeCtx(), notes));

  const saveKitchen = (input: KitchenMasterInput): MasterSaveResult => {
    const error = validateKitchenInput(input);
    if (error) return { ok: false, error };
    const s = stateRef.current;
    commitAndSyncCloud({ ...s, kitchens: upsertKitchenRecord(s.kitchens, input, new Date().toISOString()) });
    return { ok: true };
  };

  const saveItem = (input: ItemMasterInput): MasterSaveResult => {
    const error = validateItemInput(input);
    if (error) return { ok: false, error };
    const s = stateRef.current;
    commitAndSyncCloud({ ...s, items: upsertItemRecord(s.items, input, new Date().toISOString()) });
    return { ok: true };
  };

  const deleteKitchen = (kitchenId: string): MasterSaveResult => {
    const s = stateRef.current;
    if (s.deliveries.some((d) => d.kitchen_id === kitchenId)) {
      return { ok: false, error: 'Dapur tidak dapat dihapus karena masih memiliki order aktif/histori.' };
    }
    const nextKitchens = s.kitchens.filter((k) => k.id !== kitchenId);
    commit({ ...s, kitchens: nextKitchens });
    if (isSupabaseConfigured) {
      setIsSyncing(true);
      const supabase = getSupabaseClient();
      void deleteKitchenFromSupabase(supabase, kitchenId)
        .then(() => pullFromSupabase())
        .finally(() => setIsSyncing(false));
    }
    return { ok: true };
  };

  const deleteItem = (itemId: string): MasterSaveResult => {
    const s = stateRef.current;
    if (s.deliveryItems.some((di) => di.item_id === itemId)) {
      return { ok: false, error: 'Barang tidak dapat dihapus karena sedang digunakan pada order dapur.' };
    }
    const nextItems = s.items.filter((i) => i.id !== itemId);
    commit({ ...s, items: nextItems });
    if (isSupabaseConfigured) {
      setIsSyncing(true);
      const supabase = getSupabaseClient();
      void deleteProductFromSupabase(supabase, itemId)
        .then(() => pullFromSupabase())
        .finally(() => setIsSyncing(false));
    }
    return { ok: true };
  };

  const resetSimulationData = () => {
    const fresh = createInitialSeedState();
    commit({ ...fresh, activeRole: stateRef.current.activeRole, activeTab: stateRef.current.activeTab });
    commitCourier(buildSafeCourierItems(fresh));
    if (isSupabaseConfigured) {
      setIsSyncing(true);
      const supabase = getSupabaseClient();
      void resetToSimulationSeedRpc(supabase)
        .then(() => pullFromSupabase())
        .finally(() => setIsSyncing(false));
    }
  };

  const clearAllTransactions = () => {
    const s = stateRef.current;
    const cleared: MbgState = {
      ...s,
      deliveries: [],
      deliveryItems: [],
      invoices: [],
      ledgerEntries: [],
      payoutBatches: [],
    };
    commit(cleared);
    commitCourier([]);
    if (isSupabaseConfigured) {
      setIsSyncing(true);
      const supabase = getSupabaseClient();
      void clearAllTransactionsRpc(supabase)
        .then(() => pullFromSupabase())
        .finally(() => setIsSyncing(false));
    }
  };

  const getSafeCourierItems = (): SafeCourierBastItem[] => {
    if (state.activeRole === 'FIELD_TEAM') {
      return courierItems;
    }
    return buildSafeCourierItems(state);
  };

  const value: MbgContextValue = {
    ...state,
    isLoading,
    isSyncing,
    isSupabaseLive,
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
    deleteKitchen,
    deleteItem,
    resetSimulationData,
    clearAllTransactions,
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
