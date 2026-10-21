'use client';

import React, { useState } from 'react';
import { type ActiveTab, useMbgStore } from '../lib/mbg-store';
import type { UserRole } from '../types/mbg';
import { InvoiceReceiptIcon, LedgerVaultIcon, PackageBatchIcon, SettingsGearIcon } from './Icons';
import { MasterDataSheet } from './MasterDataSheet';
import { Tab1KitchenOrders } from './Tab1KitchenOrders';
import { Tab3KitchenInvoices } from './Tab3KitchenInvoices';
import { Tab4ProfitSharing } from './Tab4ProfitSharing';
import { BottomSheet } from './ui';

const ROLE_PILLS: Array<{ role: UserRole; label: string }> = [
  { role: 'OWNER_ADMIN', label: 'Admin' },
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
    roles: ['OWNER_ADMIN', 'FINANCE'],
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
  } = useMbgStore();
  const [masterOpen, setMasterOpen] = useState(false);

  const [pinTargetRole, setPinTargetRole] = useState<UserRole | null>(null);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

  const handleRolePillClick = (targetRole: UserRole) => {
    if (targetRole === activeRole) return;
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
  const currentTab: ActiveTab = visibleTabs.some((t) => t.id === activeTab)
    ? activeTab
    : visibleTabs[0]?.id ?? 'orders';
  const showNav = visibleTabs.length > 1;

  return (
    <div className="min-h-[100dvh] bg-[#f2f4f7] text-[#0a0a0a]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-[6px] focus:bg-[#141414] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
      >
        Lewati ke konten utama
      </a>

      <div
        className={`mx-auto flex min-h-[100dvh] max-w-md flex-col border-x border-[#e6e6e6] bg-[#f2f4f7] ${
          showNav ? 'pb-20' : 'pb-6'
        }`}
      >
        {/* Top bar (52px, flat 1px border) */}
        <header className="no-print sticky top-0 z-30 flex h-[52px] items-center justify-between gap-2 border-b border-[#e6e6e6] bg-white px-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="h-5 w-5 shrink-0 text-[#1d5fbf]"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="18" height="18" rx="4" stroke="currentColor" strokeWidth="1.75" />
              <path d="M7.5 8.5h9M7.5 12h9M7.5 15.5h5.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
            </svg>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[14px] font-bold leading-tight tracking-tight text-[#0a0a0a]">
                MBG Ledger
              </span>
              <span
                aria-live="polite"
                className="inline-flex items-center gap-1.5 text-[11px] font-normal text-[#6b6b6b]"
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    isSyncing ? 'bg-[#92400e]' : isSupabaseLive ? 'bg-[#2e7d32]' : 'bg-[#8a8a8a]'
                  }`}
                />
                {isSyncing ? 'Menyimpan…' : isSupabaseLive ? 'Live Supabase' : 'Offline'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <div
              role="group"
              aria-label="Pilih peran"
              className="flex items-center rounded-[6px] border border-[#e6e6e6] bg-[#eeeeee] p-0.5"
            >
              {ROLE_PILLS.map((opt) => {
                const active = activeRole === opt.role;
                return (
                  <button
                    key={opt.role}
                    type="button"
                    aria-pressed={active}
                    onClick={() => handleRolePillClick(opt.role)}
                    className={`min-h-[30px] rounded-[4px] px-2.5 text-[12px] font-medium transition-colors ${
                      active
                        ? 'bg-white text-[#0a0a0a]'
                        : 'text-[#6b6b6b] hover:text-[#0a0a0a]'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {activeRole === 'OWNER_ADMIN' && (
              <button
                type="button"
                onClick={() => setMasterOpen(true)}
                aria-label="Pengaturan & Data Master"
                title="Pengaturan & Data Master"
                className="flex h-[34px] w-[34px] items-center justify-center rounded-[6px] border border-[#d4d4d4] bg-white text-[#3d3d3d] transition-colors hover:bg-[#f8f8f8] hover:text-[#0a0a0a]"
              >
                <SettingsGearIcon className="h-4 w-4" />
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
          title={pinTargetRole === 'OWNER_ADMIN' ? 'Verifikasi PIN Admin' : 'Verifikasi PIN Koperasi'}
          onClose={() => {
            setPinTargetRole(null);
            setPinInput('');
            setPinError(null);
          }}
        >
          <form onSubmit={handleVerifyRolePin} className="space-y-3 text-[14px] text-[#0a0a0a]">
            <p className="text-[13px] text-[#6b6b6b]">
              Masukkan PIN 4 digit untuk membuka akses{' '}
              <span className="font-medium text-[#0a0a0a]">
                {pinTargetRole === 'OWNER_ADMIN' ? 'Admin' : 'Koperasi'}
              </span>
              .
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
                className="field-input text-center text-lg tracking-widest tabular-nums"
              />
            </div>
            {pinError && (
              <p role="alert" className="rounded-[6px] bg-[#ffedea] px-3 py-2 text-[12px] font-medium text-[#831c1e]">
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
                Buka Akses
              </button>
            </div>
          </form>
        </BottomSheet>

        <main id="main-content" className="flex-1 space-y-3 px-3.5 py-3.5">
          {syncError && (
            <div
              role="alert"
              className="no-print flex items-start justify-between gap-2 rounded-[8px] border border-[#f5c2c0] bg-[#ffedea] px-3 py-2.5 text-[13px] font-medium text-[#831c1e]"
            >
              <span>{syncError}</span>
              <button
                type="button"
                onClick={clearSyncError}
                className="shrink-0 rounded px-1.5 py-0.5 text-[12px] font-medium text-[#831c1e] hover:bg-[#f5c2c0]/40"
              >
                Tutup
              </button>
            </div>
          )}

          {isLoading ? (
            <div aria-label="Memuat data dari Supabase" className="space-y-3">
              <div className="card space-y-2 p-4">
                <div className="h-4 w-32 rounded bg-[#eeeeee]" />
                <div className="h-8 w-48 rounded bg-[#eeeeee]" />
              </div>
              <div className="card space-y-2.5 p-4">
                <div className="h-4 w-40 rounded bg-[#eeeeee]" />
                <div className="h-10 w-full rounded bg-[#eeeeee]" />
                <div className="h-10 w-full rounded bg-[#eeeeee]" />
              </div>
            </div>
          ) : (
            <>
              {currentTab === 'orders' && <Tab1KitchenOrders />}
              {currentTab === 'invoices' && <Tab3KitchenInvoices />}
              {currentTab === 'ledger' && <Tab4ProfitSharing />}
            </>
          )}
        </main>

        {showNav && (
          <nav aria-label="Navigasi utama" className="no-print fixed bottom-0 left-0 right-0 z-30">
            <div className="mx-auto max-w-md border-t border-[#e6e6e6] bg-white px-2 pb-[env(safe-area-inset-bottom)]">
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
                      className={`relative flex min-h-[54px] flex-col items-center justify-center gap-1 px-1 transition-colors ${
                        isActive ? 'text-[#0a0a0a]' : 'text-[#6b6b6b] hover:text-[#0a0a0a]'
                      }`}
                    >
                      {isActive && (
                        <span className="absolute inset-x-5 top-0 h-[2px] bg-[#0a0a0a]" />
                      )}
                      {tab.renderIcon('h-4 w-4')}
                      <span className={`max-w-full truncate text-[12px] ${isActive ? 'font-medium' : 'font-normal'}`}>
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
