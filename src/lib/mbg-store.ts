'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type {
  BeneficiaryType,
  Item,
  Kitchen,
  PaymentAccountInfo,
  ProfitSplitConfig,
  UserRole,
} from '../types/mbg';
import { DEFAULT_PAYMENT_INFO, idrToSen, senToIdr } from './financial-engine';
import {
  applyBastWeights,
  createKitchenOrder,
  type CreateOrderInput,
  deleteKitchenOrder,
  type EngineCtx,
  executePayout as executePayoutEngine,
  markInvoicePaid as markInvoicePaidEngine,
  type MbgData,
  type OrderLineInput,
  removeOrderLine as removeOrderLineEngine,
  type UpdateBastInput,
  updateKitchenOrder,
  type UpdateOrderInput,
  type UpdateOrderLineInput,
  updateProfitSplit,
} from './order-engine';
import { getSupabaseClient, isSupabaseConfigured } from './supabase';
import {
  consumeLatestHyperdriveSnapshot,
  deleteKitchenFromSupabase,
  deleteKitchenOrderFromSupabase,
  deleteOrderItemFromSupabase,
  deleteProductFromSupabase,
  executeProfitPayoutRpc,
  fetchMbgDataFromSupabase,
  markInvoicePaidRpc,
  readSwrSnapshot,
  subscribeToMbgRealtime,
  updateAppSettingsRpc,
  updateKitchenOrderRpc,
  upsertKitchenInSupabase,
  upsertKitchenOrderRpc,
  upsertProductInSupabase,
  writeSwrSnapshot,
} from './supabase-sync';
import { getJakartaTodayYmd, parseRpInput } from './ui-format';

export type {
  CreateOrderInput,
  OrderLineInput,
  UpdateBastInput,
  UpdateOrderInput,
  UpdateOrderLineInput,
} from './order-engine';
export type { PaymentAccountInfo } from '../types/mbg';

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
  retrySync: () => Promise<void>;
  setActiveRole: (role: UserRole) => void;
  setActiveTab: (tab: ActiveTab) => void;
  /** "Simpan Order & Kirim ke Daftar Kurir" via `rpc_upsert_kitchen_order`. */
  createOrder: (input: CreateOrderInput) => Promise<ActionResult>;
  /** Edits date, kitchen, items, qty, price, and margin of an existing Order / Invoice via `rpc_update_kitchen_order`. */
  updateOrder: (input: UpdateOrderInput) => Promise<ActionResult>;
  removeOrderLine: (delivery_item_id: string) => Promise<ActionResult>;
  deleteOrder: (delivery_id: string) => Promise<ActionResult>;
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
}

// ---------- Master data (pure helpers) ----------
// Editing master records never touches price snapshots on orders/invoices
// (Invariant 3) — historical rows reference master data by id only.

const clean = (v: string | null | undefined): string => (v ?? '').trim();

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
  const price = parseRpInput(input.default_kitchen_price_per_kg);
  const margin = parseRpInput(input.default_margin_per_kg);
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
    default_kitchen_price_per_kg: senToIdr(idrToSen(parseRpInput(input.default_kitchen_price_per_kg))),
    default_margin_per_kg: senToIdr(idrToSen(parseRpInput(input.default_margin_per_kg))),
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

// ---------- 100% Pure Supabase Cloud React Store (No localStorage business data) ----------

export function createEmptyCloudState(): MbgState {
  const nowIso = '2026-10-16T06:00:00.000Z';
  const splitConfig: ProfitSplitConfig = {
    id: 'split-default-60-40',
    config_name: 'Skema Bagi Hasil Standar Tim 60% : Koperasi 40%',
    team_share_pct: 60.0,
    cooperative_share_pct: 40.0,
    ...DEFAULT_PAYMENT_INFO,
    is_active: true,
    effective_from: BUSINESS_DATE,
    created_at: nowIso,
  };
  return {
    activeRole: 'COOPERATIVE_VIEWER',
    activeTab: 'ledger',
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
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [isSupabaseLive, setIsSupabaseLive] = useState<boolean>(isSupabaseConfigured);
  const [syncError, setSyncError] = useState<string | null>(null);

  const stateRef = useRef<MbgState>(state);
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
    if (next.kitchens.length > 0 || next.deliveries.length > 0) {
      writeSwrSnapshot(next);
    }
  }, []);

  const pullFromSupabase = useCallback(
    async (roleOverride?: UserRole) => {
      if (!isSupabaseConfigured) {
        setIsLoading(false);
        return;
      }
      lastPullAtRef.current = Date.now();
      const supabase = getSupabaseClient();
      const role = roleOverride ?? stateRef.current.activeRole;

      const remoteData = await fetchMbgDataFromSupabase(supabase);
      if (remoteData) {
        commit({
          ...stateRef.current,
          activeRole: role,
          ...remoteData,
        });
        setIsSupabaseLive(true);
      }
      lastPullAtRef.current = Date.now();
      setIsLoading(false);
    },
    [commit]
  );

  const retrySync = useCallback(async () => {
    setSyncError(null);
    await pullFromSupabase();
  }, [pullFromSupabase]);

  /**
   * Reconciles local state with the authoritative server snapshot returned inside a single-hop
   * `POST /api/hyperdrive` response, falling back to `pullFromSupabase()` only when needed.
   */
  const reconcileAfterMutation = useCallback(async () => {
    const inlineSnapshot = consumeLatestHyperdriveSnapshot();
    if (inlineSnapshot) {
      lastPullAtRef.current = Date.now();
      commit({
        ...stateRef.current,
        ...inlineSnapshot,
      });
      setIsSupabaseLive(true);
      return;
    }
    await pullFromSupabase();
  }, [commit, pullFromSupabase]);

  const handleCloudError = useCallback(
    (message: string, rollbackState?: MbgState, roleOverride?: UserRole) => {
      if (rollbackState) {
        commit(rollbackState);
      }
      setSyncError(message);
      void pullFromSupabase(roleOverride);
    },
    [commit, pullFromSupabase]
  );

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setIsLoading(false);
      return;
    }
    // Instant SWR hydration (< 15 ms perceived cold load) while revalidating from Hyperdrive in background
    const swrCached = readSwrSnapshot();
    if (swrCached) {
      stateRef.current = { ...stateRef.current, ...swrCached };
      setState(stateRef.current);
      setIsLoading(false);
    }

    const supabase = getSupabaseClient();
    void pullFromSupabase();

    const onVisibilityOrFocus = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (isSyncingRef.current || Date.now() - lastPullAtRef.current < 15_000) return;
      void pullFromSupabase();
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onVisibilityOrFocus);
      document.addEventListener('visibilitychange', onVisibilityOrFocus);
    }

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
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onVisibilityOrFocus);
        document.removeEventListener('visibilitychange', onVisibilityOrFocus);
      }
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

  const runOptimisticMutation = async <T extends { ok: true } = { ok: true }>(opts: {
    optimisticState: MbgState;
    localSuccess?: T;
    skipCloud?: boolean;
    errorPrefix?: string;
    fallbackError: string;
    cloudOp: (supabase: ReturnType<typeof getSupabaseClient>) => Promise<T | { ok: false; error: string }>;
  }): Promise<T | { ok: false; error: string }> => {
    if (isSyncingRef.current) {
      return { ok: false, error: 'Sedang menyimpan perubahan sebelumnya, mohon tunggu sebentar.' };
    }
    const prevState = stateRef.current;
    commit(opts.optimisticState);
    if (!isSupabaseConfigured || opts.skipCloud) {
      return opts.localSuccess ?? ({ ok: true } as T);
    }

    setSyncing(true);
    setSyncError(null);
    const formatError = (err: string) => (opts.errorPrefix ? `${opts.errorPrefix}: ${err}` : err);
    try {
      const res = await opts.cloudOp(getSupabaseClient());
      if (!res.ok) {
        handleCloudError(formatError(res.error), prevState);
        return { ok: false, error: res.error };
      }
      await reconcileAfterMutation();
      return res;
    } catch (e) {
      const msg = e instanceof Error ? e.message : opts.fallbackError;
      handleCloudError(formatError(msg), prevState);
      return { ok: false, error: msg };
    } finally {
      setSyncing(false);
    }
  };

  /**
   * RPC #1: Creates or merges a kitchen order in PostgreSQL via `rpc_upsert_kitchen_order`,
   * which invokes `fn_recalculate_order_financials` on the server and returns authoritative totals.
   */
  const createOrder = async (input: CreateOrderInput): Promise<ActionResult> => {
    const precheck = createKitchenOrder(stateRef.current, input, runtimeCtx());
    if (!precheck.ok) return { ok: false, error: precheck.error };
    const orderDate = clean(input.order_date) || getJakartaTodayYmd();
    return runOptimisticMutation<{ ok: true; merged?: boolean; count?: number }>({
      optimisticState: precheck.data,
      localSuccess: { ok: true, merged: precheck.merged, count: precheck.count },
      errorPrefix: 'Gagal menyimpan order',
      fallbackError: 'Gagal menyimpan order ke Supabase.',
      cloudOp: async (supabase) => {
        const res = await upsertKitchenOrderRpc(supabase, input, orderDate);
        return res.ok ? { ok: true, merged: res.merged, count: res.count } : res;
      },
    });
  };

  /**
   * RPC #1b: Updates an existing kitchen order & invoice (date, kitchen, items, qty, price, margin)
   * via `rpc_update_kitchen_order`.
   */
  const updateOrder = async (input: UpdateOrderInput): Promise<ActionResult> => {
    const precheck = updateKitchenOrder(stateRef.current, input, runtimeCtx());
    if (!precheck.ok) return { ok: false, error: precheck.error };
    return runOptimisticMutation<{ ok: true; count?: number }>({
      optimisticState: precheck.data,
      localSuccess: { ok: true, count: precheck.count },
      errorPrefix: 'Gagal memperbarui order/invoice',
      fallbackError: 'Gagal memperbarui order/invoice di Supabase.',
      cloudOp: async (supabase) => {
        const res = await updateKitchenOrderRpc(supabase, input);
        return res.ok ? { ok: true, count: res.count } : res;
      },
    });
  };

  const removeOrderLine = async (id: string): Promise<ActionResult> => {
    const prevState = stateRef.current;
    const targetItem = prevState.deliveryItems.find((d) => d.id === id);
    const precheck = removeOrderLineEngine(prevState, id, runtimeCtx().nowIso);
    if (!precheck.ok) return { ok: false, error: precheck.error };
    const isLastItem =
      targetItem !== undefined &&
      prevState.deliveryItems.filter((d) => d.delivery_id === targetItem.delivery_id).length <= 1;
    return runOptimisticMutation({
      optimisticState: precheck.data,
      skipCloud: !targetItem,
      errorPrefix: 'Gagal menghapus barang order',
      fallbackError: 'Gagal menghapus barang order di Supabase.',
      cloudOp: (supabase) =>
        isLastItem
          ? deleteKitchenOrderFromSupabase(supabase, targetItem.delivery_id)
          : deleteOrderItemFromSupabase(supabase, id),
    });
  };

  const deleteOrder = async (id: string): Promise<ActionResult> => {
    const precheck = deleteKitchenOrder(stateRef.current, id);
    if (!precheck.ok) return { ok: false, error: precheck.error };
    return runOptimisticMutation({
      optimisticState: precheck.data,
      errorPrefix: 'Gagal menghapus order',
      fallbackError: 'Gagal menghapus order di Supabase.',
      cloudOp: (supabase) => deleteKitchenOrderFromSupabase(supabase, id),
    });
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
    return runOptimisticMutation({
      optimisticState: precheck.data,
      errorPrefix: 'Gagal menandai invoice lunas',
      fallbackError: 'Gagal menandai invoice lunas di Supabase.',
      cloudOp: (supabase) => markInvoicePaidRpc(supabase, id),
    });
  };

  /**
   * RPC #5: Updates profit split percentages via `rpc_update_app_settings` and recalculates
   * all unpaid-out orders in PostgreSQL.
   */
  const updateProfitSplitPercentage = async (team: number, coop: number): Promise<ActionResult> => {
    const precheck = updateProfitSplit(stateRef.current, team, coop, runtimeCtx().nowIso);
    if (!precheck.ok) return { ok: false, error: precheck.error };
    return runOptimisticMutation({
      optimisticState: precheck.data,
      errorPrefix: 'Gagal memperbarui persentase bagi hasil',
      fallbackError: 'Gagal memperbarui persentase bagi hasil di Supabase.',
      cloudOp: (supabase) => updateAppSettingsRpc(supabase, { teamSharePct: team, coopSharePct: coop }),
    });
  };

  /**
   * RPC #4: Executes profit payout via `rpc_execute_profit_payout`.
   */
  const executePayout = async (who: BeneficiaryType | 'BOTH', notes?: string): Promise<ActionResult> => {
    const precheck = executePayoutEngine(stateRef.current, who, runtimeCtx(), notes);
    if (!precheck.ok) return { ok: false, error: precheck.error };
    return runOptimisticMutation<{ ok: true; count?: number }>({
      optimisticState: precheck.data,
      localSuccess: { ok: true, count: precheck.count },
      errorPrefix: 'Gagal mencairkan bagi hasil',
      fallbackError: 'Gagal mencairkan bagi hasil di Supabase.',
      cloudOp: async (supabase) => {
        const res = await executeProfitPayoutRpc(supabase, who, null);
        return res.ok ? { ok: true, count: res.count } : res;
      },
    });
  };

  const saveKitchen = async (input: KitchenMasterInput): Promise<MasterSaveResult> => {
    const error = validateKitchenInput(input);
    if (error) return { ok: false, error };
    const prevState = stateRef.current;
    const nextKitchens = upsertKitchenRecord(prevState.kitchens, input, new Date().toISOString());
    const saved = input.id ? nextKitchens.find((k) => k.id === input.id) : nextKitchens[nextKitchens.length - 1];
    return runOptimisticMutation({
      optimisticState: { ...prevState, kitchens: nextKitchens },
      skipCloud: !saved,
      fallbackError: 'Gagal menyimpan dapur ke Supabase.',
      cloudOp: (supabase) => upsertKitchenInSupabase(supabase, saved!),
    });
  };

  const saveItem = async (input: ItemMasterInput): Promise<MasterSaveResult> => {
    const error = validateItemInput(input);
    if (error) return { ok: false, error };
    const prevState = stateRef.current;
    const nextItems = upsertItemRecord(prevState.items, input, new Date().toISOString());
    const saved = input.id ? nextItems.find((i) => i.id === input.id) : nextItems[nextItems.length - 1];
    return runOptimisticMutation({
      optimisticState: { ...prevState, items: nextItems },
      skipCloud: !saved,
      fallbackError: 'Gagal menyimpan barang ke Supabase.',
      cloudOp: (supabase) => upsertProductInSupabase(supabase, saved!),
    });
  };

  const savePaymentAccount = async (input: PaymentAccountInfo): Promise<MasterSaveResult> => {
    const supplierName = clean(input.supplier_name);
    const bankName = clean(input.payment_bank_name);
    const accountNumber = clean(input.payment_account_number);
    const accountHolder = clean(input.payment_account_holder);
    if (!supplierName) return { ok: false, error: 'Nama Supplier / Perusahaan wajib diisi.' };
    if (!bankName) return { ok: false, error: 'Nama Bank wajib diisi.' };
    if (!accountNumber) return { ok: false, error: 'Nomor Rekening wajib diisi.' };
    if (!accountHolder) return { ok: false, error: 'Atas Nama wajib diisi.' };

    const prevState = stateRef.current;
    const nextSplitConfig: ProfitSplitConfig = {
      ...prevState.splitConfig,
      supplier_name: supplierName,
      payment_bank_name: bankName,
      payment_account_number: accountNumber,
      payment_account_holder: accountHolder,
    };
    const nextInvoices = prevState.invoices.map((inv) =>
      inv.payment_status === 'PAID'
        ? inv
        : {
            ...inv,
            supplier_name: supplierName,
            payment_bank_name: bankName,
            payment_account_number: accountNumber,
            payment_account_holder: accountHolder,
          }
    );
    return runOptimisticMutation({
      optimisticState: { ...prevState, splitConfig: nextSplitConfig, invoices: nextInvoices },
      errorPrefix: 'Gagal menyimpan rekening pembayaran',
      fallbackError: 'Gagal menyimpan rekening pembayaran ke Supabase.',
      cloudOp: (supabase) =>
        updateAppSettingsRpc(supabase, {
          teamSharePct: prevState.splitConfig.team_share_pct,
          coopSharePct: prevState.splitConfig.cooperative_share_pct,
          supplierName,
          bankName,
          accountNumber,
          accountHolder,
        }),
    });
  };

  const deleteKitchen = async (kitchenId: string): Promise<MasterSaveResult> => {
    const prevState = stateRef.current;
    if (prevState.deliveries.some((d) => d.kitchen_id === kitchenId)) {
      return { ok: false, error: 'Dapur tidak dapat dihapus karena masih memiliki order aktif/histori.' };
    }
    return runOptimisticMutation({
      optimisticState: { ...prevState, kitchens: prevState.kitchens.filter((k) => k.id !== kitchenId) },
      fallbackError: 'Gagal menghapus dapur di Supabase.',
      cloudOp: (supabase) => deleteKitchenFromSupabase(supabase, kitchenId),
    });
  };

  const deleteItem = async (itemId: string): Promise<MasterSaveResult> => {
    const prevState = stateRef.current;
    if (prevState.deliveryItems.some((di) => di.item_id === itemId)) {
      return { ok: false, error: 'Barang tidak dapat dihapus karena sedang digunakan pada order dapur.' };
    }
    return runOptimisticMutation({
      optimisticState: { ...prevState, items: prevState.items.filter((i) => i.id !== itemId) },
      fallbackError: 'Gagal menghapus barang di Supabase.',
      cloudOp: (supabase) => deleteProductFromSupabase(supabase, itemId),
    });
  };

  const value: MbgContextValue = {
    ...state,
    isLoading,
    isSyncing,
    isSupabaseLive,
    syncError,
    clearSyncError,
    retrySync,
    setActiveRole,
    setActiveTab,
    createOrder,
    updateOrder,
    removeOrderLine,
    deleteOrder,
    markInvoicePaid,
    updateProfitSplitPercentage,
    executePayout,
    saveKitchen,
    saveItem,
    savePaymentAccount,
    deleteKitchen,
    deleteItem,
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
