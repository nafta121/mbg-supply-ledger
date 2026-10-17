'use client';

import React, { useState } from 'react';
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
import { MasterDataSheet } from './MasterDataSheet';
import { Tab1SupplierBatches } from './Tab1SupplierBatches';
import { Tab2KitchenMatrix } from './Tab2KitchenMatrix';
import { Tab3FieldBast } from './Tab3FieldBast';
import { Tab4InvoicesAndSettlements } from './Tab4InvoicesAndSettlements';
import { Tab5ProfitLedger } from './Tab5ProfitLedger';

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
    id: 'batches',
    label: 'Stok & HPP',
    renderIcon: (cls) => <PackageBatchIcon className={cls} />,
    roles: ['OWNER_ADMIN', 'FINANCE'],
  },
  {
    id: 'matrix',
    label: 'Bagi ke Dapur',
    renderIcon: (cls) => <MatrixGridIcon className={cls} />,
    roles: ['OWNER_ADMIN', 'FINANCE', 'FIELD_TEAM'],
  },
  {
    id: 'bast',
    label: 'Timbang',
    renderIcon: (cls) => <ScaleBastIcon className={cls} />,
    roles: ['OWNER_ADMIN', 'FINANCE', 'FIELD_TEAM', 'COOPERATIVE_VIEWER'],
  },
  {
    id: 'invoices',
    label: 'Tagihan',
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
  const { activeRole, activeTab, setActiveRole, setActiveTab, resetSimulationData } =
    useMbgStore();
  const [preselectBatchId, setPreselectBatchId] = useState<string | null>(null);
  const [masterOpen, setMasterOpen] = useState(false);

  const visibleTabs = NAV_TABS.filter((t) => t.roles.includes(activeRole));
  // Never render a tab the active role is not allowed to see (Invariant 5).
  const currentTab: ActiveTab = visibleTabs.some((t) => t.id === activeTab)
    ? activeTab
    : visibleTabs[0]?.id ?? 'bast';

  const handleReset = () => {
    if (typeof window !== 'undefined' && !window.confirm('Kembalikan semua data ke awal?')) {
      return;
    }
    setPreselectBatchId(null);
    resetSimulationData();
  };

  const openAllocation = (batchId: string) => {
    setPreselectBatchId(batchId);
    setActiveTab('matrix');
  };

  return (
    <div className="min-h-[100dvh] bg-slate-50 text-slate-900">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-emerald-600 focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-white"
      >
        Lewati ke konten utama
      </a>

      <div className="mx-auto flex min-h-[100dvh] max-w-md flex-col border-x border-slate-200 bg-slate-50 pb-20">
        {/* 1-row sticky header (56px) */}
        <header className="no-print sticky top-0 z-30 flex h-14 items-center justify-between gap-1.5 border-b border-slate-200 bg-white px-3">
          <h1 className="shrink-0 text-base font-extrabold tracking-tight text-slate-900">
            MBG<span className="hidden min-[400px]:inline"> Ledger</span>
          </h1>

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
                  onClick={() => setActiveRole(opt.role)}
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
                title="Data Master (Dapur, Supplier, Barang)"
                className="flex h-9 w-9 items-center justify-center rounded-full text-base transition hover:bg-slate-100"
              >
                <span aria-hidden="true">⚙️</span>
              </button>
            )}
            <button
              type="button"
              onClick={handleReset}
              aria-label="Reset data"
              title="Reset data"
              className="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition hover:bg-rose-50 hover:text-rose-600"
            >
              <RefreshResetIcon className="h-4 w-4" />
            </button>
          </div>
        </header>

        <MasterDataSheet
          open={masterOpen && activeRole === 'OWNER_ADMIN'}
          onClose={() => setMasterOpen(false)}
        />

        <main id="main-content" className="flex-1 px-3 py-3">
          {currentTab === 'batches' && <Tab1SupplierBatches onAllocate={openAllocation} />}
          {currentTab === 'matrix' && (
            <Tab2KitchenMatrix
              key={preselectBatchId ?? 'default'}
              initialBatchId={preselectBatchId}
            />
          )}
          {currentTab === 'bast' && <Tab3FieldBast key={activeRole} />}
          {currentTab === 'invoices' && <Tab4InvoicesAndSettlements />}
          {currentTab === 'ledger' && <Tab5ProfitLedger />}
        </main>

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
      </div>
    </div>
  );
}
