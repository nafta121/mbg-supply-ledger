'use client';

import React, { useEffect, useState } from 'react';
import { type ActiveTab, useMbgStore } from '../lib/mbg-store';
import { getSupabaseClient, isSupabaseConfigured } from '../lib/supabase';
import { verifyRolePinRpc } from '../lib/supabase-sync';
import type { UserRole } from '../types/mbg';
import { InvoiceReceiptIcon, LedgerVaultIcon, PackageBatchIcon, SettingsGearIcon } from './Icons';
import { MasterDataSheet } from './MasterDataSheet';
import { Tab1KitchenOrders } from './Tab1KitchenOrders';
import { Tab3KitchenInvoices } from './Tab3KitchenInvoices';
import { Tab4ProfitSharing } from './Tab4ProfitSharing';
import { BottomSheet } from './ui';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const ROLE_PILLS: Array<{ role: UserRole; label: string }> = [
  { role: 'COOPERATIVE_VIEWER', label: 'Koperasi' },
  { role: 'OWNER_ADMIN', label: 'Admin' },
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
    retrySync,
    setActiveRole,
    setActiveTab,
  } = useMbgStore();
  const [masterOpen, setMasterOpen] = useState(false);

  const [adminPinOpen, setAdminPinOpen] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [isVerifyingPin, setIsVerifyingPin] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => setInstallPrompt(null);
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === 'accepted') {
      setInstallPrompt(null);
    }
  };

  const handleRolePillClick = (targetRole: UserRole) => {
    if (targetRole === activeRole) return;
    if (targetRole !== 'OWNER_ADMIN') {
      if (typeof window !== 'undefined') {
        window.sessionStorage.removeItem('mbg_pin_verified_OWNER_ADMIN');
        window.sessionStorage.removeItem('mbg_admin_pin');
      }
      setActiveRole(targetRole);
      return;
    }
    if (
      typeof window !== 'undefined' &&
      window.sessionStorage.getItem('mbg_pin_verified_OWNER_ADMIN') === '1' &&
      Boolean(window.sessionStorage.getItem('mbg_admin_pin'))
    ) {
      setActiveRole('OWNER_ADMIN');
      return;
    }
    setAdminPinOpen(true);
    setPinInput('');
    setPinError(null);
  };

  const handleVerifyRolePin = async (e: React.FormEvent) => {
    e.preventDefault();
    const typedPin = pinInput.trim();
    if (!isSupabaseConfigured || !isSupabaseLive) {
      setPinError('Tidak dapat memverifikasi PIN saat offline. Periksa koneksi internet Anda.');
      return;
    }
    setIsVerifyingPin(true);
    try {
      const verified = await verifyRolePinRpc(getSupabaseClient(), 'OWNER_ADMIN', typedPin);
      if (!verified) {
        setPinError('PIN Admin salah. Periksa kembali PIN 4 digit Anda.');
        return;
      }
      if (typeof window !== 'undefined') {
        window.sessionStorage.setItem('mbg_pin_verified_OWNER_ADMIN', '1');
        window.sessionStorage.setItem('mbg_admin_pin', typedPin);
      }
      setAdminPinOpen(false);
      setPinInput('');
      setPinError(null);
      setActiveRole('OWNER_ADMIN');
    } finally {
      setIsVerifyingPin(false);
    }
  };

  const visibleTabs = NAV_TABS.filter((t) => t.roles.includes(activeRole));
  const currentTab: ActiveTab = visibleTabs.some((t) => t.id === activeTab)
    ? activeTab
    : visibleTabs[0]?.id ?? 'orders';
  const showNav = visibleTabs.length > 1;

  return (
    <div className="min-h-[100dvh] bg-paper text-ink">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-[6px] focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
      >
        Lewati ke konten utama
      </a>

      <div
        className={`mx-auto flex min-h-[100dvh] max-w-2xl lg:max-w-5xl flex-col border-x border-rule bg-paper ${
          showNav ? 'pb-20 sm:pb-8' : 'pb-6'
        }`}
      >
        {/* Preline Application Navbar (56px, flat 1px border, structured left/right groups with divider) */}
        <header className="no-print sticky top-0 z-30 flex h-[56px] items-center justify-between gap-2 border-b border-rule bg-white px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="h-5 w-5 shrink-0 text-signal"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="18" height="18" rx="4" stroke="currentColor" strokeWidth="1.75" />
              <path d="M7.5 8.5h9M7.5 12h9M7.5 15.5h5.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
            </svg>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[14px] font-bold leading-tight tracking-tight text-ink">
                MBG Ledger
              </span>
              <span
                aria-live="polite"
                className="inline-flex items-center gap-1.5 text-[11px] font-normal text-muted"
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    isSyncing ? 'bg-warning' : isSupabaseLive ? 'bg-success' : 'bg-muted-2'
                  }`}
                />
                {isSyncing ? 'Menyimpan…' : isSupabaseLive ? 'Tersinkron' : 'Offline'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {installPrompt && (
              <button
                type="button"
                onClick={() => void handleInstallClick()}
                aria-label="Instal aplikasi MBG Ledger"
                title="Instal aplikasi di perangkat ini"
                className="inline-flex h-[34px] items-center gap-1 rounded-[6px] border border-signal bg-white px-2.5 text-[12px] font-medium text-signal transition-colors hover:bg-paper active:translate-y-px disabled:opacity-50"
              >
                Instal
              </button>
            )}
            <div
              role="group"
              aria-label="Pilih peran"
              className="flex items-center rounded-[6px] border border-rule bg-paper-3 p-0.5"
            >
              {ROLE_PILLS.map((opt) => {
                const active = activeRole === opt.role;
                return (
                  <button
                    key={opt.role}
                    type="button"
                    aria-pressed={active}
                    onClick={() => handleRolePillClick(opt.role)}
                    className={`min-h-[34px] rounded-[4px] border px-2.5 text-[12px] font-medium transition-colors ${
                      active
                        ? 'border-rule bg-white text-ink'
                        : 'border-transparent text-muted hover:text-ink'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {activeRole === 'OWNER_ADMIN' && (
              <>
                <span aria-hidden="true" className="h-5 w-px bg-rule" />
                <button
                  type="button"
                  onClick={() => setMasterOpen(true)}
                  aria-label="Pengaturan & Data Master"
                  title="Pengaturan & Data Master"
                  className="flex min-h-[38px] min-w-[38px] items-center justify-center rounded-[6px] border border-control bg-white text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink"
                >
                  <SettingsGearIcon className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        </header>

        <MasterDataSheet
          open={masterOpen && activeRole === 'OWNER_ADMIN'}
          onClose={() => setMasterOpen(false)}
        />

        {/* PIN Verification Modal when switching to Admin */}
        <BottomSheet
          open={adminPinOpen}
          title="Verifikasi PIN Admin"
          onClose={() => {
            setAdminPinOpen(false);
            setPinInput('');
            setPinError(null);
          }}
        >
          <form onSubmit={handleVerifyRolePin} className="space-y-3 text-[14px] text-ink">
            <p className="text-[13px] text-muted">
              Masukkan PIN 4 digit untuk membuka akses <span className="font-medium text-ink">Admin</span>.
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
            <div className="min-h-[1lh]">
              {pinError && (
                <p role="alert" className="rounded-[6px] bg-error-bg px-3 py-2 text-[12px] font-medium text-error-ink">
                  {pinError}
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setAdminPinOpen(false);
                  setPinInput('');
                  setPinError(null);
                }}
                className="btn-secondary w-full"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={isVerifyingPin || pinInput.trim().length < 4}
                className="btn-primary w-full"
              >
                {isVerifyingPin ? 'Memverifikasi…' : 'Buka Akses'}
              </button>
            </div>
          </form>
        </BottomSheet>

        {showNav && (
          <nav
            aria-label="Navigasi utama"
            className="no-print fixed bottom-0 left-0 right-0 z-30 sm:sticky sm:top-[56px] sm:bottom-auto sm:order-none"
          >
            <div className="mx-auto max-w-2xl lg:max-w-5xl border-t border-rule bg-white px-2 pb-[env(safe-area-inset-bottom)] sm:border-b sm:border-t-0 sm:bg-paper-2 sm:px-4 sm:pb-0">
              <div
                className="grid sm:gap-2"
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
                      className={`relative flex min-h-[54px] flex-col items-center justify-center gap-1 px-1 transition-colors sm:min-h-[42px] sm:flex-row sm:gap-2 ${
                        isActive ? 'text-ink' : 'text-muted hover:bg-paper-2 hover:text-ink'
                      }`}
                    >
                      {isActive && (
                        <span className="absolute inset-x-6 top-0 h-[2px] bg-signal sm:inset-x-3 sm:bottom-0 sm:top-auto" />
                      )}
                      {tab.renderIcon(isActive ? 'h-4 w-4 text-signal' : 'h-4 w-4')}
                      <span className={`max-w-full truncate text-[12px] sm:text-[13px] ${isActive ? 'font-medium' : 'font-normal'}`}>
                        {tab.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </nav>
        )}

        <main id="main-content" className="flex-1 space-y-3.5 px-4 py-4">
          {syncError && (
            <div
              role="alert"
              className="no-print flex items-start justify-between gap-2 rounded-[8px] border border-error-border bg-error-bg px-3.5 py-2.5 text-[13px] font-medium text-error-ink"
            >
              <span>{syncError}</span>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void retrySync()}
                  className="rounded border border-error-border bg-white px-2 py-1 text-[12px] font-medium text-error-ink hover:bg-error-hover"
                >
                  Coba Lagi
                </button>
                <button
                  type="button"
                  onClick={clearSyncError}
                  className="rounded px-2 py-1 text-[12px] font-medium text-error-ink hover:bg-error-hover"
                >
                  Tutup
                </button>
              </div>
            </div>
          )}

          {isLoading ? (
            <div aria-label="Memuat data buku besar" className="space-y-3">
              <div className="card space-y-2 p-4">
                <div className="h-4 w-32 rounded bg-paper-3" />
                <div className="h-8 w-48 rounded bg-paper-3" />
              </div>
              <div className="card space-y-2.5 p-4">
                <div className="h-4 w-40 rounded bg-paper-3" />
                <div className="h-10 w-full rounded bg-paper-3" />
                <div className="h-10 w-full rounded bg-paper-3" />
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
      </div>
    </div>
  );
}
