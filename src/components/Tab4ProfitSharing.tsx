'use client';

import React, { useMemo, useState } from 'react';
import { buildInvoiceProfit } from '../lib/invoice-view';
import { useMbgStore } from '../lib/mbg-store';
import type { BeneficiaryType, LedgerPayoutStatus } from '../types/mbg';
import {
  formatKgNum,
  formatRp,
  PAYOUT_LABEL,
  payoutTone,
  shortKitchenName,
  sumIdr,
} from '../lib/ui-format';
import { ChevronDownIcon } from './Icons';
import {
  type GroupMode,
  sortAndGroupItems,
  SortGroupControls,
  type SortMode,
} from './OrderInvoiceEditSheet';
import { Badge, Card, NoAccess, SegmentedControl, StatRow, Toast, type ToastState } from './ui';

type ProfitFilter = 'all' | 'avail' | 'locked' | 'paid_out';

export function Tab4ProfitSharing() {
  const {
    activeRole,
    isSyncing,
    splitConfig,
    ledgerEntries,
    invoices,
    kitchens,
    payoutBatches,
    updateProfitSplitPercentage,
    executePayout,
  } = useMbgStore();

  const [teamPctInput, setTeamPctInput] = useState(String(splitConfig.team_share_pct));
  const [toast, setToast] = useState<ToastState>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [profitFilter, setProfitFilter] = useState<ProfitFilter>('all');
  const [sortBy, setSortBy] = useState<SortMode>('date_desc');
  const [groupBy, setGroupBy] = useState<GroupMode>('none');
  const [confirmPayoutWho, setConfirmPayoutWho] = useState<BeneficiaryType | 'ALL' | null>(null);

  const kitchenById = useMemo(() => new Map(kitchens.map((k) => [k.id, k])), [kitchens]);

  const { availTeam, availCoop, availTotal, lockedTeam, lockedCoop, lockedTotal } = useMemo(() => {
    const sumBy = (status: LedgerPayoutStatus, who: BeneficiaryType) =>
      sumIdr(
        ledgerEntries
          .filter((le) => le.payout_status === status && le.beneficiary_type === who)
          .map((le) => le.profit_amount)
      );
    const aTeam = sumBy('AVAILABLE_FOR_PAYOUT', 'TEAM');
    const aCoop = sumBy('AVAILABLE_FOR_PAYOUT', 'COOPERATIVE');
    const lTeam = sumBy('LOCKED_UNPAID', 'TEAM');
    const lCoop = sumBy('LOCKED_UNPAID', 'COOPERATIVE');
    return {
      availTeam: aTeam,
      availCoop: aCoop,
      availTotal: sumIdr([aTeam, aCoop]),
      lockedTeam: lTeam,
      lockedCoop: lCoop,
      lockedTotal: sumIdr([lTeam, lCoop]),
    };
  }, [ledgerEntries]);

  const paidOutTotal = useMemo(
    () => sumIdr(payoutBatches.map((p) => p.total_payout_amount)),
    [payoutBatches]
  );

  const invoiceProfits = useMemo(
    () =>
      invoices.map((inv) => ({
        inv,
        kitchen: kitchenById.get(inv.kitchen_id),
        profit: buildInvoiceProfit({ ledgerEntries }, inv.id),
      })),
    [invoices, kitchenById, ledgerEntries]
  );

  const filteredProfits = useMemo(() => {
    if (profitFilter === 'all') return invoiceProfits;
    return invoiceProfits.filter(({ profit }) => {
      const s = profit.coop_status;
      if (profitFilter === 'avail') return s === 'AVAILABLE_FOR_PAYOUT' || profit.team_status === 'AVAILABLE_FOR_PAYOUT';
      if (profitFilter === 'locked') return s === 'LOCKED_UNPAID' || profit.team_status === 'LOCKED_UNPAID';
      return s === 'PAID_OUT' && profit.team_status === 'PAID_OUT';
    });
  }, [invoiceProfits, profitFilter]);

  const groupedProfits = useMemo(
    () =>
      sortAndGroupItems(filteredProfits, sortBy, groupBy, {
        getDate: (p) => p.inv.invoice_date || '',
        getKitchenName: (p) => (p.kitchen ? shortKitchenName(p.kitchen.name) : '-'),
        getKitchenCode: (p) => p.kitchen?.kitchen_code ?? '-',
        getCode: (p) => p.inv.invoice_number,
      }),
    [filteredProfits, sortBy, groupBy]
  );

  const allExpanded = filteredProfits.length > 0 && filteredProfits.every(({ inv }) => expandedIds.has(inv.id));
  const toggleInvoiceRow = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleExpandAll = () =>
    setExpandedIds(allExpanded ? new Set() : new Set(filteredProfits.map(({ inv }) => inv.id)));

  if (activeRole === 'FIELD_TEAM') return <NoAccess />;

  const isAdmin = activeRole === 'OWNER_ADMIN' || activeRole === 'FINANCE';

  const teamPct = splitConfig.team_share_pct;
  const coopPct = splitConfig.cooperative_share_pct;

  const handlePayout = async (who: BeneficiaryType | 'ALL') => {
    if (!isAdmin || isSyncing) return;
    const total = who === 'ALL' ? availTotal : who === 'TEAM' ? availTeam : availCoop;
    if (total <= 0) return;
    const whoLabel = who === 'ALL' ? 'Tim & Koperasi' : who === 'TEAM' ? 'Tim' : 'Koperasi';
    setConfirmPayoutWho(null);
    const res = await executePayout(who === 'ALL' ? 'BOTH' : who);
    if (!res.ok) {
      setToast({ kind: 'error', text: res.error });
      return;
    }
    setToast({
      kind: 'ok',
      text: `Pencairan bagi hasil ${whoLabel} sebesar ${formatRp(total)} berhasil dicatat.`,
    });
  };

  const applySplit = async (teamVal: number) => {
    if (!isAdmin || !Number.isFinite(teamVal)) return;
    const team = Math.max(0, Math.min(100, Math.round(teamVal * 100) / 100));
    const coop = Math.round((100 - team) * 100) / 100;
    setTeamPctInput(String(team));
    const res = await updateProfitSplitPercentage(team, coop);
    if (!res.ok) {
      setToast({ kind: 'error', text: res.error });
      return;
    }
    setToast({
      kind: 'ok',
      text: `Porsi bagi hasil disimpan: Tim ${formatKgNum(team)}% : Koperasi ${formatKgNum(coop)}%.`,
    });
  };

  return (
    <section aria-label="Bagi Hasil" className="space-y-3.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-[20px] font-bold tracking-tight text-ink">Bagi Hasil</h1>
          <p className="text-[12px] text-muted">Pembagian margin Tim ({teamPct}%) dan Koperasi ({coopPct}%)</p>
        </div>
        <span className="inline-flex h-6 shrink-0 items-center rounded-[6px] border border-rule bg-white px-2.5 font-mono text-[11px] font-medium text-ink-2 tabular-nums">
          {teamPct}:{coopPct}
        </span>
      </div>

      <Toast toast={toast} onClose={() => setToast(null)} />

      <div className="space-y-3.5 lg:grid lg:grid-cols-12 lg:items-start lg:gap-4 lg:space-y-0">
        <div className="space-y-3.5 lg:col-span-5 lg:sticky lg:top-28">
          {/* Main Preline Ledger Card: Siap Dicairkan + Proportional Split Track */}
          <Card className="overflow-hidden">
        <div className="hs-card-header bg-paper-2">
          <span className="text-[14px] font-medium text-ink">Siap Dicairkan</span>
          <span className="text-[11px] text-muted">Dari invoice dapur yang sudah lunas</span>
        </div>

        <div className="space-y-3.5 p-4">
          <div className="text-[28px] font-bold leading-none tracking-tight tabular-nums text-ink">
            {formatRp(availTotal)}
          </div>

          {/* Preline Multi-Segment Progress Bar + Legend Indicators */}
          <div className="space-y-1.5">
            <div
              aria-hidden="true"
              className="flex h-2.5 w-full overflow-hidden rounded-[4px] bg-paper-3"
            >
              <div
                style={{ width: `${coopPct}%` }}
                className="h-full bg-accent"
              />
              <div
                style={{ width: `${teamPct}%` }}
                className="h-full border-l-2 border-white bg-ink-2"
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-muted tabular-nums">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-[2px] bg-accent" />
                Koperasi ({coopPct}%)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-[2px] bg-ink-2" />
                Tim ({teamPct}%)
              </span>
            </div>
          </div>

          <div className="divide-y divide-rule-2 border-y border-rule-2 py-1">
            <StatRow label={`Hak Koperasi (${coopPct}%)`} value={formatRp(availCoop)} strong />
            <StatRow label={`Hak Tim (${teamPct}%)`} value={formatRp(availTeam)} />
          </div>

          {isAdmin && (
            <div className="space-y-2 pt-0.5">
              {confirmPayoutWho ? (
                <div className="space-y-2 rounded-[6px] border border-rule bg-paper-2 p-3">
                  <p className="text-[12px] font-medium text-ink">
                    Cairkan bagi hasil{' '}
                    {confirmPayoutWho === 'ALL'
                      ? 'Tim & Koperasi'
                      : confirmPayoutWho === 'TEAM'
                        ? 'Tim'
                        : 'Koperasi'}{' '}
                    sebesar{' '}
                    <span className="font-bold tabular-nums">
                      {formatRp(
                        confirmPayoutWho === 'ALL'
                          ? availTotal
                          : confirmPayoutWho === 'TEAM'
                            ? availTeam
                            : availCoop
                      )}
                    </span>
                    ? Status akan dikunci permanen sebagai Sudah Cair.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={isSyncing}
                      onClick={() => void handlePayout(confirmPayoutWho)}
                      className="btn-primary min-h-[40px] px-3 text-[12px]"
                    >
                      Ya, Cairkan
                    </button>
                    <button
                      type="button"
                      disabled={isSyncing}
                      onClick={() => setConfirmPayoutWho(null)}
                      className="btn-secondary min-h-[40px] px-3 text-[12px]"
                    >
                      Batal
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={isSyncing || availCoop <= 0}
                      onClick={() => setConfirmPayoutWho('COOPERATIVE')}
                      className="btn-primary min-h-[40px] w-full px-2 text-[13px]"
                    >
                      Cairkan Koperasi
                    </button>
                    <button
                      type="button"
                      disabled={isSyncing || availTeam <= 0}
                      onClick={() => setConfirmPayoutWho('TEAM')}
                      className="btn-secondary min-h-[40px] w-full px-2 text-[13px]"
                    >
                      Cairkan Tim
                    </button>
                  </div>
                  <button
                    type="button"
                    disabled={isSyncing || availTeam <= 0 || availCoop <= 0}
                    onClick={() => setConfirmPayoutWho('ALL')}
                    className="btn-secondary min-h-[40px] w-full text-[12px]"
                  >
                    Cairkan Semua ({formatRp(availTotal)})
                  </button>
                </>
              )}
              {availTotal <= 0 && lockedTotal > 0 && (
                <p className="text-[11px] text-muted">
                  Tandai invoice sebagai Lunas di tab Invoice Dapur untuk membuka pencairan bagi hasil.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Preline Divided Secondary Strip: Menunggu Dapur Bayar & Total Sudah Dicairkan */}
        <div className="grid grid-cols-2 divide-x divide-rule border-t border-rule bg-paper-2">
          <div className="p-3.5">
            <div className="text-[11px] text-muted">Menunggu Dapur Bayar</div>
            <div className="mt-0.5 truncate text-[16px] font-bold tabular-nums text-ink">
              {formatRp(lockedTotal)}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] tabular-nums text-muted">
              <span>Koperasi {formatRp(lockedCoop)}</span>
              <span>Tim {formatRp(lockedTeam)}</span>
            </div>
          </div>
          <div className="p-3.5">
            <div className="text-[11px] text-muted">Sudah Dicairkan</div>
            <div className="mt-0.5 truncate text-[16px] font-bold tabular-nums text-ink">
              {formatRp(paidOutTotal)}
            </div>
            <div className="mt-0.5 text-[11px] tabular-nums text-muted">
              {payoutBatches.length} pencairan selesai
            </div>
          </div>
        </div>
      </Card>

      {/* Preline Accordion: Atur Porsi Bagi Hasil (Admin only) */}
      {isAdmin && (
        <details className="card group overflow-hidden">
          <summary className="flex min-h-[46px] cursor-pointer list-none items-center justify-between px-4 text-[14px] font-medium text-ink transition-colors hover:bg-paper-2">
            <span>Atur Porsi Bagi Hasil</span>
            <span className="flex items-center gap-2 text-[13px] tabular-nums text-muted">
              Tim {teamPct}% : Koperasi {coopPct}%
              <ChevronDownIcon className="h-4 w-4 text-muted transition-transform motion-reduce:transition-none group-open:rotate-180" />
            </span>
          </summary>
          <div className="space-y-3 border-t border-rule bg-paper-2 p-4">
            <div className="grid grid-cols-3 gap-2">
              {[60, 50, 70].map((t) => {
                const selected = Number(teamPctInput) === t;
                return (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setTeamPctInput(String(t))}
                    className={`btn-chip min-h-[36px] tabular-nums ${
                      selected ? '!border-accent !bg-accent !text-white' : ''
                    }`}
                  >
                    {t} : {100 - t}
                  </button>
                );
              })}
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <label htmlFor="split-team" className="mb-1 block text-[12px] font-medium text-muted">
                  Tim (%)
                </label>
                <input
                  id="split-team"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="100"
                  step="1"
                  value={teamPctInput}
                  onChange={(e) => setTeamPctInput(e.target.value)}
                  className="field-input text-right tabular-nums"
                />
              </div>
              <div className="flex-1">
                <span className="mb-1 block text-[12px] font-medium text-muted">Koperasi (%)</span>
                <div className="field-input flex items-center justify-end bg-paper-3 tabular-nums text-muted">
                  {formatKgNum(Math.max(0, 100 - (Number(teamPctInput) || 0)))}
                </div>
              </div>
              <button
                type="button"
                disabled={isSyncing}
                onClick={() => applySplit(Number(teamPctInput))}
                className="btn-primary"
              >
                Simpan
              </button>
            </div>
          </div>
        </details>
      )}

      {payoutBatches.length > 0 && (
        <details className="card group overflow-hidden">
          <summary className="flex min-h-[46px] cursor-pointer list-none items-center justify-between px-4 text-[14px] font-medium text-ink transition-colors hover:bg-paper-2">
            <span>Riwayat Pencairan ({payoutBatches.length})</span>
            <span className="flex items-center gap-2 text-[13px] tabular-nums text-muted">
              {formatRp(paidOutTotal)}
              <ChevronDownIcon className="h-4 w-4 text-muted transition-transform motion-reduce:transition-none group-open:rotate-180" />
            </span>
          </summary>
          <ul className="divide-y divide-rule-2 border-t border-rule">
            {payoutBatches.map((pb) => (
              <li key={pb.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-[13px]">
                <span className="flex min-w-0 items-center gap-x-2 truncate text-muted">
                  <span className="font-medium text-ink">
                    {pb.beneficiary_type === 'TEAM' ? 'Tim' : 'Koperasi'}
                  </span>
                  <span>{new Date(pb.disbursed_at).toLocaleDateString('id-ID')}</span>
                </span>
                <span className="shrink-0 font-bold tabular-nums text-ink">
                  {formatRp(pb.total_payout_amount)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
        </div>

        {/* Per-kitchen breakdown (Expandable Ledger Queue) */}
        <div className="space-y-3.5 lg:col-span-7">
          <div className="ledger-toolbar">
            <div className="hs-card-header bg-paper-2">
              <h2 className="text-[15px] font-medium text-ink">Rincian per Invoice Dapur</h2>
              <span className="inline-flex h-6 items-center rounded-[6px] border border-rule bg-white px-2 text-[11px] font-medium text-ink-2 tabular-nums">
                {filteredProfits.length} invoice
              </span>
            </div>
            <div className="space-y-2.5 p-3">
              <SegmentedControl
                label="Filter status bagi hasil"
                value={profitFilter}
                onChange={setProfitFilter}
                options={[
                  { value: 'all', label: `Semua (${invoiceProfits.length})` },
                  { value: 'avail', label: 'Siap Cair' },
                  { value: 'locked', label: 'Menunggu' },
                  { value: 'paid_out', label: 'Sudah Cair' },
                ]}
              />

              <SortGroupControls
                sortBy={sortBy}
                onSortChange={setSortBy}
                groupBy={groupBy}
                onGroupChange={setGroupBy}
                idPrefix="profit"
                allExpanded={allExpanded}
                onToggleExpandAll={toggleExpandAll}
                itemCount={filteredProfits.length}
              />
            </div>
          </div>

          {filteredProfits.length === 0 ? (
            <Card className="p-6 text-center text-[13px] text-muted">
              Tidak ada rincian bagi hasil pada filter ini.
            </Card>
          ) : (
            <div className="space-y-4">
              {groupedProfits.map((bucket) => {
                const bucketMargin = sumIdr(bucket.items.map((p) => p.profit.total_margin));
                return (
                  <div key={bucket.key} className="space-y-2.5">
                    {groupBy !== 'none' && (
                      <div className="flex items-center justify-between gap-2 rounded-[6px] border border-rule bg-group px-3 py-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          {bucket.sublabel && (
                            <span className="shrink-0 rounded-[4px] border border-control bg-white px-1.5 py-0.5 font-mono text-[11px] font-medium text-ink-2">
                              {bucket.sublabel}
                            </span>
                          )}
                          <span className="truncate text-[13px] font-bold text-ink">{bucket.label}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-2 text-right text-[11px] font-medium text-ink-2 tabular-nums">
                          <span>{bucket.items.length} invoice</span>
                          <span className="font-bold text-ink">{formatRp(bucketMargin)}</span>
                        </div>
                      </div>
                    )}

                    <Card as="section" className="overflow-hidden">
                      <ul className="divide-y divide-rule-2">
                        {bucket.items.map(({ inv, kitchen, profit }) => {
                          const teamStatus: LedgerPayoutStatus = profit.team_status;
                          const coopStatus: LedgerPayoutStatus = profit.coop_status;
                          const split = teamStatus !== coopStatus;
                          const isExpanded = expandedIds.has(inv.id);

                          return (
                            <li key={inv.id}>
                              <button
                                type="button"
                                aria-expanded={isExpanded}
                                onClick={() => toggleInvoiceRow(inv.id)}
                                className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-paper-2"
                              >
                                <div className="min-w-0">
                                  <div className="truncate text-[14px] font-medium text-ink">
                                    {kitchen ? `${kitchen.kitchen_code} — ${shortKitchenName(kitchen.name)}` : '-'}
                                  </div>
                                  <div className="flex flex-wrap items-center gap-x-2 truncate font-mono text-[11px] text-muted tabular-nums">
                                    <span>{inv.invoice_date}</span>
                                    <span>{inv.invoice_number}</span>
                                    <span>({formatKgNum(profit.total_accepted_kg)} kg)</span>
                                  </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-2">
                                  <div className="flex flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-2">
                                    <span className="text-[13px] font-bold tabular-nums text-ink">
                                      {formatRp(profit.total_margin)}
                                    </span>
                                    {!split && <Badge tone={payoutTone(coopStatus)}>{PAYOUT_LABEL[coopStatus]}</Badge>}
                                  </div>
                                  <ChevronDownIcon
                                    className={`h-4 w-4 shrink-0 text-muted transition-transform motion-reduce:transition-none ${
                                      isExpanded ? 'rotate-180' : ''
                                    }`}
                                  />
                                </div>
                              </button>
                              {isExpanded && (
                                <div className="px-4 pb-3.5">
                                  <div className="grid grid-cols-3 divide-x divide-rule rounded-[6px] border border-rule bg-paper-2 py-2 text-[12px]">
                                    <div className="min-w-0 px-2.5">
                                      <div className="truncate text-muted">Total Margin</div>
                                      <div className="mt-0.5 truncate font-bold tabular-nums text-ink">
                                        {formatRp(profit.total_margin)}
                                      </div>
                                    </div>
                                    <div className="min-w-0 px-2.5">
                                      <div className="truncate text-muted">Hak Tim</div>
                                      <div className="mt-0.5 truncate font-bold tabular-nums text-ink">
                                        {formatRp(profit.team_amount)}
                                      </div>
                                      {split && (
                                        <div className="mt-1">
                                          <Badge tone={payoutTone(teamStatus)}>{PAYOUT_LABEL[teamStatus]}</Badge>
                                        </div>
                                      )}
                                    </div>
                                    <div className="min-w-0 px-2.5 text-right">
                                      <div className="truncate text-muted">Hak Koperasi</div>
                                      <div className="mt-0.5 truncate font-bold tabular-nums text-signal">
                                        {formatRp(profit.coop_amount)}
                                      </div>
                                      {split && (
                                        <div className="mt-1">
                                          <Badge tone={payoutTone(coopStatus)}>{PAYOUT_LABEL[coopStatus]}</Badge>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </Card>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
