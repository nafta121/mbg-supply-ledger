'use client';

import React, { useState } from 'react';
import { formatIdr, formatKg, useMbgStore } from '../lib/mbg-store';
import {
  ArrowUpRightIcon,
  CheckBadgeIcon,
  LedgerVaultIcon,
  LockClosedIcon,
  LockOpenIcon,
} from './Icons';

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
    setActiveTab,
  } = useMbgStore();

  const [teamPctInput, setTeamPctInput] = useState<string>(
    String(splitConfig.team_share_pct)
  );
  const [feedback, setFeedback] = useState<string | null>(null);

  if (activeRole === 'FIELD_TEAM') {
    return (
      <section aria-label="Akses Ledger Terbatas" className="space-y-4">
        <div className="bezel-shell-rose">
          <div className="bezel-core-rose space-y-3 text-rose-100">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-rose-300">
              <LockClosedIcon className="h-4 w-4 text-rose-400" />
              <span>Proteksi Buku Besar Bagi Hasil (Invariant 5)</span>
            </div>
            <p className="text-xs leading-relaxed text-rose-200/90">
              Role <strong>FIELD_TEAM</strong> dilarang melihat nominal Markup maupun Buku Besar
              Bagi Hasil Tim & Koperasi.
            </p>
            <button
              type="button"
              onClick={() => setActiveTab('bast')}
              className="group flex min-h-[44px] w-full items-center justify-between rounded-full bg-rose-600 pl-5 pr-2 py-1.5 text-xs font-bold text-white transition hover:bg-rose-500 active:scale-[0.98]"
            >
              <span>Kembali ke Layar BAST Lapangan</span>
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/20">
                <ArrowUpRightIcon className="h-4 w-4" />
              </span>
            </button>
          </div>
        </div>
      </section>
    );
  }

  const isOwnerOrFinance = activeRole === 'OWNER_ADMIN' || activeRole === 'FINANCE';

  const sumBy = (
    status: 'LOCKED_UNPAID' | 'AVAILABLE_FOR_PAYOUT' | 'PAID_OUT',
    beneficiary?: 'TEAM' | 'COOPERATIVE'
  ) => {
    return ledgerEntries
      .filter(
        (le) =>
          le.payout_status === status &&
          (beneficiary ? le.beneficiary_type === beneficiary : true)
      )
      .reduce((acc, le) => acc + le.profit_amount, 0);
  };

  const lockedTeam = sumBy('LOCKED_UNPAID', 'TEAM');
  const lockedCoop = sumBy('LOCKED_UNPAID', 'COOPERATIVE');
  const lockedTotal = lockedTeam + lockedCoop;

  const availableTeam = sumBy('AVAILABLE_FOR_PAYOUT', 'TEAM');
  const availableCoop = sumBy('AVAILABLE_FOR_PAYOUT', 'COOPERATIVE');
  const availableTotal = availableTeam + availableCoop;

  const paidOutTeam = sumBy('PAID_OUT', 'TEAM');
  const paidOutCoop = sumBy('PAID_OUT', 'COOPERATIVE');
  const paidOutTotal = paidOutTeam + paidOutCoop;

  const handleApplySplit = (teamVal: number) => {
    if (!isOwnerOrFinance) return;
    const clampedTeam = Math.max(0, Math.min(100, Math.round(teamVal * 100) / 100));
    const coopVal = Math.round((100 - clampedTeam) * 100) / 100;
    setTeamPctInput(String(clampedTeam));
    updateProfitSplitPercentage(clampedTeam, coopVal);
    setFeedback(
      `Porsi bagi hasil diperbarui menjadi Tim ${clampedTeam}% : Koperasi ${coopVal}% (Total 100%).`
    );
  };

  return (
    <section aria-label="Buku Besar Bagi Hasil Cash-Basis Tim dan Koperasi" className="space-y-5">
      {/* Banner Invariant 4 */}
      <div className="bezel-shell-emerald">
        <div className="bezel-core-emerald space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-300">
              Invariant 4 • Cash-Basis Profit Sharing
            </span>
            <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-300 ring-1 ring-emerald-400/30">
              Tim {splitConfig.team_share_pct}% : Kop {splitConfig.cooperative_share_pct}%
            </span>
          </div>
          <p className="text-xs leading-relaxed text-emerald-100/85">
            Bagi hasil dihitung dari <code>qty_accepted_kg × (harga_dapur - hpp_batch)</code>. Dana{' '}
            <strong>dikunci (LOCKED_UNPAID)</strong> selama Dapur belum melunasi invoice, dan baru{' '}
            <strong>siap cair (AVAILABLE_FOR_PAYOUT)</strong> setelah Invoice berstatus{' '}
            <strong>PAID</strong>.
          </p>
        </div>
      </div>

      {feedback && (
        <div
          role="status"
          className="rounded-xl border border-emerald-500/40 bg-emerald-950/70 px-3.5 py-2.5 text-xs text-emerald-200"
        >
          {feedback}
        </div>
      )}

      {/* KARTU 1: SALDO TERTAHAN (LOCKED_UNPAID - MENUNGGU DAPUR BAYAR) */}
      <div className="bezel-shell-amber">
        <div className="bezel-core-amber space-y-3.5">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/20 px-2.5 py-0.5 font-mono text-[10px] font-bold text-amber-300 ring-1 ring-amber-400/30">
                <LockClosedIcon className="h-3.5 w-3.5" />
                <span>LOCKED_UNPAID</span>
              </span>
              <h2 className="mt-1.5 text-sm font-extrabold tracking-tight text-amber-100">
                Saldo Tertahan (LOCKED_UNPAID - Menunggu Dapur Bayar)
              </h2>
              <p className="mt-0.5 text-xs text-amber-200/75">
                Berasal dari Invoice Dapur berstatus UNPAID atau PARTIALLY_PAID. Tidak dapat
                dicairkan.
              </p>
            </div>
            <div className="text-right">
              <div className="font-mono text-[10px] uppercase tracking-wider text-amber-300/80">
                Total Tertahan
              </div>
              <div className="mt-0.5 font-mono text-sm font-extrabold text-amber-300">
                {formatIdr(lockedTotal)}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-xl border border-amber-500/20 bg-[#070A10]/90 p-3.5">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
                Hak Tim ({splitConfig.team_share_pct}%)
              </div>
              <div className="mt-1 font-mono text-xs font-bold text-amber-300">
                {formatIdr(lockedTeam)}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
                Hak Koperasi ({splitConfig.cooperative_share_pct}%)
              </div>
              <div className="mt-1 font-mono text-xs font-bold text-amber-300">
                {formatIdr(lockedCoop)}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 pt-0.5">
            <button
              type="button"
              disabled
              className="min-h-[40px] cursor-not-allowed inline-flex items-center gap-1.5 rounded-xl border border-amber-500/25 bg-[#070A10]/80 px-3.5 py-2 text-xs font-bold text-amber-400/60"
            >
              <LockClosedIcon className="h-3.5 w-3.5" />
              <span>Pencairan Terkunci</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('invoices')}
              className="inline-flex min-h-[38px] items-center gap-1 text-xs font-bold text-amber-300 hover:text-amber-200"
            >
              <span>Verifikasi Invoice</span>
              <ArrowUpRightIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* KARTU 2: SALDO SIAP CAIR (AVAILABLE_FOR_PAYOUT - INVOICE SUDAH PAID) */}
      <div className="bezel-shell-emerald">
        <div className="bezel-core-emerald space-y-3.5">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/20 px-2.5 py-0.5 font-mono text-[10px] font-bold text-emerald-300 ring-1 ring-emerald-400/30">
                <LockOpenIcon className="h-3.5 w-3.5" />
                <span>AVAILABLE_FOR_PAYOUT</span>
              </span>
              <h2 className="mt-1.5 text-sm font-extrabold tracking-tight text-emerald-100">
                Saldo Siap Cair (AVAILABLE_FOR_PAYOUT - Invoice Sudah PAID)
              </h2>
              <p className="mt-0.5 text-xs text-emerald-200/75">
                Kas dari Dapur MBG sudah masuk 100% dan siap ditransfer ke rekening Tim & Koperasi.
              </p>
            </div>
            <div className="text-right">
              <div className="font-mono text-[10px] uppercase tracking-wider text-emerald-300/80">
                Total Siap Cair
              </div>
              <div className="mt-0.5 font-mono text-sm font-extrabold text-emerald-400">
                {formatIdr(availableTotal)}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-emerald-500/30 bg-[#070A10]/90 p-3.5 space-y-2.5">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
                  Hak Tim ({splitConfig.team_share_pct}%)
                </div>
                <div className="mt-1 font-mono text-xs font-extrabold text-emerald-400">
                  {formatIdr(availableTeam)}
                </div>
              </div>
              {isOwnerOrFinance && (
                <button
                  type="button"
                  disabled={availableTeam <= 0}
                  onClick={() => {
                    executePayout('TEAM');
                    setFeedback(
                      `Pencairan Dana (Payout) Hak Tim sebesar ${formatIdr(availableTeam)} berhasil dieksekusi (PAID_OUT).`
                    );
                  }}
                  className="min-h-[40px] w-full rounded-xl bg-emerald-500 px-3 py-2 text-xs font-extrabold text-slate-950 shadow transition hover:bg-emerald-400 active:scale-[0.98] disabled:opacity-40"
                >
                  Cairkan Dana (Payout Tim)
                </button>
              )}
            </div>

            <div className="rounded-xl border border-emerald-500/30 bg-[#070A10]/90 p-3.5 space-y-2.5">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
                  Hak Koperasi ({splitConfig.cooperative_share_pct}%)
                </div>
                <div className="mt-1 font-mono text-xs font-extrabold text-emerald-400">
                  {formatIdr(availableCoop)}
                </div>
              </div>
              {isOwnerOrFinance && (
                <button
                  type="button"
                  disabled={availableCoop <= 0}
                  onClick={() => {
                    executePayout('COOPERATIVE');
                    setFeedback(
                      `Pencairan Dana (Payout) Hak Koperasi sebesar ${formatIdr(availableCoop)} berhasil dieksekusi (PAID_OUT).`
                    );
                  }}
                  className="min-h-[40px] w-full rounded-xl border border-emerald-400/50 bg-emerald-500/20 px-3 py-2 text-xs font-bold text-emerald-200 transition hover:bg-emerald-500 hover:text-slate-950 active:scale-[0.98] disabled:opacity-40"
                >
                  Cairkan Dana (Payout Koperasi)
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Pengaturan Persentase Bagi Hasil (Tim % vs Koperasi %) */}
      <div className="bezel-shell">
        <div className="bezel-core space-y-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
                <LedgerVaultIcon className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-white">
                  Pengaturan Porsi Bagi Hasil (Tim % vs Koperasi %)
                </h3>
                <p className="text-[11px] text-slate-400">
                  Total wajib 100.00% tanpa selisih pembulatan Rp 0,01
                </p>
              </div>
            </div>
            <span className="font-mono text-xs font-bold text-emerald-300">
              {splitConfig.team_share_pct}% : {splitConfig.cooperative_share_pct}%
            </span>
          </div>

          {isOwnerOrFinance ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {[
                  { label: 'Standar 60% : 40%', team: 60 },
                  { label: 'Seimbang 50% : 50%', team: 50 },
                  { label: 'Operasional 70% : 30%', team: 70 },
                ].map((preset) => (
                  <button
                    key={preset.team}
                    type="button"
                    onClick={() => handleApplySplit(preset.team)}
                    className={`min-h-[38px] rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${
                      splitConfig.team_share_pct === preset.team
                        ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-300'
                        : 'border-white/10 bg-[#070A10] text-slate-300 hover:bg-white/[0.06]'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              <div className="flex items-end gap-2.5">
                <div className="flex-1">
                  <label
                    htmlFor="split-team-pct-input"
                    className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-slate-400"
                  >
                    Porsi Tim (%)
                  </label>
                  <input
                    id="split-team-pct-input"
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={teamPctInput}
                    onChange={(e) => setTeamPctInput(e.target.value)}
                    className="min-h-[40px] w-full rounded-xl border border-slate-700 bg-[#070A10] px-3 py-1.5 font-mono text-xs font-bold text-white"
                  />
                </div>
                <div className="flex-1">
                  <label
                    htmlFor="split-coop-pct-readonly"
                    className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-slate-400"
                  >
                    Porsi Koperasi (%)
                  </label>
                  <input
                    id="split-coop-pct-readonly"
                    type="text"
                    readOnly
                    value={`${Math.max(0, 100 - (Number(teamPctInput) || 0)).toFixed(2)}%`}
                    className="min-h-[40px] w-full rounded-xl border border-white/[0.06] bg-[#070A10]/60 px-3 py-1.5 font-mono text-xs text-slate-400"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => handleApplySplit(Number(teamPctInput) || 60)}
                  className="min-h-[40px] rounded-xl bg-emerald-500 px-4 py-2 text-xs font-extrabold text-slate-950 transition hover:bg-emerald-400"
                >
                  Simpan %
                </button>
              </div>
            </div>
          ) : (
            <div className="text-xs text-slate-400">
              Mode Koperasi (Read-Only): Konfigurasi aktif adalah{' '}
              <strong className="text-white">Tim {splitConfig.team_share_pct}%</strong> dan{' '}
              <strong className="text-white">
                Koperasi {splitConfig.cooperative_share_pct}%
              </strong>
              .
            </div>
          )}
        </div>
      </div>

      {/* Riwayat Batch Pencairan (PAID_OUT) */}
      {payoutBatches.length > 0 && (
        <div className="bezel-shell">
          <div className="bezel-core space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-slate-200">
                Riwayat Pencairan Selesai (PAID_OUT: {formatIdr(paidOutTotal)})
              </h3>
            </div>
            {payoutBatches.map((pb) => (
              <div
                key={pb.id}
                className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-[#070A10] p-3 text-xs"
              >
                <div>
                  <div className="inline-flex items-center gap-1.5 font-mono font-bold text-emerald-300">
                    <CheckBadgeIcon className="h-3.5 w-3.5" />
                    <span>{pb.payout_reference}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-400">
                    Penerima: <strong className="text-slate-200">{pb.beneficiary_type}</strong> •{' '}
                    {pb.notes}
                  </div>
                </div>
                <div className="font-mono font-bold text-white">
                  {formatIdr(pb.total_payout_amount)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Rincian Baris Buku Besar Bagi Hasil per Invoice Dapur */}
      <div className="bezel-shell">
        <div className="bezel-core space-y-3">
          <h3 className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-slate-200">
            Rincian Ledger Bagi Hasil per Dapur ({invoices.length} Invoice)
          </h3>
          <div className="space-y-2.5">
            {invoices.map((inv) => {
              const kitchen = kitchens.find((k) => k.id === inv.kitchen_id);
              const entries = ledgerEntries.filter((le) => le.invoice_id === inv.id);
              const teamEntry = entries.find((e) => e.beneficiary_type === 'TEAM');
              const coopEntry = entries.find((e) => e.beneficiary_type === 'COOPERATIVE');
              const totalMarkup =
                (teamEntry?.profit_amount ?? 0) + (coopEntry?.profit_amount ?? 0);
              const payoutStatus = coopEntry?.payout_status ?? 'LOCKED_UNPAID';

              return (
                <div
                  key={inv.id}
                  className="rounded-xl border border-white/[0.06] bg-[#070A10] p-3.5 space-y-2 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-white">{kitchen?.name}</span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] font-bold ${
                        payoutStatus === 'AVAILABLE_FOR_PAYOUT'
                          ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/35'
                          : payoutStatus === 'PAID_OUT'
                          ? 'bg-white/10 text-slate-200 ring-1 ring-white/20'
                          : 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/35'
                      }`}
                    >
                      {payoutStatus}
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span>
                      {inv.invoice_number} ({inv.payment_status}) • Terima:{' '}
                      <strong className="font-mono text-slate-200">
                        {formatKg(coopEntry?.qty_accepted_kg ?? 0)}
                      </strong>
                    </span>
                    <span className="font-mono text-slate-300">
                      Markup/kg: {formatIdr(coopEntry?.unit_markup_snapshot ?? 0)}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 border-t border-white/[0.06] pt-2 text-[11px]">
                    <div>
                      <div className="font-mono text-[10px] uppercase text-slate-400">
                        Gross Profit
                      </div>
                      <div className="mt-0.5 font-mono font-bold text-white">
                        {formatIdr(totalMarkup)}
                      </div>
                    </div>
                    <div>
                      <div className="font-mono text-[10px] uppercase text-slate-400">
                        Hak Tim ({teamEntry?.share_pct_snapshot ?? splitConfig.team_share_pct}%)
                      </div>
                      <div className="mt-0.5 font-mono font-bold text-emerald-300">
                        {formatIdr(teamEntry?.profit_amount ?? 0)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-[10px] uppercase text-slate-400">
                        Hak Koperasi (
                        {coopEntry?.share_pct_snapshot ?? splitConfig.cooperative_share_pct}%)
                      </div>
                      <div className="mt-0.5 font-mono font-bold text-emerald-400">
                        {formatIdr(coopEntry?.profit_amount ?? 0)}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
