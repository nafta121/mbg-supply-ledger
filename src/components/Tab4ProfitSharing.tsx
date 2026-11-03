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
import { Badge, Card, NoAccess, StatRow, Toast, type ToastState } from './ui';

export function Tab4ProfitSharing() {
  const {
    activeRole,
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

  if (activeRole === 'FIELD_TEAM') return <NoAccess />;

  const isAdmin = activeRole === 'OWNER_ADMIN' || activeRole === 'FINANCE';

  const teamPct = splitConfig.team_share_pct;
  const coopPct = splitConfig.cooperative_share_pct;

  const BENEFICIARY_LABEL: Record<BeneficiaryType, string> = { TEAM: 'Tim', COOPERATIVE: 'Koperasi' };

  const handlePayout = async (who: BeneficiaryType | 'ALL') => {
    if (!isAdmin) return;
    const total = who === 'ALL' ? availTotal : who === 'TEAM' ? availTeam : availCoop;
    if (total <= 0) return;
    const res = await executePayout(who === 'ALL' ? 'BOTH' : who);
    if (!res.ok) {
      setToast({ kind: 'error', text: res.error });
      return;
    }
    const label = who === 'ALL' ? 'Hak Tim & Hak Koperasi' : `Hak ${BENEFICIARY_LABEL[who]}`;
    setToast({ kind: 'ok', text: `${label} ${formatRp(total)} berhasil dicairkan.` });
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
    setToast({ kind: 'ok', text: `Porsi diubah: Tim ${team}% · Koperasi ${coop}%.` });
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
                className="h-full bg-signal"
              />
              <div
                style={{ width: `${teamPct}%` }}
                className="h-full border-l-2 border-white bg-accent"
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-muted tabular-nums">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-[2px] bg-signal" />
                Koperasi ({coopPct}%)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-[2px] bg-accent" />
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
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={availCoop <= 0}
                  onClick={() => handlePayout('COOPERATIVE')}
                  className="btn-primary min-h-[40px] w-full px-2 text-[13px]"
                >
                  Cairkan Koperasi
                </button>
                <button
                  type="button"
                  disabled={availTeam <= 0}
                  onClick={() => handlePayout('TEAM')}
                  className="btn-secondary min-h-[40px] w-full px-2 text-[13px]"
                >
                  Cairkan Tim
                </button>
              </div>
              <button
                type="button"
                disabled={availTeam <= 0 || availCoop <= 0}
                onClick={() => handlePayout('ALL')}
                className="btn-secondary min-h-[36px] w-full text-[12px]"
              >
                Cairkan Semua ({formatRp(availTotal)})
              </button>
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
            <div className="mt-0.5 text-[11px] tabular-nums text-muted">
              Koperasi {formatRp(lockedCoop)} · Tim {formatRp(lockedTeam)}
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

      {/* Preline Accordion: Atur Porsi Bagi Hasil */}
      <details className="card group overflow-hidden">
        <summary className="flex min-h-[46px] cursor-pointer list-none items-center justify-between px-4 text-[14px] font-medium text-ink transition-colors hover:bg-paper-2">
          <span>Atur Porsi Bagi Hasil</span>
          <span className="flex items-center gap-2 text-[13px] tabular-nums text-muted">
            Tim {teamPct}% : Koperasi {coopPct}%
            <ChevronDownIcon className="h-4 w-4 text-muted transition-transform motion-reduce:transition-none group-open:rotate-180" />
          </span>
        </summary>
        <div className="space-y-3 border-t border-rule bg-paper-2 p-4">
          {isAdmin ? (
            <>
              <div className="grid grid-cols-3 gap-2">
                {[60, 50, 70].map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={teamPct === t}
                    onClick={() => applySplit(t)}
                    className={`btn-chip min-h-[36px] tabular-nums ${
                      teamPct === t ? '!border-accent !bg-accent !text-white' : ''
                    }`}
                  >
                    {t} : {100 - t}
                  </button>
                ))}
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
                    {Math.max(0, 100 - (Number(teamPctInput) || 0)).toFixed(2)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => applySplit(Number(teamPctInput))}
                  className="btn-primary"
                >
                  Simpan
                </button>
              </div>
            </>
          ) : (
            <p className="text-[13px] text-muted">
              Tim {teamPct}% · Koperasi {coopPct}%
            </p>
          )}
        </div>
      </details>

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
                <span className="min-w-0 truncate text-muted">
                  <span className="font-medium text-ink">
                    {pb.beneficiary_type === 'TEAM' ? 'Tim' : 'Koperasi'}
                  </span>{' '}
                  · {new Date(pb.disbursed_at).toLocaleDateString('id-ID')}
                </span>
                <span className="shrink-0 font-bold tabular-nums text-ink">
                  {formatRp(pb.total_payout_amount)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Per-kitchen breakdown */}
      <Card as="section" className="overflow-hidden">
        <div className="hs-card-header bg-paper-2">
          <h2 className="text-[14px] font-medium text-ink">Rincian per Invoice Dapur</h2>
          <span className="inline-flex h-6 items-center rounded-[6px] border border-rule bg-white px-2 text-[11px] font-medium text-ink-2 tabular-nums">
            {invoices.length} invoice
          </span>
        </div>
        {invoices.length === 0 ? (
          <div className="p-6 text-center text-[13px] text-muted">Belum ada rincian bagi hasil.</div>
        ) : (
          <ul className="divide-y divide-rule-2">
            {invoiceProfits.map(({ inv, kitchen, profit }) => {
              const teamStatus: LedgerPayoutStatus = profit.team_status;
              const coopStatus: LedgerPayoutStatus = profit.coop_status;
              const split = teamStatus !== coopStatus;

              return (
                <li key={inv.id} className="space-y-2.5 px-4 py-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-[14px] font-medium text-ink">
                        {kitchen ? `${kitchen.kitchen_code} · ${shortKitchenName(kitchen.name)}` : '-'}
                      </div>
                      <div className="truncate text-[11px] text-muted tabular-nums">
                        <span className="font-mono">{inv.invoice_number}</span> · {formatKgNum(profit.total_accepted_kg)} kg
                      </div>
                    </div>
                    {!split && <Badge tone={payoutTone(coopStatus)}>{PAYOUT_LABEL[coopStatus]}</Badge>}
                  </div>
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
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}
