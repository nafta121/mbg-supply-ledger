'use client';

import React, { useState } from 'react';
import { type ActiveTab, useMbgStore } from '../lib/mbg-store';
import type { UserRole } from '../types/mbg';
import { InvoiceReceiptIcon, LedgerVaultIcon, PackageBatchIcon, RefreshResetIcon, ScaleBastIcon } from './Icons';
import { MasterDataSheet } from './MasterDataSheet';
import { Tab1KitchenOrders } from './Tab1KitchenOrders';
import { Tab2CourierWeighing } from './Tab2CourierWeighing';
import { Tab3KitchenInvoices } from './Tab3KitchenInvoices';
import { Tab4ProfitSharing } from './Tab4ProfitSharing';
import { BottomSheet } from './ui';

const ROLE_PILLS: Array<{ role: UserRole; label: string }> = [
  { role: 'OWNER_ADMIN', label: 'Admin' },
  { role: 'FIELD_TEAM', label: 'Lapangan' },
  { role: 'COOPERATIVE_VIEWER', label: 'Koperasi' },
];

const NAV_TABS: Array<{
  id: ActiveTab;
  label: string;
  renderIcon: (className: string) => React.ReactNode;
  roles: UserRole[];
}> = [
  {
    id: 'orders',
    label: 'Order Dapur',
    renderIcon: (cls) => <PackageBatchIcon className={cls} />,
    // Prices & margins are entered here — Admin/Keuangan only (Invariant 5).
    roles: ['OWNER_ADMIN', 'FINANCE'],
  },
  {
    id: 'bast',
    label: 'Timbang',
    renderIcon: (cls) => <ScaleBastIcon className={cls} />,
    roles: ['OWNER_ADMIN', 'FINANCE', 'FIELD_TEAM', 'COOPERATIVE_VIEWER'],
  },
  {
    id: 'invoices',
    label: 'Invoice Dapur',
    renderIcon: (cls) => <InvoiceReceiptIcon className={cls} />,
    roles: ['OWNER_ADMIN', 'FINANCE', 'COOPERATIVE_VIEWER'],
  },
  {
    id: 'ledger',
    label: 'Bagi Hasil',
    renderIcon: (cls) => <LedgerVaultIcon className={cls} />,
    roles: ['OWNER_ADMIN', 'FINANCE', 'COOPERATIVE_VIEWER'],
  },
];

export function AppShell() {
  const {
    activeRole,
    activeTab,
    splitConfig,
    isLoading,
    isSyncing,
    isSupabaseLive,
    syncError,
    clearSyncError,
    setActiveRole,
    setActiveTab,
    resetSimulationData,
    clearAllTransactions,
  } = useMbgStore();
  const [masterOpen, setMasterOpen] = useState(false);
  const [resetSheetOpen, setResetSheetOpen] = useState(false);
  const [resetPin, setResetPin] = useState('');
  const [resetPinError, setResetPinError] = useState<string | null>(null);

  // PIN Role Lock state for switching into Admin / Koperasi
  const [pinTargetRole, setPinTargetRole] = useState<UserRole | null>(null);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

  const handleRolePillClick = (targetRole: UserRole) => {
    if (targetRole === activeRole) return;
    // Role Lapangan (FIELD_TEAM) is always accessible without a PIN.
    if (targetRole === 'FIELD_TEAM') {
      setActiveRole('FIELD_TEAM');
      return;
    }
    const storageKey = `mbg_pin_verified_${targetRole}`;
    if (typeof window !== 'undefined' && window.sessionStorage.getItem(storageKey) === '1') {
      setActiveRole(targetRole);
      return;
    }
    setPinTargetRole(targetRole);
    setPinInput('');
    setPinError(null);
  };

  const handleVerifyRolePin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pinTargetRole) return;
    const expectedPin =
      pinTargetRole === 'OWNER_ADMIN' ? splitConfig.admin_pin || '1122' : splitConfig.coop_pin || '3344';
    if (pinInput.trim() !== expectedPin) {
      setPinError('PIN salah. Periksa kembali PIN 4 digit Anda.');
      return;
    }
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(`mbg_pin_verified_${pinTargetRole}`, '1');
    }
    const nextRole = pinTargetRole;
    setPinTargetRole(null);
    setPinInput('');
    setPinError(null);
    setActiveRole(nextRole);
  };

  const visibleTabs = NAV_TABS.filter((t) => t.roles.includes(activeRole));
  // Never render a tab the active role is not allowed to see (Invariant 5).
  const currentTab: ActiveTab = visibleTabs.some((t) => t.id === activeTab)
    ? activeTab
    : visibleTabs[0]?.id ?? 'bast';
  // Single-courier focus mode: no bottom nav when there is only one screen.
  const showNav = visibleTabs.length > 1;

  return (
    <div className="min-h-[100dvh] bg-slate-50 text-slate-900">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-emerald-600 focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-white"
      >
        Lewati ke konten utama
      </a>

      <div
        className={`mx-auto flex min-h-[100dvh] max-w-md flex-col border-x border-slate-200 bg-slate-50 ${
          showNav ? 'pb-20' : 'pb-6'
        }`}
      >
        {/* 1-row sticky header (56px) */}
        <header className="no-print sticky top-0 z-30 flex h-14 items-center justify-between gap-1.5 border-b border-slate-200 bg-white px-3">
          <div className="flex min-w-0 shrink-0 flex-col">
            <h1 className="truncate text-sm font-extrabold leading-tight tracking-tight text-slate-900">
              MBG<span className="hidden min-[400px]:inline"> Ledger</span>
            </h1>
            <span
              aria-live="polite"
              className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  isSyncing ? 'animate-ping bg-amber-500' : isSupabaseLive ? 'bg-emerald-500' : 'bg-slate-400'
                }`}
              />
              {isSyncing ? 'Menyimpan…' : '● Live Supabase'}
            </span>
          </div>

          <div
            role="group"
            aria-label="Pilih peran"
            className="flex items-center rounded-full bg-slate-100 p-0.5 ring-1 ring-slate-200"
          >
            {ROLE_PILLS.map((opt) => {
              const active = activeRole === opt.role;
              return (
                <button
                  key={opt.role}
                  type="button"
                  aria-pressed={active}
                  onClick={() => handleRolePillClick(opt.role)}
                  className={`min-h-[36px] rounded-full px-2.5 text-xs font-bold transition ${
                    active
                      ? 'bg-emerald-600 text-white shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          <div className="flex shrink-0 items-center">
            {activeRole === 'OWNER_ADMIN' && (
              <button
                type="button"
                onClick={() => setMasterOpen(true)}
                aria-label="Data Master"
                title="Data Master (Dapur & Barang)"
                className="flex h-9 w-9 items-center justify-center rounded-full text-base transition hover:bg-slate-100"
              >
                <span aria-hidden="true">⚙️</span>
              </button>
            )}
            {activeRole === 'OWNER_ADMIN' && (
              <button
                type="button"
                onClick={() => {
                  setResetPin('');
                  setResetPinError(null);
                  setResetSheetOpen(true);
                }}
                aria-label="Reset data"
                title="Reset / Kosongkan Transaksi Supabase"
                className="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition hover:bg-rose-50 hover:text-rose-600"
              >
                <RefreshResetIcon className="h-4 w-4" />
              </button>
            )}
          </div>
        </header>

        <MasterDataSheet
          open={masterOpen && activeRole === 'OWNER_ADMIN'}
          onClose={() => setMasterOpen(false)}
        />

        {/* PIN Verification Modal when switching to Admin or Koperasi */}
        <BottomSheet
          open={pinTargetRole !== null}
          title={pinTargetRole === 'OWNER_ADMIN' ? '🔒 Verifikasi PIN Admin' : '🔒 Verifikasi PIN Koperasi'}
          onClose={() => {
            setPinTargetRole(null);
            setPinInput('');
            setPinError(null);
          }}
        >
          <form onSubmit={handleVerifyRolePin} className="space-y-3 text-sm text-slate-700">
            <p className="text-xs text-slate-600">
              Masukkan PIN 4 digit untuk membuka akses{' '}
              <span className="font-bold text-slate-900">
                {pinTargetRole === 'OWNER_ADMIN' ? 'Admin' : 'Koperasi'}
              </span>
              . (Mode <span className="font-semibold">Lapangan</span> tetap dapat diakses tanpa PIN).
            </p>
            <div>
              <label htmlFor="role-pin-input" className="field-label">
                PIN 4 Digit
              </label>
              <input
                id="role-pin-input"
                type="password"
                inputMode="numeric"
                maxLength={6}
                autoFocus
                placeholder="••••"
                value={pinInput}
                onChange={(e) => {
                  setPinInput(e.target.value.replace(/\D/g, ''));
                  if (pinError) setPinError(null);
                }}
                className="field-input text-center font-mono text-lg tracking-widest"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                Default {pinTargetRole === 'OWNER_ADMIN' ? 'Admin: 1122' : 'Koperasi: 3344'}
              </p>
            </div>
            {pinError && (
              <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
                {pinError}
              </p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setPinTargetRole(null);
                  setPinInput('');
                  setPinError(null);
                }}
                className="btn-secondary w-full"
              >
                Batal
              </button>
              <button type="submit" className="btn-primary w-full">
                🔓 Buka Akses
              </button>
            </div>
          </form>
        </BottomSheet>

        <BottomSheet
          open={resetSheetOpen && activeRole === 'OWNER_ADMIN'}
          title="🔄 Kelola Data Database Supabase"
          onClose={() => setResetSheetOpen(false)}
        >
          <div className="space-y-3 text-sm text-slate-700">
            <p className="text-xs text-slate-600">
              Tindakan destruktif pada database cloud Supabase (<span className="font-mono">nrdepkayabbbshnmyrvc</span>)
              wajib diverifikasi dengan PIN Admin:
            </p>
            <div>
              <label htmlFor="reset-admin-pin" className="field-label">
                PIN Admin Konfirmasi
              </label>
              <input
                id="reset-admin-pin"
                type="password"
                inputMode="numeric"
                maxLength={6}
                placeholder="Masukkan PIN Admin (default 1122)"
                value={resetPin}
                onChange={(e) => {
                  setResetPin(e.target.value.replace(/\D/g, ''));
                  if (resetPinError) setResetPinError(null);
                }}
                className="field-input font-mono tracking-widest"
              />
            </div>
            {resetPinError && (
              <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
                {resetPinError}
              </p>
            )}
            <button
              type="button"
              onClick={async () => {
                const expected = splitConfig.admin_pin || '1122';
                if (resetPin.trim() !== expected) {
                  setResetPinError('Masukkan PIN Admin yang benar sebelum mereset database.');
                  return;
                }
                if (
                  typeof window === 'undefined' ||
                  window.confirm('Kembalikan database Supabase ke 5 Order Dapur simulasi awal (16 Oktober 2026)?')
                ) {
                  const res = await resetSimulationData(resetPin.trim());
                  if (!res.ok) {
                    setResetPinError(res.error);
                    return;
                  }
                  setResetSheetOpen(false);
                }
              }}
              className="btn-primary w-full"
            >
              🔄 Reset ke Seed Simulasi Awal (5 Order)
            </button>
            <button
              type="button"
              onClick={async () => {
                const expected = splitConfig.admin_pin || '1122';
                if (resetPin.trim() !== expected) {
                  setResetPinError('Masukkan PIN Admin yang benar sebelum mengosongkan transaksi.');
                  return;
                }
                if (
                  typeof window === 'undefined' ||
                  window.confirm(
                    'Kosongkan seluruh transaksi (Order, Invoice, Bagi Hasil) di Supabase? Master Dapur & Master Barang tetap disimpan.'
                  )
                ) {
                  const res = await clearAllTransactions(resetPin.trim());
                  if (!res.ok) {
                    setResetPinError(res.error);
                    return;
                  }
                  setResetSheetOpen(false);
                }
              }}
              className="btn-secondary w-full border-rose-300 text-rose-700 hover:bg-rose-50"
            >
              🧹 Kosongkan Transaksi (Mulai Operasional Bersih)
            </button>
          </div>
        </BottomSheet>

        <main id="main-content" className="flex-1 space-y-3 px-3 py-3">
          {syncError && (
            <div
              role="alert"
              className="no-print flex items-start justify-between gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2.5 text-xs font-semibold text-rose-800 shadow-sm"
            >
              <span>⚠️ {syncError}</span>
              <button
                type="button"
                onClick={clearSyncError}
                className="shrink-0 rounded px-1.5 py-0.5 text-xs font-bold text-rose-700 hover:bg-rose-100"
              >
                Tutup
              </button>
            </div>
          )}

          {isLoading ? (
            <div aria-label="Memuat data dari Supabase" className="space-y-3">
              <div className="h-24 animate-pulse rounded-xl bg-slate-200/80" />
              <div className="h-40 animate-pulse rounded-xl bg-slate-200/80" />
              <div className="h-40 animate-pulse rounded-xl bg-slate-200/80" />
            </div>
          ) : (
            <>
              {currentTab === 'orders' && <Tab1KitchenOrders />}
              {currentTab === 'bast' && <Tab2CourierWeighing key={activeRole} />}
              {currentTab === 'invoices' && <Tab3KitchenInvoices />}
              {currentTab === 'ledger' && <Tab4ProfitSharing />}
            </>
          )}
        </main>

        {showNav && (
          <nav aria-label="Navigasi utama" className="no-print fixed bottom-0 left-0 right-0 z-30">
            <div className="mx-auto max-w-md border-t border-slate-200 bg-white px-1.5 pb-[env(safe-area-inset-bottom)]">
              <div
                className="grid"
                style={{ gridTemplateColumns: `repeat(${visibleTabs.length}, minmax(0, 1fr))` }}
              >
                {visibleTabs.map((tab) => {
                  const isActive = currentTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      aria-current={isActive ? 'page' : undefined}
                      onClick={() => setActiveTab(tab.id)}
                      className={`relative flex min-h-[60px] flex-col items-center justify-center gap-1 px-1 transition ${
                        isActive ? 'text-emerald-700' : 'text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      {isActive && (
                        <span className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-emerald-600" />
                      )}
                      {tab.renderIcon('h-5 w-5')}
                      <span className={`max-w-full truncate text-[11px] ${isActive ? 'font-bold' : 'font-medium'}`}>
                        {tab.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </nav>
        )}
      </div>
    </div>
  );
}
