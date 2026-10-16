'use client';

import React, { useState } from 'react';
import { formatIdr, formatKg, useMbgStore } from '../lib/mbg-store';

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
      <div className="space-y-4">
        <div className="rounded-2xl border border-rose-500/40 bg-rose-950/40 p-4 text-rose-100 shadow-lg">
          <div className="text-sm font-bold uppercase tracking-wider text-rose-300">
            🔒 Proteksi Buku Besar Bagi Hasil (Invariant 5)
          </div>
          <p className="mt-2 text-xs leading-relaxed text-rose-200/90">
            Role <strong>FIELD_TEAM</strong> dilarang melihat nominal Markup maupun Buku Besar Bagi
            Hasil Tim & Koperasi.
          </p>
          <button
            type="button"
            onClick={() => setActiveTab('bast')}
            className="mt-3 w-full rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-rose-500"
          >
            Kembali ke Layar BAST Lapangan →
          </button>
        </div>
      </div>
    );
  }

  const isOwnerOrFinance = activeRole === 'OWNER_ADMIN' || activeRole === 'FINANCE';

  // Aggregate LOCKED_UNPAID vs AVAILABLE_FOR_PAYOUT vs PAID_OUT
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
      `✓ Porsi bagi hasil diperbarui menjadi Tim ${clampedTeam}% : Koperasi ${coopVal}% (Total 100%).`
    );
  };

  return (
    <div className="space-y-4">
      {/* Banner Invariant 4 */}
      <div className="rounded-2xl border border-emerald-500/30 bg-emerald-950/30 p-3.5 text-emerald-100">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-300">
            Invariant 4 • Strict Cash-Basis Profit Sharing
          </span>
          <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
            Tim {splitConfig.team_share_pct}% : Kop {splitConfig.cooperative_share_pct}%
          </span>
        </div>
        <p className="mt-1 text-xs text-emerald-200/80">
          Bagi hasil dihitung dari <code>qty_accepted_kg × (harga_dapur - hpp_batch)</code>. Dana{' '}
          <strong>dikunci (LOCKED_UNPAID)</strong> selama Dapur belum melunasi invoice, dan baru{' '}
          <strong>siap cair (AVAILABLE_FOR_PAYOUT)</strong> setelah Invoice berstatus{' '}
          <strong>PAID</strong>.
        </p>
      </div>

      {feedback && (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/70 px-3 py-2 text-xs text-emerald-200">
          {feedback}
        </div>
      )}

      {/* KARTU 1: SALDO TERTAHAN (LOCKED_UNPAID - MENUNGGU DAPUR BAYAR) */}
      <div className="rounded-2xl border-2 border-amber-500/40 bg-amber-950/25 p-4 shadow-lg space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2.5 py-0.5 text-[10px] font-bold text-amber-300">
              🔒 LOCKED_UNPAID
            </span>
            <h3 className="mt-1 text-sm font-extrabold text-amber-200">
              Saldo Tertahan (LOCKED_UNPAID - Menunggu Dapur Bayar)
            </h3>
            <p className="text-[11px] text-amber-200/75">
              Berasal dari Invoice Dapur berstatus UNPAID atau PARTIALLY_PAID. Tidak dapat dicairkan.
            </p>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase text-amber-300/80">Total Tertahan</div>
            <div className="font-mono text-sm font-extrabold text-amber-300">
              {formatIdr(lockedTotal)}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5 rounded-xl bg-slate-950/85 p-3">
          <div>
            <div className="text-[10px] uppercase text-slate-400">
              Hak Tim Tertahan ({splitConfig.team_share_pct}%)
            </div>
            <div className="mt-0.5 font-mono text-xs font-bold text-amber-300">
              {formatIdr(lockedTeam)}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-slate-400">
              Hak Koperasi Tertahan ({splitConfig.cooperative_share_pct}%)
            </div>
            <div className="mt-0.5 font-mono text-xs font-bold text-amber-300">
              {formatIdr(lockedCoop)}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            disabled
            className="cursor-not-allowed rounded-xl border border-amber-500/30 bg-slate-900/80 px-3 py-2 text-[11px] font-bold text-amber-400/60"
          >
            🔒 Pencairan Terkunci (Menunggu Pelunasan Dapur)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('invoices')}
            className="text-[11px] font-semibold text-amber-300 hover:underline"
          >
            Verifikasi Invoice →
          </button>
        </div>
      </div>

      {/* KARTU 2: SALDO SIAP CAIR (AVAILABLE_FOR_PAYOUT - INVOICE SUDAH PAID) */}
      <div className="rounded-2xl border-2 border-emerald-500/50 bg-emerald-950/30 p-4 shadow-lg space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-[10px] font-bold text-emerald-300">
              🔓 AVAILABLE_FOR_PAYOUT
            </span>
            <h3 className="mt-1 text-sm font-extrabold text-emerald-200">
              Saldo Siap Cair (AVAILABLE_FOR_PAYOUT - Invoice Sudah PAID)
            </h3>
            <p className="text-[11px] text-emerald-200/75">
              Kas dari Dapur MBG sudah masuk 100% dan siap ditransfer ke rekening Tim & Koperasi.
            </p>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase text-emerald-300/80">Total Siap Cair</div>
            <div className="font-mono text-sm font-extrabold text-emerald-400">
              {formatIdr(availableTotal)}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div className="rounded-xl border border-emerald-500/30 bg-slate-950/90 p-3 space-y-2">
            <div>
              <div className="text-[10px] uppercase text-slate-400">
                Hak Tim Siap Cair ({splitConfig.team_share_pct}%)
              </div>
              <div className="mt-0.5 font-mono text-xs font-extrabold text-emerald-400">
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
                    `✓ Pencairan Dana (Payout) Hak Tim sebesar ${formatIdr(availableTeam)} berhasil dieksekusi (PAID_OUT)!`
                  );
                }}
                className="w-full rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[11px] font-bold text-white shadow transition hover:bg-emerald-500 disabled:opacity-40"
              >
                💸 Cairkan Dana (Payout Tim)
              </button>
            )}
          </div>

          <div className="rounded-xl border border-emerald-500/30 bg-slate-950/90 p-3 space-y-2">
            <div>
              <div className="text-[10px] uppercase text-slate-400">
                Hak Koperasi Siap Cair ({splitConfig.cooperative_share_pct}%)
              </div>
              <div className="mt-0.5 font-mono text-xs font-extrabold text-emerald-400">
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
                    `✓ Pencairan Dana (Payout) Hak Koperasi sebesar ${formatIdr(availableCoop)} berhasil dieksekusi (PAID_OUT)!`
                  );
                }}
                className="w-full rounded-lg bg-teal-600 px-2.5 py-1.5 text-[11px] font-bold text-white shadow transition hover:bg-teal-500 disabled:opacity-40"
              >
                💸 Cairkan Dana (Payout Koperasi)
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Pengaturan Persentase Bagi Hasil (Tim % vs Koperasi %) */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-3.5 shadow space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-xs font-bold text-white">
              Pengaturan Porsi Bagi Hasil (Tim % vs Koperasi %)
            </h4>
            <p className="text-[11px] text-slate-400">
              Total wajib 100.00% tanpa selisih pembulatan Rp 0,01
            </p>
          </div>
          <span className="font-mono text-xs font-bold text-indigo-300">
            {splitConfig.team_share_pct}% : {splitConfig.cooperative_share_pct}%
          </span>
        </div>

        {isOwnerOrFinance ? (
          <div className="space-y-2.5">
            <div className="flex flex-wrap gap-1.5">
              {[
                { label: 'Standar 60% : 40%', team: 60 },
                { label: 'Seimbang 50% : 50%', team: 50 },
                { label: 'Operasional 70% : 30%', team: 70 },
              ].map((preset) => (
                <button
                  key={preset.team}
                  type="button"
                  onClick={() => handleApplySplit(preset.team)}
                  className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition ${
                    splitConfig.team_share_pct === preset.team
                      ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300'
                      : 'border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <div className="flex-1">
                <label className="block text-[10px] text-slate-400">Porsi Tim (%)</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={teamPctInput}
                  onChange={(e) => setTeamPctInput(e.target.value)}
                  className="mt-0.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-xs text-white"
                />
              </div>
              <div className="flex-1">
                <label className="block text-[10px] text-slate-400">Porsi Koperasi (%)</label>
                <input
                  type="text"
                  readOnly
                  value={`${Math.max(0, 100 - (Number(teamPctInput) || 0)).toFixed(2)}%`}
                  className="mt-0.5 w-full rounded-lg border border-slate-800 bg-slate-950/60 px-2.5 py-1.5 font-mono text-xs text-slate-400"
                />
              </div>
              <button
                type="button"
                onClick={() => handleApplySplit(Number(teamPctInput) || 60)}
                className="mt-4 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-500"
              >
                Simpan %
              </button>
            </div>
          </div>
        ) : (
          <div className="text-[11px] text-slate-400">
            Mode Koperasi (Read-Only): Konfigurasi aktif adalah{' '}
            <strong>Tim {splitConfig.team_share_pct}%</strong> dan{' '}
            <strong>Koperasi {splitConfig.cooperative_share_pct}%</strong>.
          </div>
        )}
      </div>

      {/* Riwayat Batch Pencairan (PAID_OUT) */}
      {payoutBatches.length > 0 && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-3.5 space-y-2.5">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-200">
              Riwayat Pencairan Selesai (PAID_OUT: {formatIdr(paidOutTotal)})
            </h4>
          </div>
          {payoutBatches.map((pb) => (
            <div
              key={pb.id}
              className="rounded-xl border border-slate-800 bg-slate-950 p-2.5 flex items-center justify-between text-xs"
            >
              <div>
                <div className="font-mono font-bold text-emerald-300">{pb.payout_reference}</div>
                <div className="text-[11px] text-slate-400">
                  Penerima: <strong>{pb.beneficiary_type}</strong> • {pb.notes}
                </div>
              </div>
              <div className="font-mono font-bold text-white">
                {formatIdr(pb.total_payout_amount)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Rincian Baris Buku Besar Bagi Hasil per Invoice Dapur */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-3.5 space-y-2.5">
        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-200">
          Rincian Ledger Bagi Hasil per Dapur ({invoices.length} Invoice)
        </h4>
        <div className="space-y-2">
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
                className="rounded-xl border border-slate-800 bg-slate-950/90 p-3 space-y-1.5 text-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white">{kitchen?.name}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ${
                      payoutStatus === 'AVAILABLE_FOR_PAYOUT'
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : payoutStatus === 'PAID_OUT'
                        ? 'bg-sky-500/20 text-sky-300'
                        : 'bg-amber-500/20 text-amber-300'
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

                <div className="grid grid-cols-3 gap-2 border-t border-slate-800/80 pt-1.5 text-[11px]">
                  <div>
                    <div className="text-[10px] text-slate-400">Gross Profit</div>
                    <div className="font-mono font-bold text-white">{formatIdr(totalMarkup)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-400">
                      Hak Tim ({teamEntry?.share_pct_snapshot ?? splitConfig.team_share_pct}%)
                    </div>
                    <div className="font-mono font-bold text-emerald-300">
                      {formatIdr(teamEntry?.profit_amount ?? 0)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] text-slate-400">
                      Hak Koperasi (
                      {coopEntry?.share_pct_snapshot ?? splitConfig.cooperative_share_pct}%)
                    </div>
                    <div className="font-mono font-bold text-teal-300">
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
  );
}
