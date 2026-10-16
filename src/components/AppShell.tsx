'use client';

import React from 'react';
import { type ActiveTab, useMbgStore } from '../lib/mbg-store';
import type { UserRole } from '../types/mbg';
import {
  InvoiceReceiptIcon,
  LedgerVaultIcon,
  MatrixGridIcon,
  PackageBatchIcon,
  RefreshResetIcon,
  ScaleBastIcon,
} from './Icons';
import { Tab1SupplierBatches } from './Tab1SupplierBatches';
import { Tab2KitchenMatrix } from './Tab2KitchenMatrix';
import { Tab3FieldBast } from './Tab3FieldBast';
import { Tab4InvoicesAndSettlements } from './Tab4InvoicesAndSettlements';
import { Tab5ProfitLedger } from './Tab5ProfitLedger';

const ROLE_OPTIONS: Array<{
  role: UserRole;
  shortLabel: string;
  badge: string;
  desc: string;
}> = [
  {
    role: 'OWNER_ADMIN',
    shortLabel: 'OWNER_ADMIN',
    badge: 'Akses Penuh',
    desc: 'Akses penuh HPP aktual batch supplier, markup dapur, verifikasi invoice PAID, & payout bagi hasil.',
  },
  {
    role: 'FIELD_TEAM',
    shortLabel: 'FIELD_TEAM',
    badge: 'Kurir / BAST (kg)',
    desc: 'Invariant 5: Hanya bobot (kg) & input BAST timbangan dapur. Harga modal, markup, & keuangan disembunyikan.',
  },
  {
    role: 'COOPERATIVE_VIEWER',
    shortLabel: 'COOPERATIVE_VIEWER',
    badge: 'Koperasi (Read-Only)',
    desc: 'Pantau bobot diterima dapur, status pelunasan invoice UNPAID vs PAID, & hak bagi hasil Koperasi.',
  },
];

const NAV_TABS: Array<{
  id: ActiveTab;
  label: string;
  shortTitle: string;
  renderIcon: (className?: string) => React.ReactNode;
  hideForFieldTeam?: boolean;
}> = [
  {
    id: 'batches',
    label: '1. Batch Supplier & Harga Aktual',
    shortTitle: 'Batch',
    renderIcon: (cls) => <PackageBatchIcon className={cls} />,
    hideForFieldTeam: true,
  },
  {
    id: 'matrix',
    label: '2. Matriks Alokasi 25 Dapur',
    shortTitle: 'Matriks',
    renderIcon: (cls) => <MatrixGridIcon className={cls} />,
  },
  {
    id: 'bast',
    label: '3. Lapangan BAST & Timbangan',
    shortTitle: 'BAST (kg)',
    renderIcon: (cls) => <ScaleBastIcon className={cls} />,
  },
  {
    id: 'invoices',
    label: '4. Invoice Dapur & Klaim Supplier',
    shortTitle: 'Invoice',
    renderIcon: (cls) => <InvoiceReceiptIcon className={cls} />,
    hideForFieldTeam: true,
  },
  {
    id: 'ledger',
    label: '5. Ledger Bagi Hasil Cash-Basis',
    shortTitle: 'Ledger',
    renderIcon: (cls) => <LedgerVaultIcon className={cls} />,
    hideForFieldTeam: true,
  },
];

export function AppShell() {
  const {
    activeRole,
    activeTab,
    setActiveRole,
    setActiveTab,
    resetSimulationData,
  } = useMbgStore();

  const currentRoleMeta =
    ROLE_OPTIONS.find((r) => r.role === activeRole) ?? ROLE_OPTIONS[0]!;

  const visibleTabs =
    activeRole === 'FIELD_TEAM'
      ? NAV_TABS.filter((t) => !t.hideForFieldTeam)
      : NAV_TABS;

  return (
    <div className="min-h-[100dvh] bg-[#070A10] text-slate-100">
      {/* WCAG 2.1 AA Skip-to-Content Link */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-xl focus:bg-emerald-500 focus:px-4 focus:py-2 focus:text-xs focus:font-bold focus:text-slate-950"
      >
        Lewati ke konten utama
      </a>

      <div className="max-w-md mx-auto min-h-[100dvh] flex flex-col border-x border-white/[0.06] bg-[#070A10] shadow-[0_0_80px_rgba(0,0,0,0.85)] pb-28">
        {/* Top App Header & Role Switcher Bar */}
        <header className="no-print sticky top-0 z-30 border-b border-white/[0.07] bg-[#070A10]/90 backdrop-blur-xl px-4 py-3.5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 ring-1 ring-emerald-500/25">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-300">
                  MBG Supply Ledger
                </span>
              </div>
              <h1 className="mt-1 text-base font-extrabold tracking-tight text-white">
                Operasi Batch 25 Dapur SPPG
              </h1>
            </div>

            <button
              type="button"
              onClick={resetSimulationData}
              aria-label="Reset Data Simulasi ke kondisi awal"
              className="group inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-2 text-[11px] font-semibold text-slate-200 transition-all duration-300 ease-spring hover:border-rose-500/40 hover:bg-rose-950/40 hover:text-rose-200 active:scale-[0.98]"
              title="Kembalikan seluruh data ke skenario awal docs/01"
            >
              <RefreshResetIcon className="h-3.5 w-3.5 text-slate-400 transition-transform duration-300 ease-spring group-hover:-rotate-45 group-hover:text-rose-300" />
              <span>Reset Data Simulasi</span>
            </button>
          </div>

          {/* Role Switcher Bar (Double-Bezel Hardware Trajectory) */}
          <div className="rounded-2xl bg-white/[0.025] p-1.5 ring-1 ring-white/[0.08] space-y-1.5">
            <div className="flex items-center justify-between px-1.5 pt-0.5 text-[11px]">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                Role Switcher • Invariant 5 RBAC
              </span>
              <span className="font-mono text-[10px] font-bold text-emerald-300">
                [{currentRoleMeta.badge}]
              </span>
            </div>

            <div
              role="group"
              aria-label="Pilih Role Pengguna"
              className="grid grid-cols-3 gap-1 rounded-xl bg-[#0D131F] p-1 ring-1 ring-white/[0.05]"
            >
              {ROLE_OPTIONS.map((opt) => {
                const active = activeRole === opt.role;
                return (
                  <button
                    key={opt.role}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setActiveRole(opt.role)}
                    className={`min-h-[40px] rounded-lg px-2 py-1.5 font-mono text-[10px] font-bold tracking-tight transition-all duration-300 ease-spring active:scale-[0.98] ${
                      active
                        ? opt.role === 'FIELD_TEAM'
                          ? 'bg-amber-500 text-slate-950 shadow-[0_2px_12px_rgba(245,158,11,0.35)]'
                          : 'bg-emerald-500 text-slate-950 shadow-[0_2px_12px_rgba(16,185,129,0.35)]'
                        : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
                    }`}
                  >
                    {opt.shortLabel}
                  </button>
                );
              })}
            </div>

            <p className="px-1.5 pb-0.5 text-[11px] leading-relaxed text-slate-300">
              {currentRoleMeta.desc}
            </p>
          </div>
        </header>

        {/* Active Screen Content */}
        <main id="main-content" className="flex-1 px-4 py-4">
          {activeTab === 'batches' && <Tab1SupplierBatches />}
          {activeTab === 'matrix' && <Tab2KitchenMatrix />}
          {activeTab === 'bast' && <Tab3FieldBast />}
          {activeTab === 'invoices' && <Tab4InvoicesAndSettlements />}
          {activeTab === 'ledger' && <Tab5ProfitLedger />}
        </main>

        {/* Bottom Navigation Bar (5 Tabs, Financial Tabs Hidden in FIELD_TEAM Mode) */}
        <nav
          aria-label="Navigasi Utama Aplikasi MBG"
          className="no-print fixed bottom-0 left-0 right-0 z-30"
        >
          <div className="max-w-md mx-auto border-t border-white/[0.08] bg-[#070A10]/95 backdrop-blur-xl px-2.5 py-2">
            <div
              className={`grid gap-1.5 ${
                visibleTabs.length === 2 ? 'grid-cols-2' : 'grid-cols-5'
              }`}
            >
              {visibleTabs.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    aria-label={tab.label}
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => setActiveTab(tab.id)}
                    className={`min-h-[48px] flex flex-col items-center justify-center rounded-xl py-1.5 px-1 transition-all duration-300 ease-spring active:scale-[0.97] ${
                      isActive
                        ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40 font-bold shadow-[inset_0_1px_0_rgba(16,185,129,0.2)]'
                        : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
                    }`}
                  >
                    {tab.renderIcon(
                      `h-4 w-4 transition-transform duration-300 ease-spring ${
                        isActive ? 'scale-110 text-emerald-400' : 'text-slate-400'
                      }`
                    )}
                    <span className="mt-1 text-[11px] leading-tight truncate max-w-full">
                      {tab.shortTitle}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </nav>
      </div>
    </div>
  );
}
