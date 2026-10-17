'use client';

import React, { useState } from 'react';
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
import { Badge, Card, NoAccess, StatRow, Toast, type ToastState } from './ui';

export function Tab5ProfitLedger() {
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

  if (activeRole === 'FIELD_TEAM') return <NoAccess />;

  const isAdmin = activeRole === 'OWNER_ADMIN' || activeRole === 'FINANCE';

  const sumBy = (status: LedgerPayoutStatus, who: BeneficiaryType) =>
    sumIdr(
      ledgerEntries
        .filter((le) => le.payout_status === status && le.beneficiary_type === who)
        .map((le) => le.profit_amount)
    );

  const availTeam = sumBy('AVAILABLE_FOR_PAYOUT', 'TEAM');
  const availCoop = sumBy('AVAILABLE_FOR_PAYOUT', 'COOPERATIVE');
  const availTotal = sumIdr([availTeam, availCoop]);
  const lockedTeam = sumBy('LOCKED_UNPAID', 'TEAM');
  const lockedCoop = sumBy('LOCKED_UNPAID', 'COOPERATIVE');
  const lockedTotal = sumIdr([lockedTeam, lockedCoop]);
  const paidOutTotal = sumIdr(payoutBatches.map((p) => p.total_payout_amount));

  const teamPct = splitConfig.team_share_pct;
  const coopPct = splitConfig.cooperative_share_pct;

  const BENEFICIARY_LABEL: Record<BeneficiaryType, string> = { TEAM: 'Tim', COOPERATIVE: 'Koperasi' };

  // Tim & Koperasi are disbursed independently — field transfers often happen on different days.
  const handlePayout = (who: BeneficiaryType | 'ALL') => {
    if (!isAdmin) return;
    const targets: BeneficiaryType[] = who === 'ALL' ? ['TEAM', 'COOPERATIVE'] : [who];
    const amounts = { TEAM: availTeam, COOPERATIVE: availCoop };
    const paid = targets.filter((t) => amounts[t] > 0);
    if (paid.length === 0) return;
    for (const t of paid) executePayout(t);
    const total = sumIdr(paid.map((t) => amounts[t]));
    const label = paid.map((t) => `Hak ${BENEFICIARY_LABEL[t]}`).join(' & ');
    setToast({ kind: 'ok', text: `${label} ${formatRp(total)} berhasil dicairkan.` });
  };

  const applySplit = (teamVal: number) => {
    if (!isAdmin || !Number.isFinite(teamVal)) return;
    const team = Math.max(0, Math.min(100, Math.round(teamVal * 100) / 100));
    const coop = Math.round((100 - team) * 100) / 100;
    setTeamPctInput(String(team));
    updateProfitSplitPercentage(team, coop);
    setToast({ kind: 'ok', text: `Porsi diubah: Tim ${team}% • Koperasi ${coop}%.` });
  };

  return (
    <section aria-label="Bagi Hasil" className="space-y-3">
      <Toast toast={toast} onClose={() => setToast(null)} />

      {/* Card 1: ready to pay out */}
      <Card className="space-y-2.5 border-emerald-300 p-3.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-emerald-800">Siap Dicairkan</h2>
          <span className="text-xs font-medium text-slate-500">Invoice lunas</span>
        </div>
        <div className="text-3xl font-extrabold tabular-nums tracking-tight text-slate-900">
          {formatRp(availTotal)}
        </div>
        <div className="space-y-1">
          <StatRow label={`Tim (${teamPct}%)`} value={formatRp(availTeam)} />
          <StatRow label={`Koperasi (${coopPct}%)`} value={formatRp(availCoop)} />
        </div>
        {isAdmin && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={availTeam <= 0}
                onClick={() => handlePayout('TEAM')}
                className="btn-primary min-h-[48px] w-full px-2 text-sm"
              >
                Cairkan Hak Tim
              </button>
              <button
                type="button"
                disabled={availCoop <= 0}
                onClick={() => handlePayout('COOPERATIVE')}
                className="btn-primary min-h-[48px] w-full px-2 text-sm"
              >
                Cairkan Hak Koperasi
              </button>
            </div>
            <button
              type="button"
              disabled={availTeam <= 0 || availCoop <= 0}
              onClick={() => handlePayout('ALL')}
              className="btn-secondary min-h-[40px] w-full text-xs"
            >
              Cairkan Semua ({formatRp(availTotal)})
            </button>
          </div>
        )}
      </Card>

      {/* Card 2: waiting for kitchens to pay */}
      <Card className="space-y-2.5 border-amber-300 p-3.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-amber-800">Menunggu Dapur Bayar</h2>
          <span className="text-xs font-medium text-slate-500">Tertahan</span>
        </div>
        <div className="text-2xl font-extrabold tabular-nums tracking-tight text-slate-900">
          {formatRp(lockedTotal)}
        </div>
        <div className="space-y-1">
          <StatRow label={`Tim (${teamPct}%)`} value={formatRp(lockedTeam)} />
          <StatRow label={`Koperasi (${coopPct}%)`} value={formatRp(lockedCoop)} />
        </div>
      </Card>

      {/* Split settings (collapsed) */}
      <details className="card group">
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between px-3.5 text-sm font-semibold text-slate-800">
          <span>Porsi Bagi Hasil</span>
          <span className="flex items-center gap-2 tabular-nums text-slate-600">
            {teamPct}% : {coopPct}%
            <span className="text-xs transition group-open:rotate-180" aria-hidden="true">
              ▾
            </span>
          </span>
        </summary>
        <div className="space-y-2.5 border-t border-slate-200 p-3.5">
          {isAdmin ? (
            <>
              <div className="grid grid-cols-3 gap-2">
                {[60, 50, 70].map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={teamPct === t}
                    onClick={() => applySplit(t)}
                    className={`btn-chip min-h-[40px] text-sm ${
                      teamPct === t ? '!border-emerald-600 !bg-emerald-50 !text-emerald-800' : ''
                    }`}
                  >
                    {t} : {100 - t}
                  </button>
                ))}
              </div>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label htmlFor="split-team" className="mb-1 block text-xs font-semibold text-slate-700">
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
                  <span className="mb-1 block text-xs font-semibold text-slate-700">Koperasi (%)</span>
                  <div className="field-input flex items-center justify-end bg-slate-50 tabular-nums text-slate-600">
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
            <p className="text-sm text-slate-600">
              Tim {teamPct}% • Koperasi {coopPct}%
            </p>
          )}
        </div>
      </details>

      {payoutBatches.length > 0 && (
        <details className="card group">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between px-3.5 text-sm font-semibold text-slate-800">
            <span>Riwayat Pencairan</span>
            <span className="flex items-center gap-2 tabular-nums text-slate-600">
              {formatRp(paidOutTotal)}
              <span className="text-xs transition group-open:rotate-180" aria-hidden="true">
                ▾
              </span>
            </span>
          </summary>
          <ul className="divide-y divide-slate-100 border-t border-slate-200">
            {payoutBatches.map((pb) => (
              <li key={pb.id} className="flex items-center justify-between gap-2 px-3.5 py-2 text-sm">
                <span className="min-w-0 truncate text-slate-700">
                  {pb.beneficiary_type === 'TEAM' ? 'Tim' : 'Koperasi'} •{' '}
                  {new Date(pb.disbursed_at).toLocaleDateString('id-ID')}
                </span>
                <span className="shrink-0 font-semibold tabular-nums text-slate-900">
                  {formatRp(pb.total_payout_amount)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Per-kitchen breakdown */}
      <Card as="section" className="overflow-hidden">
        <h2 className="border-b border-slate-200 px-3 py-2.5 text-sm font-bold text-slate-900">
          Rincian per Dapur ({invoices.length})
        </h2>
        <ul className="divide-y divide-slate-100">
          {invoices.map((inv) => {
            const kitchen = kitchens.find((k) => k.id === inv.kitchen_id);
            const entries = ledgerEntries.filter((le) => le.invoice_id === inv.id);
            const team = entries.find((e) => e.beneficiary_type === 'TEAM');
            const coop = entries.find((e) => e.beneficiary_type === 'COOPERATIVE');
            const markup = sumIdr([team?.profit_amount ?? 0, coop?.profit_amount ?? 0]);
            const teamStatus: LedgerPayoutStatus = team?.payout_status ?? 'LOCKED_UNPAID';
            const coopStatus: LedgerPayoutStatus = coop?.payout_status ?? teamStatus;
            const split = teamStatus !== coopStatus;

            return (
              <li key={inv.id} className="space-y-1.5 px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-slate-900">
                      {kitchen ? `${kitchen.kitchen_code} • ${shortKitchenName(kitchen.name)}` : '-'}
                    </div>
                    <div className="truncate text-xs text-slate-500 tabular-nums">
                      {formatKgNum(coop?.qty_accepted_kg ?? team?.qty_accepted_kg ?? 0)} kg
                    </div>
                  </div>
                  {!split && <Badge tone={payoutTone(coopStatus)}>{PAYOUT_LABEL[coopStatus]}</Badge>}
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div className="min-w-0">
                    <div className="truncate text-slate-500">Markup</div>
                    <div className="truncate font-semibold tabular-nums text-slate-900">
                      {formatRp(markup)}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-slate-500">Hak Tim</div>
                    <div className="truncate font-semibold tabular-nums text-slate-900">
                      {formatRp(team?.profit_amount ?? 0)}
                    </div>
                    {split && (
                      <div className="mt-1">
                        <Badge tone={payoutTone(teamStatus)}>{PAYOUT_LABEL[teamStatus]}</Badge>
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 text-right">
                    <div className="truncate text-slate-500">Hak Koperasi</div>
                    <div className="truncate font-semibold tabular-nums text-slate-900">
                      {formatRp(coop?.profit_amount ?? 0)}
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
      </Card>
    </section>
  );
}
