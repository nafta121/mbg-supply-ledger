'use client';

import React from 'react';
import { type ActiveTab, useMbgStore } from '../lib/mbg-store';
import type { UserRole } from '../types/mbg';
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
  icon: string;
  hideForFieldTeam?: boolean;
}> = [
  {
    id: 'batches',
    label: '1. Batch Supplier',
    shortTitle: 'Batch',
    icon: '📦',
    hideForFieldTeam: true,
  },
  {
    id: 'matrix',
    label: '2. Matriks 25 Dapur',
    shortTitle: 'Matriks',
    icon: '📊',
  },
  {
    id: 'bast',
    label: '3. BAST Lapangan',
    shortTitle: 'BAST (kg)',
    icon: '⚖️',
  },
  {
    id: 'invoices',
    label: '4. Invoice & Klaim',
    shortTitle: 'Invoice',
    icon: '🧾',
    hideForFieldTeam: true,
  },
  {
    id: 'ledger',
    label: '5. Ledger Bagi Hasil',
    shortTitle: 'Ledger',
    icon: '💰',
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
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="max-w-md mx-auto min-h-screen flex flex-col border-x border-slate-900 bg-slate-950 shadow-2xl pb-24">
        {/* Top App Header & Role Switcher Bar */}
        <header className="no-print sticky top-0 z-30 border-b border-slate-800 bg-slate-950/95 backdrop-blur px-3.5 py-3 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
                <span className="text-[10px] font-extrabold uppercase tracking-widest text-emerald-400">
                  MBG Supply Chain & Profit Ledger
                </span>
              </div>
              <h1 className="text-sm font-extrabold text-white">
                Operasi Batch 25 Dapur SPPG
              </h1>
            </div>

            <button
              type="button"
              onClick={resetSimulationData}
              className="rounded-xl border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-[10px] font-bold text-slate-300 shadow hover:border-rose-500/50 hover:bg-rose-950/40 hover:text-rose-200 transition"
              title="Kembalikan seluruh data ke skenario awal docs/01"
            >
              ↺ Reset Data Simulasi
            </button>
          </div>

          {/* Role Switcher Bar */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[10px] text-slate-400">
              <span className="font-semibold uppercase tracking-wider">
                Role Switcher (Invariant 5 RBAC):
              </span>
              <span className="font-mono text-emerald-300">{currentRoleMeta.badge}</span>
            </div>

            <div className="grid grid-cols-3 gap-1 rounded-xl border border-slate-800 bg-slate-900 p-1">
              {ROLE_OPTIONS.map((opt) => {
                const active = activeRole === opt.role;
                return (
                  <button
                    key={opt.role}
                    type="button"
                    onClick={() => setActiveRole(opt.role)}
                    className={`rounded-lg px-2 py-1.5 text-[10px] font-bold transition ${
                      active
                        ? opt.role === 'FIELD_TEAM'
                          ? 'bg-sky-600 text-white shadow'
                          : opt.role === 'COOPERATIVE_VIEWER'
                          ? 'bg-teal-600 text-white shadow'
                          : 'bg-emerald-600 text-white shadow'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {opt.shortLabel}
                  </button>
                );
              })}
            </div>

            <div className="rounded-lg bg-slate-900/90 px-2.5 py-1.5 text-[10px] text-slate-300 border border-slate-800/80">
              {currentRoleMeta.desc}
            </div>
          </div>
        </header>

        {/* Active Screen Content */}
        <main className="flex-1 px-3.5 py-4">
          {activeTab === 'batches' && <Tab1SupplierBatches />}
          {activeTab === 'matrix' && <Tab2KitchenMatrix />}
          {activeTab === 'bast' && <Tab3FieldBast />}
          {activeTab === 'invoices' && <Tab4InvoicesAndSettlements />}
          {activeTab === 'ledger' && <Tab5ProfitLedger />}
        </main>

        {/* Bottom Navigation Bar (5 Tabs, Financial Tabs Hidden in FIELD_TEAM Mode) */}
        <nav className="no-print fixed bottom-0 left-0 right-0 z-30">
          <div className="max-w-md mx-auto border-t border-slate-800 bg-slate-950/95 backdrop-blur px-2 py-1.5">
            <div
              className={`grid gap-1 ${
                visibleTabs.length === 2 ? 'grid-cols-2' : 'grid-cols-5'
              }`}
            >
              {visibleTabs.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex flex-col items-center justify-center rounded-xl py-1.5 px-1 transition ${
                      isActive
                        ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/40 font-bold'
                        : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                    }`}
                  >
                    <span className="text-sm leading-none">{tab.icon}</span>
                    <span className="mt-1 text-[10px] leading-tight truncate max-w-full">
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
