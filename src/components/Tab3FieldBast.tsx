'use client';

import React, { useState } from 'react';
import { formatKg, useMbgStore } from '../lib/mbg-store';
import { CheckBadgeIcon, ScaleBastIcon } from './Icons';

export function Tab3FieldBast() {
  const {
    activeRole,
    getSafeBastItemsForFieldTeam,
    updateBastAcceptance,
    acceptFullBast,
  } = useMbgStore();

  const safeBastItems = getSafeBastItemsForFieldTeam();
  const isReadOnly = activeRole === 'COOPERATIVE_VIEWER';

  const [draftWeights, setDraftWeights] = useState<Record<string, string>>({});
  const [draftReasons, setDraftReasons] = useState<Record<string, string>>({});
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const totalDispatchedKg = safeBastItems.reduce((acc, i) => acc + i.qty_dispatched_kg, 0);
  const totalAcceptedKg = safeBastItems.reduce((acc, i) => acc + i.qty_accepted_kg, 0);
  const totalShrinkageKg = safeBastItems.reduce((acc, i) => acc + i.qty_shrinkage_kg, 0);

  const handleSaveBastItem = (
    deliveryItemId: string,
    dispatchedKg: number,
    currentAcceptedKg: number
  ) => {
    if (isReadOnly) return;
    const rawStr = draftWeights[deliveryItemId] ?? currentAcceptedKg.toFixed(3);
    const val = Number(rawStr);
    if (!Number.isFinite(val) || val < 0) {
      setStatusMsg('Error: Bobot diterima dapur tidak boleh negatif.');
      return;
    }
    if (val > dispatchedKg + 0.0001) {
      setStatusMsg(
        `Error Invariant 2: Bobot diterima (${formatKg(val)}) tidak boleh melebihi bobot kirim Surat Jalan (${formatKg(dispatchedKg)}).`
      );
      return;
    }

    const shrinkage = Math.max(0, Math.round((dispatchedKg - val) * 1000) / 1000);
    const reason =
      shrinkage > 0
        ? draftReasons[deliveryItemId] || 'Susut Air/Perjalanan saat timbang BAST di Dapur'
        : null;

    updateBastAcceptance({
      delivery_item_id: deliveryItemId,
      qty_accepted_kg: val,
      rejection_reason: reason,
    });

    setStatusMsg(
      shrinkage > 0
        ? `BAST disimpan: Diterima ${formatKg(val)}. Selisih susut ${formatKg(shrinkage)} otomatis memotong tagihan Supplier 100%.`
        : `BAST disimpan: Diterima utuh 100% (${formatKg(val)}) tanpa susut.`
    );
  };

  return (
    <section aria-label="Timbang Terima BAST Lapangan" className="space-y-5">
      {/* Banner Invariant 2 & 5 (Double-Bezel Amber) */}
      <div className="bezel-shell-amber">
        <div className="bezel-core-amber space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-amber-300">
              Invariant 2 & 5 • BAST Timbang Terima Dapur
            </span>
            <span className="rounded-full bg-amber-500/20 px-2.5 py-0.5 font-mono text-[10px] font-semibold text-amber-300 ring-1 ring-amber-400/30">
              Zero-Shrinkage Risk
            </span>
          </div>
          <p className="text-xs leading-relaxed text-amber-100/85">
            Seluruh informasi harga disembunyikan bagi Kurir/Tim Lapangan (
            <code>v_safe_delivery_items_bast</code>). Setiap gram penyusutan/reject di dapur{' '}
            <strong>100% memotong kewajiban bayar ke Supplier</strong>.
          </p>
        </div>
      </div>

      {/* Ringkasan Kuantitas Lapangan */}
      <div className="bezel-shell">
        <div className="bezel-core grid grid-cols-3 gap-2.5 p-3 text-center">
          <div className="rounded-xl border border-white/[0.05] bg-[#070A10] p-2.5">
            <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
              Total Kirim
            </div>
            <div className="mt-1 font-mono text-xs font-bold text-white">
              {formatKg(totalDispatchedKg)}
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.05] bg-[#070A10] p-2.5">
            <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
              Total Diterima
            </div>
            <div className="mt-1 font-mono text-xs font-bold text-emerald-400">
              {formatKg(totalAcceptedKg)}
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.05] bg-[#070A10] p-2.5">
            <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
              Susut / Klaim
            </div>
            <div className="mt-1 font-mono text-xs font-bold text-amber-400">
              {formatKg(totalShrinkageKg)}
            </div>
          </div>
        </div>
      </div>

      {statusMsg && (
        <div
          role={statusMsg.startsWith('Error') ? 'alert' : 'status'}
          className={`rounded-xl border px-3.5 py-2.5 text-xs ${
            statusMsg.startsWith('Error')
              ? 'border-rose-500/40 bg-rose-950/60 text-rose-200'
              : 'border-emerald-500/40 bg-emerald-950/60 text-emerald-200'
          }`}
        >
          {statusMsg}
        </div>
      )}

      {/* Kartu BAST per Pengiriman Dapur */}
      <div className="space-y-4">
        {safeBastItems.map((bast) => {
          const inputStr =
            draftWeights[bast.delivery_item_id] ?? bast.qty_accepted_kg.toFixed(3);
          const parsedAccepted = Number(inputStr);
          const liveAcceptedKg = Number.isFinite(parsedAccepted)
            ? parsedAccepted
            : bast.qty_accepted_kg;
          const liveShrinkageKg = Math.max(
            0,
            Math.round((bast.qty_dispatched_kg - liveAcceptedKg) * 1000) / 1000
          );

          const weightInputId = `bast-weight-${bast.delivery_item_id}`;
          const reasonInputId = `bast-reason-${bast.delivery_item_id}`;

          return (
            <article key={bast.delivery_item_id} className="bezel-shell">
              <div className="bezel-core space-y-3.5">
                <div className="flex items-start justify-between gap-2 border-b border-white/[0.07] pb-3">
                  <div className="flex items-start gap-2.5">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white/[0.05] text-emerald-400 ring-1 ring-white/10">
                      <ScaleBastIcon className="h-4 w-4" />
                    </div>
                    <div>
                      <span className="inline-block rounded bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] font-bold text-slate-200">
                        {bast.delivery_number}
                      </span>
                      <h3 className="mt-1 text-sm font-bold text-white">{bast.kitchen_name}</h3>
                      <p className="text-xs text-slate-400">
                        Komoditas: <strong className="text-slate-200">{bast.item_name}</strong> (
                        {bast.base_unit})
                      </p>
                    </div>
                  </div>

                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 font-mono text-[10px] font-bold ${
                      liveShrinkageKg > 0
                        ? 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/35'
                        : 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/35'
                    }`}
                  >
                    {liveShrinkageKg > 0
                      ? `Susut -${formatKg(liveShrinkageKg)}`
                      : 'Utuh 100%'}
                  </span>
                </div>

                {/* Perbandingan Bobot Kirim vs Bobot Terima */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-white/[0.06] bg-[#070A10] p-3">
                    <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
                      Bobot Kirim (SJ)
                    </div>
                    <div className="mt-1.5 font-mono text-sm font-bold text-white">
                      {formatKg(bast.qty_dispatched_kg)}
                    </div>
                  </div>

                  <div className="rounded-xl border border-emerald-500/25 bg-[#070A10] p-3">
                    <label
                      htmlFor={weightInputId}
                      className="block font-mono text-[10px] uppercase tracking-wider font-semibold text-emerald-300"
                    >
                      Bobot Terima (kg)
                    </label>
                    <input
                      id={weightInputId}
                      type="number"
                      step="0.001"
                      min="0"
                      max={bast.qty_dispatched_kg}
                      disabled={isReadOnly}
                      value={inputStr}
                      onChange={(e) =>
                        setDraftWeights((prev) => ({
                          ...prev,
                          [bast.delivery_item_id]: e.target.value,
                        }))
                      }
                      className="mt-1 min-h-[38px] w-full rounded-lg border border-slate-700 bg-[#0D131F] px-2.5 py-1 font-mono text-sm font-bold text-emerald-300 focus:border-emerald-500 disabled:opacity-60"
                    />
                  </div>
                </div>

                {/* Warning Badge if Shrinkage > 0 (Invariant 2) */}
                {liveShrinkageKg > 0 && (
                  <div className="rounded-xl border border-amber-500/40 bg-amber-950/35 p-3 space-y-2">
                    <div className="flex items-center justify-between text-xs font-bold text-amber-300">
                      <span>Susut / Reject Dapur Terdeteksi</span>
                      <span className="font-mono">-{formatKg(liveShrinkageKg)}</span>
                    </div>
                    <p className="text-xs leading-relaxed text-amber-100/90">
                      <strong>Zero-Shrinkage Risk (Invariant 2):</strong> Selisih{' '}
                      <span className="font-mono font-semibold">{formatKg(liveShrinkageKg)}</span>{' '}
                      ini <strong>100% memotong tagihan Supplier asal Batch</strong> dan tidak
                      mengurangi margin per kg Tim maupun Koperasi.
                    </p>
                    {!isReadOnly && (
                      <div>
                        <label htmlFor={reasonInputId} className="sr-only">
                          Alasan susut atau reject untuk {bast.kitchen_name}
                        </label>
                        <input
                          id={reasonInputId}
                          type="text"
                          placeholder="Alasan susut/reject (mis: Susut air perjalanan / Kemasan rusak)"
                          value={
                            draftReasons[bast.delivery_item_id] ??
                            bast.rejection_reason ??
                            ''
                          }
                          onChange={(e) =>
                            setDraftReasons((prev) => ({
                              ...prev,
                              [bast.delivery_item_id]: e.target.value,
                            }))
                          }
                          className="min-h-[40px] w-full rounded-lg border border-amber-500/40 bg-[#070A10] px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-amber-400"
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Tombol Pintas Lapangan */}
                {!isReadOnly && (
                  <div className="space-y-2.5 pt-1">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setDraftWeights((prev) => ({
                            ...prev,
                            [bast.delivery_item_id]: bast.qty_dispatched_kg.toFixed(3),
                          }));
                          acceptFullBast(bast.delivery_item_id);
                          setStatusMsg(
                            `${bast.kitchen_name}: Diterima 100% sesuai Surat Jalan (${formatKg(bast.qty_dispatched_kg)}).`
                          );
                        }}
                        className="min-h-[42px] flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-bold text-emerald-300 transition hover:bg-emerald-500/25 active:scale-[0.98]"
                      >
                        <CheckBadgeIcon className="h-4 w-4 shrink-0" />
                        <span>Terima 100% Sesuai Kirim ({formatKg(bast.qty_dispatched_kg)})</span>
                      </button>

                      <button
                        type="button"
                        aria-label={`Kurangi 0.500 kg untuk ${bast.kitchen_name}`}
                        onClick={() => {
                          const nextVal = Math.max(
                            0,
                            Math.round((liveAcceptedKg - 0.5) * 1000) / 1000
                          );
                          setDraftWeights((prev) => ({
                            ...prev,
                            [bast.delivery_item_id]: nextVal.toFixed(3),
                          }));
                        }}
                        className="min-h-[42px] rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-xs font-semibold text-amber-300 transition hover:bg-white/[0.08] active:scale-[0.98]"
                      >
                        -0.500 kg
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        handleSaveBastItem(
                          bast.delivery_item_id,
                          bast.qty_dispatched_kg,
                          bast.qty_accepted_kg
                        )
                      }
                      className="min-h-[44px] w-full rounded-full bg-white/[0.08] px-4 py-2 text-xs font-bold text-white ring-1 ring-white/15 transition-all duration-300 ease-spring hover:bg-emerald-500 hover:text-slate-950 hover:ring-emerald-400 active:scale-[0.98]"
                    >
                      Simpan Timbangan BAST Dapur Ini
                    </button>
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
