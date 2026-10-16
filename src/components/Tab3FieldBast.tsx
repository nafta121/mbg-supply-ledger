'use client';

import React, { useState } from 'react';
import { formatKg, useMbgStore } from '../lib/mbg-store';

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

  const handleSaveBastItem = (deliveryItemId: string, dispatchedKg: number, currentAcceptedKg: number) => {
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
        ? `✓ BAST disimpan: Diterima ${formatKg(val)}. Selisih susut ${formatKg(shrinkage)} otomatis memotong tagihan Supplier 100%!`
        : `✓ BAST disimpan: Diterima utuh 100% (${formatKg(val)}) tanpa susut.`
    );
  };

  return (
    <div className="space-y-4">
      {/* Banner Invariant 2 & 5 */}
      <div className="rounded-2xl border border-amber-500/30 bg-amber-950/30 p-3.5 text-amber-100">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wider text-amber-300">
            Invariant 2 & 5 • BAST Timbang Terima Dapur
          </span>
          <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
            Zero-Shrinkage Risk
          </span>
        </div>
        <p className="mt-1 text-xs text-amber-200/85">
          Seluruh informasi harga disembunyikan bagi Kurir/Tim Lapangan (<code>v_safe_delivery_items_bast</code>).
          Setiap gram penyusutan/reject di dapur <strong>100% memotong kewajiban bayar ke Supplier</strong>.
        </p>
      </div>

      {/* Ringkasan Kuantitas Lapangan */}
      <div className="grid grid-cols-3 gap-2 rounded-2xl border border-slate-800 bg-slate-900/90 p-3 text-center shadow">
        <div className="rounded-xl bg-slate-950/80 p-2">
          <div className="text-[10px] uppercase text-slate-400">Total Kirim</div>
          <div className="mt-0.5 font-mono text-xs font-bold text-white">
            {formatKg(totalDispatchedKg)}
          </div>
        </div>
        <div className="rounded-xl bg-slate-950/80 p-2">
          <div className="text-[10px] uppercase text-slate-400">Total Diterima</div>
          <div className="mt-0.5 font-mono text-xs font-bold text-emerald-400">
            {formatKg(totalAcceptedKg)}
          </div>
        </div>
        <div className="rounded-xl bg-slate-950/80 p-2">
          <div className="text-[10px] uppercase text-slate-400">Susut / Klaim</div>
          <div className="mt-0.5 font-mono text-xs font-bold text-amber-400">
            {formatKg(totalShrinkageKg)}
          </div>
        </div>
      </div>

      {statusMsg && (
        <div
          className={`rounded-xl border px-3 py-2 text-xs ${
            statusMsg.startsWith('Error')
              ? 'border-rose-500/40 bg-rose-950/60 text-rose-200'
              : 'border-emerald-500/40 bg-emerald-950/60 text-emerald-200'
          }`}
        >
          {statusMsg}
        </div>
      )}

      {/* Kartu BAST per Pengiriman Dapur */}
      <div className="space-y-3">
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

          return (
            <div
              key={bast.delivery_item_id}
              className="rounded-2xl border border-slate-800 bg-slate-900/90 p-3.5 shadow-lg space-y-3"
            >
              <div className="flex items-start justify-between gap-2 border-b border-slate-800 pb-2.5">
                <div>
                  <span className="inline-block rounded bg-slate-800 px-2 py-0.5 font-mono text-[10px] font-bold text-sky-300">
                    {bast.delivery_number}
                  </span>
                  <h4 className="mt-1 text-xs font-bold text-white">{bast.kitchen_name}</h4>
                  <p className="text-[11px] text-slate-400">
                    Komoditas: <strong className="text-slate-200">{bast.item_name}</strong> (
                    {bast.base_unit})
                  </p>
                </div>

                <span
                  className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                    liveShrinkageKg > 0
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                      : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  }`}
                >
                  {liveShrinkageKg > 0
                    ? `Susut -${formatKg(liveShrinkageKg)}`
                    : '✓ Utuh 100%'}
                </span>
              </div>

              {/* Perbandingan Bobot Kirim vs Bobot Terima */}
              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-xl border border-slate-800 bg-slate-950 p-2.5">
                  <div className="text-[10px] uppercase text-slate-400">
                    Bobot Kirim (Surat Jalan)
                  </div>
                  <div className="mt-1 font-mono text-sm font-bold text-white">
                    {formatKg(bast.qty_dispatched_kg)}
                  </div>
                </div>

                <div className="rounded-xl border border-slate-700 bg-slate-950 p-2.5">
                  <label className="block text-[10px] uppercase font-semibold text-emerald-300">
                    Bobot Terima Dapur (kg)
                  </label>
                  <input
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
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-sm font-bold text-emerald-300 focus:border-emerald-500 focus:outline-none disabled:opacity-60"
                  />
                </div>
              </div>

              {/* Warning Badge if Shrinkage > 0 (Invariant 2) */}
              {liveShrinkageKg > 0 && (
                <div className="rounded-xl border border-amber-500/40 bg-amber-950/50 p-2.5 space-y-2">
                  <div className="flex items-center justify-between text-xs font-bold text-amber-300">
                    <span>⚠️ Susut / Reject Dapur Terdeteksi:</span>
                    <span className="font-mono">{formatKg(liveShrinkageKg)}</span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-amber-200/90">
                    <strong>Zero-Shrinkage Risk (Invariant 2):</strong> Selisih{' '}
                    <span className="font-mono font-semibold">{formatKg(liveShrinkageKg)}</span> ini{' '}
                    <strong>100% memotong tagihan Supplier asal Batch</strong> dan tidak mengurangi
                    margin per kg Tim maupun Koperasi.
                  </p>
                  {!isReadOnly && (
                    <input
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
                      className="w-full rounded-lg border border-amber-500/40 bg-slate-950 px-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:border-amber-400 focus:outline-none"
                    />
                  )}
                </div>
              )}

              {/* Tombol Pintas Lapangan */}
              {!isReadOnly && (
                <div className="space-y-2 pt-1">
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setDraftWeights((prev) => ({
                          ...prev,
                          [bast.delivery_item_id]: bast.qty_dispatched_kg.toFixed(3),
                        }));
                        acceptFullBast(bast.delivery_item_id);
                        setStatusMsg(
                          `✓ ${bast.kitchen_name}: Diterima 100% sesuai Surat Jalan (${formatKg(bast.qty_dispatched_kg)}).`
                        );
                      }}
                      className="flex-1 rounded-xl border border-emerald-500/40 bg-emerald-600/20 px-3 py-2 text-[11px] font-bold text-emerald-300 hover:bg-emerald-600/30"
                    >
                      ✓ Terima 100% Sesuai Kirim ({formatKg(bast.qty_dispatched_kg)})
                    </button>

                    <button
                      type="button"
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
                      className="rounded-xl border border-slate-700 bg-slate-800 px-2.5 py-2 font-mono text-[11px] font-semibold text-amber-300 hover:bg-slate-700"
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
                    className="w-full rounded-xl bg-sky-600 px-3 py-2 text-xs font-bold text-white shadow transition hover:bg-sky-500"
                  >
                    Simpan Timbangan BAST Dapur Ini
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
