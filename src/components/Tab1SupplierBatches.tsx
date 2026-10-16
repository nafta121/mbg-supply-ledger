'use client';

import React, { useState } from 'react';
import { formatIdr, formatKg, useMbgStore } from '../lib/mbg-store';

export function Tab1SupplierBatches() {
  const {
    activeRole,
    suppliers,
    items,
    batches,
    deliveryItems,
    addSupplierBatch,
    getBatchRemainingKg,
    setActiveTab,
  } = useMbgStore();

  const [supplierId, setSupplierId] = useState<string>(suppliers[0]?.id ?? 'sup-a');
  const [itemId, setItemId] = useState<string>(items[0]?.id ?? 'item-ayam');
  const [qtyReceivedKg, setQtyReceivedKg] = useState<string>('125.500');
  const [actualCostPerKg, setActualCostPerKg] = useState<string>('36500');
  const [notes, setNotes] = useState<string>('');
  const [feedback, setFeedback] = useState<string | null>(null);

  if (activeRole === 'FIELD_TEAM' || activeRole === 'COOPERATIVE_VIEWER') {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-rose-500/40 bg-rose-950/40 p-4 text-rose-100 shadow-lg">
          <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-rose-300">
            <span>🔒 Proteksi Harga Modal (Invariant 5)</span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-rose-200/90">
            Role aktif Anda saat ini adalah <strong>{activeRole}</strong>. Sesuai Invariant 5, akses
            ke Harga Beli Aktual Supplier (<code>supplier_actual_cost_per_kg</code>) dan input Batch
            Pengadaan dikunci khusus untuk <strong>OWNER_ADMIN / FINANCE</strong>.
          </p>
          <button
            type="button"
            onClick={() => setActiveTab(activeRole === 'FIELD_TEAM' ? 'bast' : 'ledger')}
            className="mt-3 w-full rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-rose-500"
          >
            Buka Layar {activeRole === 'FIELD_TEAM' ? 'Timbang Terima BAST' : 'Ledger Koperasi'} →
          </button>
        </div>
      </div>
    );
  }

  const handleCreateBatch = (e: React.FormEvent) => {
    e.preventDefault();
    const qty = Number(qtyReceivedKg);
    const cost = Number(actualCostPerKg);
    if (!Number.isFinite(qty) || qty <= 0) {
      setFeedback('Error: Bobot barang masuk (kg) harus lebih dari 0.000 kg');
      return;
    }
    if (!Number.isFinite(cost) || cost <= 0) {
      setFeedback('Error: Harga beli aktual supplier (Rp/kg) harus lebih dari Rp 0');
      return;
    }

    addSupplierBatch({
      supplier_id: supplierId,
      item_id: itemId,
      qty_received_kg: qty,
      supplier_actual_cost_per_kg: cost,
      notes,
    });

    setNotes('');
    setFeedback(
      `✓ Batch pengadaan berhasil disimpan (${formatKg(qty)} @ ${formatIdr(cost)}/kg) dengan harga aktual terkunci.`
    );
  };

  return (
    <div className="space-y-4">
      {/* Invariant Banner */}
      <div className="rounded-2xl border border-emerald-500/30 bg-emerald-950/30 p-3.5 text-emerald-100">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-300">
            Invariant 1 & 3 • Actual Supplier Batch Costing
          </span>
          <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
            Presisi 0.001 kg
          </span>
        </div>
        <p className="mt-1 text-xs text-emerald-200/80">
          Setiap pengadaan dari Supplier dicatat per Batch dengan harga modal aktual (bukan rata-rata)
          dalam satuan dasar kilogram (<code>kg</code>).
        </p>
      </div>

      {/* Form Input Batch Baru */}
      <form
        onSubmit={handleCreateBatch}
        className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4 shadow-lg space-y-3.5"
      >
        <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
          <div>
            <h2 className="text-sm font-bold text-white">Input Batch Pengadaan Supplier</h2>
            <p className="text-[11px] text-slate-400">
              Catat bobot kirim supplier & kunci harga beli aktual per kg
            </p>
          </div>
          <span className="rounded-lg bg-indigo-500/20 px-2.5 py-1 text-[10px] font-bold text-indigo-300">
            H-0 Pengadaan
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3">
          <div>
            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
              Pilih Supplier Sumber Batch
            </label>
            <select
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none"
            >
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.supplier_code} — {s.name} ({s.bank_name})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
              Komoditas Bahan Baku (Satuan Dasar: kg)
            </label>
            <select
              value={itemId}
              onChange={(e) => setItemId(e.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none"
            >
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  [{item.sku}] {item.name} ({item.base_unit})
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                Bobot Masuk (<code>qty_received_kg</code>)
              </label>
              <div className="relative">
                <input
                  type="number"
                  step="0.001"
                  min="0.001"
                  value={qtyReceivedKg}
                  onChange={(e) => setQtyReceivedKg(e.target.value)}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 pr-10 text-xs font-mono text-white focus:border-emerald-500 focus:outline-none"
                  required
                />
                <span className="absolute right-3 top-2 text-[11px] font-bold text-emerald-400">
                  kg
                </span>
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                Harga Aktual / kg (IDR)
              </label>
              <div className="relative">
                <input
                  type="number"
                  step="50"
                  min="100"
                  value={actualCostPerKg}
                  onChange={(e) => setActualCostPerKg(e.target.value)}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-mono text-amber-300 focus:border-emerald-500 focus:outline-none"
                  required
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
              Catatan Batch / Keterangan Pengiriman
            </label>
            <input
              type="text"
              placeholder="Contoh: Pengiriman pagi pukul 04:30 WIB untuk 15 dapur"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Live Valuation Preview */}
        <div className="rounded-xl border border-slate-800 bg-slate-950/90 p-2.5 flex items-center justify-between text-xs">
          <span className="text-slate-400">Estimasi Nilai Kotor Batch:</span>
          <span className="font-mono font-bold text-emerald-400">
            {formatIdr((Number(qtyReceivedKg) || 0) * (Number(actualCostPerKg) || 0))}
          </span>
        </div>

        {feedback && (
          <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/60 px-3 py-2 text-[11px] text-emerald-200">
            {feedback}
          </div>
        )}

        <button
          type="submit"
          className="w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-bold text-white shadow-md transition hover:bg-emerald-500 active:scale-[0.99]"
        >
          + Simpan Batch Supplier & Kunci Harga Modal
        </button>
      </form>

      {/* Daftar Batch Supplier & Sisa Stok */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
            Daftar Batch Aktif & Sisa Stok ({batches.length})
          </h3>
          <button
            type="button"
            onClick={() => setActiveTab('matrix')}
            className="text-[11px] font-semibold text-emerald-400 hover:underline"
          >
            Alokasikan ke 25 Dapur →
          </button>
        </div>

        {batches.map((batch) => {
          const supplier = suppliers.find((s) => s.id === batch.supplier_id);
          const item = items.find((i) => i.id === batch.item_id);
          const remainingKg = getBatchRemainingKg(batch.id);
          const allocatedKg = Math.max(0, batch.qty_procured_kg - remainingKg);
          const allocatedCount = deliveryItems.filter(
            (di) => di.supplier_batch_id === batch.id
          ).length;
          const pctUsed =
            batch.qty_procured_kg > 0
              ? Math.min(100, Math.round((allocatedKg / batch.qty_procured_kg) * 100))
              : 0;

          return (
            <div
              key={batch.id}
              className="rounded-2xl border border-slate-800 bg-slate-900/80 p-3.5 shadow space-y-2.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="inline-block rounded-md bg-slate-800 px-2 py-0.5 font-mono text-[10px] font-bold text-emerald-300">
                    {batch.batch_code}
                  </span>
                  <h4 className="mt-1 text-xs font-bold text-white">
                    {item?.name ?? 'Komoditas'}
                  </h4>
                  <p className="text-[11px] text-slate-400">
                    Supplier: <strong className="text-slate-200">{supplier?.name}</strong> (
                    {supplier?.supplier_code})
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase text-slate-400">Harga Modal Aktual</div>
                  <div className="font-mono text-xs font-bold text-amber-300">
                    {formatIdr(batch.supplier_actual_cost_per_kg)}/kg
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 rounded-xl bg-slate-950/90 p-2.5 text-center">
                <div>
                  <div className="text-[10px] text-slate-400">Total Masuk</div>
                  <div className="font-mono text-xs font-bold text-white">
                    {formatKg(batch.qty_procured_kg)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-400">Dialokasikan</div>
                  <div className="font-mono text-xs font-bold text-sky-400">
                    {formatKg(allocatedKg)} ({allocatedCount} dapur)
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-400">Sisa Stok Batch</div>
                  <div
                    className={`font-mono text-xs font-bold ${
                      remainingKg > 0 ? 'text-emerald-400' : 'text-slate-500'
                    }`}
                  >
                    {formatKg(remainingKg)}
                  </div>
                </div>
              </div>

              {/* Progress bar */}
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] text-slate-400">
                  <span>Utilisasi Alokasi Dapur</span>
                  <span className="font-mono">{pctUsed}% teralokasi</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{ width: `${pctUsed}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
