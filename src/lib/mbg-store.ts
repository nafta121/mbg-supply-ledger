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
import { idrToSen, senToIdr } from './financial-engine';
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
  updateProfitSplit,
} from './order-engine';
import { getSupabaseClient, isSupabaseConfigured } from './supabase';
import {
  deleteKitchenFromSupabase,
  deleteKitchenOrderFromSupabase,
  deleteOrderItemFromSupabase,
  deleteProductFromSupabase,
  executeProfitPayoutRpc,
  fetchMbgDataFromSupabase,
  markInvoicePaidRpc,
  subscribeToMbgRealtime,
  updateAppSettingsRpc,
  upsertKitchenInSupabase,
  upsertKitchenOrderRpc,
  upsertProductInSupabase,
} from './supabase-sync';
import { formatIdr, formatKg, getJakartaTodayYmd } from './ui-format';

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

// ---------- 100% Pure Supabase Cloud React Store (No localStorage business data) ----------

export function createEmptyCloudState(): MbgState {
  const nowIso = '2026-10-16T06:00:00.000Z';
  const splitConfig: ProfitSplitConfig = {
    id: 'split-default-60-40',
    config_name: 'Skema Bagi Hasil Standar Tim 60% : Koperasi 40%',
    team_share_pct: 60.0,
    cooperative_share_pct: 40.0,
    admin_pin: '1122',
    coop_pin: '3344',
    supplier_name: 'Supplier MBG',
    payment_bank_name: 'BRI',
    payment_account_number: '0000-0000-0000-000',
    payment_account_holder: 'Bendahara Supplier MBG',
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
    const supplierName = clean(input.supplier_name) || 'Supplier MBG';
    const bankName = clean(input.payment_bank_name);
    const accountNumber = clean(input.payment_account_number);
    const accountHolder = clean(input.payment_account_holder);
    if (!bankName) return { ok: false, error: 'Nama Bank wajib diisi.' };
    if (!accountNumber) return { ok: false, error: 'Nomor Rekening wajib diisi.' };
    if (!accountHolder) return { ok: false, error: 'Atas Nama wajib diisi.' };

    const s = stateRef.current;
    const nextSplitConfig: ProfitSplitConfig = {
      ...s.splitConfig,
      supplier_name: supplierName,
      payment_bank_name: bankName,
      payment_account_number: accountNumber,
      payment_account_holder: accountHolder,
    };
    const nextInvoices = s.invoices.map((inv) =>
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
    commit({ ...s, splitConfig: nextSplitConfig, invoices: nextInvoices });

    if (!isSupabaseConfigured) {
      return { ok: true };
    }

    setSyncing(true);
    setSyncError(null);
    try {
      const supabase = getSupabaseClient();
      const rpcRes = await updateAppSettingsRpc(supabase, {
        teamSharePct: s.splitConfig.team_share_pct,
        coopSharePct: s.splitConfig.cooperative_share_pct,
        supplierName,
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
