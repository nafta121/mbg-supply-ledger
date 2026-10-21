'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type {
  BeneficiaryType,
  Item,
  Kitchen,
  PaymentAccountInfo,
  ProfitSplitConfig,
  SafeCourierBastItem,
  UserRole,
} from '../types/mbg';
import { idrToSen, roundKg, senToIdr } from './financial-engine';
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
  deleteKitchenFromSupabase,
  deleteKitchenOrderFromSupabase,
  deleteOrderItemFromSupabase,
  deleteProductFromSupabase,
  executeProfitPayoutRpc,
  fetchCourierOrdersFromSupabase,
  fetchMbgDataFromSupabase,
  markInvoicePaidRpc,
  submitCourierWeighingBatchRpc,
  subscribeToMbgRealtime,
  updateAppSettingsRpc,
  upsertKitchenInSupabase,
  upsertKitchenOrderRpc,
  upsertProductInSupabase,
} from './supabase-sync';
import { formatIdr, formatKg, getJakartaTodayYmd, subtractKg } from './ui-format';

export { buildSafeCourierItems } from './order-engine';
export type { CreateOrderInput, OrderLineInput, UpdateBastInput } from './order-engine';
export type { PaymentAccountInfo } from '../types/mbg';
export { formatIdr, formatKg } from './ui-format';

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
  /** Non-null when the latest cloud operation failed and state was rolled back from Supabase. */
  syncError: string | null;
  clearSyncError: () => void;
  setActiveRole: (role: UserRole) => void;
  setActiveTab: (tab: ActiveTab) => void;
  /** "Simpan Order & Kirim ke Daftar Kurir" via `rpc_upsert_kitchen_order`. */
  createOrder: (input: CreateOrderInput) => Promise<ActionResult>;
  removeOrderLine: (delivery_item_id: string) => Promise<ActionResult>;
  deleteOrder: (delivery_id: string) => Promise<ActionResult>;
  /** Saves BAST weights for several items of one kitchen order at once via `rpc_submit_courier_weighing_batch`. */
  saveKitchenBast: (lines: UpdateBastInput[]) => Promise<ActionResult>;
  /** Marks invoice paid via `rpc_mark_invoice_paid`. */
  markInvoicePaid: (invoice_id: string) => Promise<ActionResult>;
  /** Updates profit split & recalculates unpaid-out orders via `rpc_update_app_settings`. */
  updateProfitSplitPercentage: (team_share_pct: number, cooperative_share_pct: number) => Promise<ActionResult>;
  /** Executes profit payout via `rpc_execute_profit_payout`. */
  executePayout: (beneficiary_type: BeneficiaryType | 'BOTH', notes?: string) => Promise<ActionResult>;
  saveKitchen: (input: KitchenMasterInput) => Promise<MasterSaveResult>;
  saveItem: (input: ItemMasterInput) => Promise<MasterSaveResult>;
  savePaymentAccount: (input: PaymentAccountInfo) => Promise<MasterSaveResult>;
  deleteKitchen: (kitchen_id: string) => Promise<MasterSaveResult>;
  deleteItem: (item_id: string) => Promise<MasterSaveResult>;
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
  { name: 'SPPG Dapur 19 - Jagakarsa', pic: 'Qori Rahman', area: 'Jl. Moh. Kahfi II II No. 9, Jakarta Selatan'.replace('II II', 'II') },
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
    admin_pin: '1122',
    coop_pin: '3344',
    payment_bank_name: 'BRI',
    payment_account_number: '0000-0000-0000-000',
    payment_account_holder: 'Bendahara Supplier MBG',
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
    admin_pin: '1122',
    coop_pin: '3344',
    payment_bank_name: 'BRI',
    payment_account_number: '0000-0000-0000-000',
    payment_account_holder: 'Bendahara Supplier MBG',
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
    today: getJakartaTodayYmd(),
    uid: (prefix) => `${prefix}-${Date.now().toString(36)}-${(runtimeSeq += 1)}`,
  };
}

export function MbgProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<MbgState>(() => createEmptyCloudState());
  const [courierItems, setCourierItems] = useState<SafeCourierBastItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [isSupabaseLive, setIsSupabaseLive] = useState<boolean>(isSupabaseConfigured);
  const [syncError, setSyncError] = useState<string | null>(null);

  const stateRef = useRef<MbgState>(state);
  const courierItemsRef = useRef<SafeCourierBastItem[]>(courierItems);
  const isSyncingRef = useRef<boolean>(false);
  const lastPullAtRef = useRef<number>(0);

  const setSyncing = useCallback((v: boolean) => {
    isSyncingRef.current = v;
    setIsSyncing(v);
  }, []);

  const clearSyncError = useCallback(() => {
    setSyncError(null);
  }, []);

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
      lastPullAtRef.current = Date.now();
      const supabase = getSupabaseClient();
      const role = roleOverride ?? stateRef.current.activeRole;

      if (role === 'FIELD_TEAM') {
        const safeRows = await fetchCourierOrdersFromSupabase(supabase);
        if (safeRows) {
          commitCourier(safeRows);
          setIsSupabaseLive(true);
        }
        lastPullAtRef.current = Date.now();
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
      lastPullAtRef.current = Date.now();
      setIsLoading(false);
    },
    [commit, commitCourier]
  );

  const handleCloudError = useCallback(
    (message: string, roleOverride?: UserRole) => {
      setSyncError(message);
      void pullFromSupabase(roleOverride);
    },
    [pullFromSupabase]
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
        // Skip echo events triggered by our own in-flight or just-completed mutations.
        if (isSyncingRef.current || Date.now() - lastPullAtRef.current < 500) return;
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

  /**
   * RPC #1: Creates or merges a kitchen order in PostgreSQL via `rpc_upsert_kitchen_order`,
   * which invokes `fn_recalculate_order_financials` on the server and returns authoritative totals.
   */
  const createOrder = async (input: CreateOrderInput): Promise<ActionResult> => {
    const precheck = createKitchenOrder(stateRef.current, input, runtimeCtx());
    if (!precheck.ok) return { ok: false, error: precheck.error };

    if (!isSupabaseConfigured) {
      commit(precheck.data);
      commitCourier(buildSafeCourierItems(precheck.data));
      return { ok: true, merged: precheck.merged, count: precheck.count };
    }

    setSyncing(true);
    setSyncError(null);
    try {
      const supabase = getSupabaseClient();
      const rpcRes = await upsertKitchenOrderRpc(supabase, input, getJakartaTodayYmd());
      if (!rpcRes.ok) {
        handleCloudError(`Gagal menyimpan order: ${rpcRes.error}`);
        return { ok: false, error: rpcRes.error };
      }
      await pullFromSupabase();
      return { ok: true, merged: rpcRes.merged, count: rpcRes.count };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal menyimpan order ke Supabase.';
      handleCloudError(`Gagal menyimpan order: ${msg}`);
      return { ok: false, error: msg };
    } finally {
      setSyncing(false);
    }
  };

  const removeOrderLine = async (id: string): Promise<ActionResult> => {
    const targetItem = stateRef.current.deliveryItems.find((d) => d.id === id);
    const precheck = removeOrderLineEngine(stateRef.current, id, runtimeCtx().nowIso);
    if (!precheck.ok) return { ok: false, error: precheck.error };

    if (!isSupabaseConfigured || !targetItem) {
      commit(precheck.data);
      commitCourier(buildSafeCourierItems(precheck.data));
      return { ok: true };
    }

    setSyncing(true);
    setSyncError(null);
    try {
      const supabase = getSupabaseClient();
      const isLastItem =
        stateRef.current.deliveryItems.filter((d) => d.delivery_id === targetItem.delivery_id).length <= 1;
      const delRes = isLastItem
        ? await deleteKitchenOrderFromSupabase(supabase, targetItem.delivery_id)
        : await deleteOrderItemFromSupabase(supabase, id);
      if (!delRes.ok) {
        handleCloudError(`Gagal menghapus barang order: ${delRes.error}`);
        return { ok: false, error: delRes.error };
      }
      await pullFromSupabase();
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal menghapus barang order di Supabase.';
      handleCloudError(`Gagal menghapus barang order: ${msg}`);
      return { ok: false, error: msg };
    } finally {
      setSyncing(false);
    }
  };

  const deleteOrder = async (id: string): Promise<ActionResult> => {
    const precheck = deleteKitchenOrder(stateRef.current, id);
    if (!precheck.ok) return { ok: false, error: precheck.error };

    if (!isSupabaseConfigured) {
      commit(precheck.data);
      commitCourier(buildSafeCourierItems(precheck.data));
      return { ok: true };
    }

    setSyncing(true);
    setSyncError(null);
    try {
      const supabase = getSupabaseClient();
      const delRes = await deleteKitchenOrderFromSupabase(supabase, id);
      if (!delRes.ok) {
        handleCloudError(`Gagal menghapus order: ${delRes.error}`);
        return { ok: false, error: delRes.error };
      }
      await pullFromSupabase();
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal menghapus order di Supabase.';
      handleCloudError(`Gagal menghapus order: ${msg}`);
      return { ok: false, error: msg };
    } finally {
      setSyncing(false);
    }
  };

  /**
   * RPC #2: Saves courier BAST weights via `rpc_submit_courier_weighing_batch` SECURITY DEFINER RPC
   * so PostgreSQL triggers & `fn_recalculate_order_financials` compute `kitchen_invoices` and `profit_ledger_entries`.
   */
  const saveKitchenBast = async (lines: UpdateBastInput[]): Promise<ActionResult> => {
    if (lines.length === 0) return { ok: false, error: 'Pilih minimal 1 barang untuk disimpan.' };

    const role = stateRef.current.activeRole;

    if (role === 'FIELD_TEAM') {
      const currentMap = new Map(courierItemsRef.current.map((c) => [c.delivery_item_id, c]));
      for (const l of lines) {
        const row = currentMap.get(l.delivery_item_id);
        if (!row) return { ok: false, error: 'Barang pengiriman tidak ditemukan.' };
        if (row.is_locked) return { ok: false, error: 'Invoice dapur sudah lunas — timbangan terkunci.' };
        const kg = roundKg(l.qty_accepted_kg);
        if (kg < 0) return { ok: false, error: 'Berat diterima tidak boleh negatif.' };
        if (kg > roundKg(row.qty_dispatched_kg)) {
          return {
            ok: false,
            error: `${row.item_name}: berat diterima (${formatKg(kg)}) melebihi berat order (${formatKg(row.qty_dispatched_kg)}).`,
          };
        }
      }

      if (!isSupabaseConfigured) {
        const patchById = new Map(lines.map((l) => [l.delivery_item_id, l]));
        const updatedCourier = courierItemsRef.current.map((item) => {
          const p = patchById.get(item.delivery_item_id);
          if (!p) return item;
          const acceptedKg = roundKg(p.qty_accepted_kg);
          const shrinkKg = subtractKg(item.qty_dispatched_kg, acceptedKg);
          return {
            ...item,
            qty_accepted_kg: acceptedKg,
            qty_shrinkage_kg: shrinkKg,
            rejection_reason: shrinkKg > 0 ? p.rejection_reason ?? 'Susut' : null,
            is_weighed: true,
          };
        });
        commitCourier(updatedCourier);
        return { ok: true, count: lines.length };
      }

      setSyncing(true);
      setSyncError(null);
      try {
        const supabase = getSupabaseClient();
        const rpcRes = await submitCourierWeighingBatchRpc(supabase, lines);
        if (!rpcRes.ok) {
          handleCloudError(`Gagal menyimpan timbangan: ${rpcRes.error}`, 'FIELD_TEAM');
          return { ok: false, error: rpcRes.error };
        }
        await pullFromSupabase('FIELD_TEAM');
        return { ok: true, count: rpcRes.count };
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Gagal menyimpan timbangan ke Supabase.';
        handleCloudError(`Gagal menyimpan timbangan: ${msg}`, 'FIELD_TEAM');
        return { ok: false, error: msg };
      } finally {
        setSyncing(false);
      }
    }

    const precheck = applyBastWeights(stateRef.current, lines, runtimeCtx().nowIso);
    if (!precheck.ok) return { ok: false, error: precheck.error };

    if (!isSupabaseConfigured) {
      commit(precheck.data);
      commitCourier(buildSafeCourierItems(precheck.data));
      return { ok: true, count: precheck.count };
    }

    setSyncing(true);
    setSyncError(null);
    try {
      const supabase = getSupabaseClient();
      const rpcRes = await submitCourierWeighingBatchRpc(supabase, lines);
      if (!rpcRes.ok) {
        handleCloudError(`Gagal menyimpan timbangan: ${rpcRes.error}`);
        return { ok: false, error: rpcRes.error };
      }
      await pullFromSupabase();
      return { ok: true, count: rpcRes.count };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal menyimpan timbangan ke Supabase.';
      handleCloudError(`Gagal menyimpan timbangan: ${msg}`);
      return { ok: false, error: msg };
    } finally {
      setSyncing(false);
    }
  };

  /**
   * RPC #3: Marks invoice PAID via `rpc_mark_invoice_paid` and unlocks `profit_ledger_entries`.
   */
  const markInvoicePaid = async (id: string): Promise<ActionResult> => {
    const nowIso = runtimeCtx().nowIso;
    let baseState = stateRef.current;
    const inv = baseState.invoices.find((i) => i.id === id);
    if (inv) {
      const unweighed = baseState.deliveryItems
        .filter((di) => di.delivery_id === inv.delivery_id && di.weighed_at === null)
        .map((di) => ({ delivery_item_id: di.id, qty_accepted_kg: di.qty_dispatched_kg }));
      if (unweighed.length > 0) {
        const autoWeighed = applyBastWeights(baseState, unweighed, nowIso);
        if (autoWeighed.ok) baseState = autoWeighed.data;
      }
    }
    const precheck = markInvoicePaidEngine(baseState, id, nowIso);
    if (!precheck.ok) return { ok: false, error: precheck.error };

    if (!isSupabaseConfigured) {
      commit(precheck.data);
      commitCourier(buildSafeCourierItems(precheck.data));
      return { ok: true };
    }

    setSyncing(true);
    setSyncError(null);
    try {
      const supabase = getSupabaseClient();
      const rpcRes = await markInvoicePaidRpc(supabase, id);
      if (!rpcRes.ok) {
        handleCloudError(`Gagal menandai invoice lunas: ${rpcRes.error}`);
        return { ok: false, error: rpcRes.error };
      }
      await pullFromSupabase();
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal menandai invoice lunas di Supabase.';
      handleCloudError(`Gagal menandai invoice lunas: ${msg}`);
      return { ok: false, error: msg };
    } finally {
      setSyncing(false);
    }
  };

  /**
   * RPC #5: Updates profit split percentages via `rpc_update_app_settings` and recalculates
   * all unpaid-out orders in PostgreSQL.
   */
  const updateProfitSplitPercentage = async (team: number, coop: number): Promise<ActionResult> => {
    const precheck = updateProfitSplit(stateRef.current, team, coop, runtimeCtx().nowIso);
    if (!precheck.ok) return { ok: false, error: precheck.error };

    if (!isSupabaseConfigured) {
      commit(precheck.data);
      return { ok: true };
    }

    setSyncing(true);
    setSyncError(null);
    try {
      const supabase = getSupabaseClient();
      const rpcRes = await updateAppSettingsRpc(supabase, {
        teamSharePct: team,
        coopSharePct: coop,
      });
      if (!rpcRes.ok) {
        handleCloudError(`Gagal memperbarui persentase bagi hasil: ${rpcRes.error}`);
        return { ok: false, error: rpcRes.error };
      }
      await pullFromSupabase();
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal memperbarui persentase bagi hasil di Supabase.';
      handleCloudError(`Gagal memperbarui persentase bagi hasil: ${msg}`);
      return { ok: false, error: msg };
    } finally {
      setSyncing(false);
    }
  };

  /**
   * RPC #4: Executes profit payout via `rpc_execute_profit_payout`.
   */
  const executePayout = async (who: BeneficiaryType | 'BOTH', notes?: string): Promise<ActionResult> => {
    const precheck = executePayoutEngine(stateRef.current, who, runtimeCtx(), notes);
    if (!precheck.ok) return { ok: false, error: precheck.error };

    if (!isSupabaseConfigured) {
      commit(precheck.data);
      return { ok: true, count: precheck.count };
    }

    setSyncing(true);
    setSyncError(null);
    try {
      const supabase = getSupabaseClient();
      const rpcRes = await executeProfitPayoutRpc(supabase, who, null);
      if (!rpcRes.ok) {
        handleCloudError(`Gagal mencairkan bagi hasil: ${rpcRes.error}`);
        return { ok: false, error: rpcRes.error };
      }
      await pullFromSupabase();
      return { ok: true, count: rpcRes.count };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal mencairkan bagi hasil di Supabase.';
      handleCloudError(`Gagal mencairkan bagi hasil: ${msg}`);
      return { ok: false, error: msg };
    } finally {
      setSyncing(false);
    }
  };

  const saveKitchen = async (input: KitchenMasterInput): Promise<MasterSaveResult> => {
    const error = validateKitchenInput(input);
    if (error) return { ok: false, error };
    const s = stateRef.current;
    const nextKitchens = upsertKitchenRecord(s.kitchens, input, new Date().toISOString());
    const saved = input.id ? nextKitchens.find((k) => k.id === input.id) : nextKitchens[nextKitchens.length - 1];

    if (!isSupabaseConfigured || !saved) {
      commit({ ...s, kitchens: nextKitchens });
      return { ok: true };
    }

    setSyncing(true);
    setSyncError(null);
    try {
      const supabase = getSupabaseClient();
      const res = await upsertKitchenInSupabase(supabase, saved);
      if (!res.ok) {
        handleCloudError(res.error);
        return { ok: false, error: res.error };
      }
      await pullFromSupabase();
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal menyimpan dapur ke Supabase.';
      handleCloudError(msg);
      return { ok: false, error: msg };
    } finally {
      setSyncing(false);
    }
  };

  const saveItem = async (input: ItemMasterInput): Promise<MasterSaveResult> => {
    const error = validateItemInput(input);
    if (error) return { ok: false, error };
    const s = stateRef.current;
    const nextItems = upsertItemRecord(s.items, input, new Date().toISOString());
    const saved = input.id ? nextItems.find((i) => i.id === input.id) : nextItems[nextItems.length - 1];

    if (!isSupabaseConfigured || !saved) {
      commit({ ...s, items: nextItems });
      return { ok: true };
    }

    setSyncing(true);
    setSyncError(null);
    try {
      const supabase = getSupabaseClient();
      const res = await upsertProductInSupabase(supabase, saved);
      if (!res.ok) {
        handleCloudError(res.error);
        return { ok: false, error: res.error };
      }
      await pullFromSupabase();
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal menyimpan barang ke Supabase.';
      handleCloudError(msg);
      return { ok: false, error: msg };
    } finally {
      setSyncing(false);
    }
  };

  const savePaymentAccount = async (input: PaymentAccountInfo): Promise<MasterSaveResult> => {
    const bankName = clean(input.payment_bank_name);
    const accountNumber = clean(input.payment_account_number);
    const accountHolder = clean(input.payment_account_holder);
    if (!bankName) return { ok: false, error: 'Nama Bank wajib diisi.' };
    if (!accountNumber) return { ok: false, error: 'Nomor Rekening wajib diisi.' };
    if (!accountHolder) return { ok: false, error: 'Atas Nama wajib diisi.' };

    const s = stateRef.current;
    if (!isSupabaseConfigured) {
      const nextSplitConfig: ProfitSplitConfig = {
        ...s.splitConfig,
        payment_bank_name: bankName,
        payment_account_number: accountNumber,
        payment_account_holder: accountHolder,
      };
      const nextInvoices = s.invoices.map((inv) =>
        inv.payment_status === 'PAID'
          ? inv
          : {
              ...inv,
              payment_bank_name: bankName,
              payment_account_number: accountNumber,
              payment_account_holder: accountHolder,
            }
      );
      commit({ ...s, splitConfig: nextSplitConfig, invoices: nextInvoices });
      return { ok: true };
    }

    setSyncing(true);
    setSyncError(null);
    try {
      const supabase = getSupabaseClient();
      const rpcRes = await updateAppSettingsRpc(supabase, {
        teamSharePct: s.splitConfig.team_share_pct,
        coopSharePct: s.splitConfig.cooperative_share_pct,
        bankName,
        accountNumber,
        accountHolder,
      });
      if (!rpcRes.ok) {
        handleCloudError(`Gagal menyimpan rekening pembayaran: ${rpcRes.error}`);
        return { ok: false, error: rpcRes.error };
      }
      await pullFromSupabase();
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal menyimpan rekening pembayaran ke Supabase.';
      handleCloudError(`Gagal menyimpan rekening pembayaran: ${msg}`);
      return { ok: false, error: msg };
    } finally {
      setSyncing(false);
    }
  };

  const deleteKitchen = async (kitchenId: string): Promise<MasterSaveResult> => {
    const s = stateRef.current;
    if (s.deliveries.some((d) => d.kitchen_id === kitchenId)) {
      return { ok: false, error: 'Dapur tidak dapat dihapus karena masih memiliki order aktif/histori.' };
    }
    if (!isSupabaseConfigured) {
      commit({ ...s, kitchens: s.kitchens.filter((k) => k.id !== kitchenId) });
      return { ok: true };
    }

    setSyncing(true);
    setSyncError(null);
    try {
      const supabase = getSupabaseClient();
      const res = await deleteKitchenFromSupabase(supabase, kitchenId);
      if (!res.ok) {
        handleCloudError(res.error);
        return { ok: false, error: res.error };
      }
      await pullFromSupabase();
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal menghapus dapur di Supabase.';
      handleCloudError(msg);
      return { ok: false, error: msg };
    } finally {
      setSyncing(false);
    }
  };

  const deleteItem = async (itemId: string): Promise<MasterSaveResult> => {
    const s = stateRef.current;
    if (s.deliveryItems.some((di) => di.item_id === itemId)) {
      return { ok: false, error: 'Barang tidak dapat dihapus karena sedang digunakan pada order dapur.' };
    }
    if (!isSupabaseConfigured) {
      commit({ ...s, items: s.items.filter((i) => i.id !== itemId) });
      return { ok: true };
    }

    setSyncing(true);
    setSyncError(null);
    try {
      const supabase = getSupabaseClient();
      const res = await deleteProductFromSupabase(supabase, itemId);
      if (!res.ok) {
        handleCloudError(res.error);
        return { ok: false, error: res.error };
      }
      await pullFromSupabase();
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal menghapus barang di Supabase.';
      handleCloudError(msg);
      return { ok: false, error: msg };
    } finally {
      setSyncing(false);
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
    syncError,
    clearSyncError,
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
    savePaymentAccount,
    deleteKitchen,
    deleteItem,
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
