'use client';

import React, { useState } from 'react';
import { formatIdr, formatKg, useMbgStore } from '../lib/mbg-store';
import { ArrowUpRightIcon, LockClosedIcon, PackageBatchIcon } from './Icons';

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
      <section aria-label="Peringatan Akses Terbatas" className="space-y-4">
        <div className="bezel-shell-rose">
          <div className="bezel-core-rose space-y-3 text-rose-100">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-rose-300">
              <LockClosedIcon className="h-4 w-4 text-rose-400" />
              <span>Proteksi Harga Modal (Invariant 5)</span>
            </div>
            <p className="text-xs leading-relaxed text-rose-200/90">
              Role aktif Anda saat ini adalah <strong>{activeRole}</strong>. Sesuai Invariant 5,
              akses ke Harga Beli Aktual Supplier (<code>supplier_actual_cost_per_kg</code>) dan
              input Batch Pengadaan dikunci khusus untuk <strong>OWNER_ADMIN / FINANCE</strong>.
            </p>
            <button
              type="button"
              onClick={() => setActiveTab(activeRole === 'FIELD_TEAM' ? 'bast' : 'ledger')}
              className="group flex min-h-[44px] w-full items-center justify-between rounded-full bg-rose-600 pl-5 pr-2 py-1.5 text-xs font-bold text-white transition-all duration-300 ease-spring hover:bg-rose-500 active:scale-[0.98]"
            >
              <span>
                Buka Layar {activeRole === 'FIELD_TEAM' ? 'Timbang Terima BAST' : 'Ledger Koperasi'}
              </span>
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/20 transition-transform duration-300 ease-spring group-hover:translate-x-0.5">
                <ArrowUpRightIcon className="h-4 w-4" />
              </span>
            </button>
          </div>
        </div>
      </section>
    );
  }

  const handleCreateBatch = (e: React.FormEvent) => {
    e.preventDefault();
    const qty = Number(qtyReceivedKg);
    const cost = Number(actualCostPerKg);
    if (!Number.isFinite(qty) || qty <= 0) {
      setFeedback('Error: Bobot barang masuk (kg) harus lebih dari 0.000 kg.');
      return;
    }
    if (!Number.isFinite(cost) || cost <= 0) {
      setFeedback('Error: Harga beli aktual supplier (Rp/kg) harus lebih dari Rp 0.');
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
      `Batch pengadaan berhasil disimpan (${formatKg(qty)} @ ${formatIdr(cost)}/kg) dengan harga aktual terkunci.`
    );
  };

  return (
    <section aria-label="Pengadaan Batch Supplier dan Harga Aktual" className="space-y-5">
      {/* Invariant Banner (Double-Bezel Emerald) */}
      <div className="bezel-shell-emerald">
        <div className="bezel-core-emerald space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-300">
              Invariant 1 & 3 • Actual Cost per Batch
            </span>
            <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-300 ring-1 ring-emerald-400/30">
              Presisi 0.001 kg
            </span>
          </div>
          <p className="text-xs leading-relaxed text-emerald-100/85">
            Setiap pengadaan dari Supplier dicatat per Batch dengan harga modal aktual (bukan
            rata-rata) dalam satuan dasar kilogram (<code>kg</code>).
          </p>
        </div>
      </div>

      {/* Form Input Batch Baru (Double-Bezel Hardware Card) */}
      <div className="bezel-shell">
        <form onSubmit={handleCreateBatch} className="bezel-core space-y-4">
          <div className="flex items-center justify-between border-b border-white/[0.07] pb-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
                <PackageBatchIcon className="h-4 w-4" />
              </div>
              <div>
                <h2 className="text-sm font-bold tracking-tight text-white">
                  Input Batch Pengadaan Supplier
                </h2>
                <p className="text-[11px] text-slate-400">
                  Catat bobot kirim supplier & kunci harga beli aktual per kg
                </p>
              </div>
            </div>
            <span className="rounded-full bg-white/[0.05] px-2.5 py-1 font-mono text-[10px] font-semibold text-slate-300 ring-1 ring-white/10">
              H-0
            </span>
          </div>

          <div className="space-y-3.5">
            <div>
              <label
                htmlFor="batch-supplier-select"
                className="mb-1.5 block text-xs font-semibold text-slate-200"
              >
                Pilih Supplier Sumber Batch
              </label>
              <select
                id="batch-supplier-select"
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                className="field-input"
              >
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.supplier_code} — {s.name} ({s.bank_name})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="batch-item-select"
                className="mb-1.5 block text-xs font-semibold text-slate-200"
              >
                Komoditas Bahan Baku (Satuan Dasar: kg)
              </label>
              <select
                id="batch-item-select"
                value={itemId}
                onChange={(e) => setItemId(e.target.value)}
                className="field-input"
              >
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    [{item.sku}] {item.name} ({item.base_unit})
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="batch-qty-input"
                  className="mb-1.5 block text-xs font-semibold text-slate-200"
                >
                  Bobot Masuk (<code>kg</code>)
                </label>
                <div className="relative">
                  <input
                    id="batch-qty-input"
                    type="number"
                    step="0.001"
                    min="0.001"
                    value={qtyReceivedKg}
                    onChange={(e) => setQtyReceivedKg(e.target.value)}
                    className="field-input pr-10 font-mono font-semibold"
                    required
                  />
                  <span className="pointer-events-none absolute right-3.5 top-3 font-mono text-xs font-bold text-emerald-400">
                    kg
                  </span>
                </div>
              </div>

              <div>
                <label
                  htmlFor="batch-cost-input"
                  className="mb-1.5 block text-xs font-semibold text-slate-200"
                >
                  Harga Aktual / kg (IDR)
                </label>
                <input
                  id="batch-cost-input"
                  type="number"
                  step="50"
                  min="100"
                  value={actualCostPerKg}
                  onChange={(e) => setActualCostPerKg(e.target.value)}
                  className="field-input font-mono font-semibold text-amber-300"
                  required
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="batch-notes-input"
                className="mb-1.5 block text-xs font-semibold text-slate-200"
              >
                Catatan Batch / Keterangan Pengiriman
              </label>
              <input
                id="batch-notes-input"
                type="text"
                placeholder="Contoh: Pengiriman pagi pukul 04:30 WIB untuk 15 dapur"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="field-input"
              />
            </div>
          </div>

          {/* Live Valuation Preview */}
          <div className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-[#070A10] px-3.5 py-3 text-xs">
            <span className="text-slate-400">Estimasi Nilai Kotor Batch:</span>
            <span className="font-mono text-sm font-bold text-emerald-400">
              {formatIdr((Number(qtyReceivedKg) || 0) * (Number(actualCostPerKg) || 0))}
            </span>
          </div>

          {feedback && (
            <div
              role="status"
              className="rounded-xl border border-emerald-500/40 bg-emerald-950/60 px-3.5 py-2.5 text-xs text-emerald-200"
            >
              {feedback}
            </div>
          )}

          {/* Button-in-Button Nested Pill CTA (high-end-visual-design) */}
          <button
            type="submit"
            className="group flex min-h-[46px] w-full items-center justify-between rounded-full bg-emerald-500 pl-5 pr-2 py-1.5 text-xs font-extrabold text-slate-950 shadow-[0_8px_24px_-6px_rgba(16,185,129,0.5)] transition-all duration-300 ease-spring hover:bg-emerald-400 active:scale-[0.98]"
          >
            <span>Simpan Batch Supplier & Kunci Harga Modal</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-950/15 transition-transform duration-300 ease-spring group-hover:translate-x-0.5 group-hover:scale-105">
              <ArrowUpRightIcon className="h-4 w-4 text-slate-950" />
            </span>
          </button>
        </form>
      </div>

      {/* Daftar Batch Supplier & Sisa Stok */}
      <div className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <h3 className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-slate-300">
            Stok Batch Aktif ({batches.length})
          </h3>
          <button
            type="button"
            onClick={() => setActiveTab('matrix')}
            className="inline-flex min-h-[36px] items-center gap-1 text-xs font-bold text-emerald-400 transition hover:text-emerald-300"
          >
            <span>Alokasikan ke 25 Dapur</span>
            <ArrowUpRightIcon className="h-3.5 w-3.5" />
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
            <article key={batch.id} className="bezel-shell">
              <div className="bezel-core space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="inline-block rounded-md bg-emerald-500/10 px-2 py-0.5 font-mono text-[11px] font-bold text-emerald-300 ring-1 ring-emerald-500/25">
                      {batch.batch_code}
                    </span>
                    <h4 className="mt-1.5 text-sm font-bold text-white">
                      {item?.name ?? 'Komoditas'}
                    </h4>
                    <p className="text-xs text-slate-400">
                      Supplier: <strong className="text-slate-200">{supplier?.name}</strong> (
                      {supplier?.supplier_code})
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
                      HPP Aktual
                    </div>
                    <div className="mt-0.5 font-mono text-xs font-bold text-amber-300">
                      {formatIdr(batch.supplier_actual_cost_per_kg)}/kg
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 rounded-xl border border-white/[0.05] bg-[#070A10] p-3 text-center">
                  <div>
                    <div className="text-[11px] text-slate-400">Total Masuk</div>
                    <div className="mt-0.5 font-mono text-xs font-bold text-white">
                      {formatKg(batch.qty_procured_kg)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-400">Teralokasi</div>
                    <div className="mt-0.5 font-mono text-xs font-bold text-slate-200">
                      {formatKg(allocatedKg)} ({allocatedCount})
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-400">Sisa Stok</div>
                    <div
                      className={`mt-0.5 font-mono text-xs font-bold ${
                        remainingKg > 0 ? 'text-emerald-400' : 'text-slate-500'
                      }`}
                    >
                      {formatKg(remainingKg)}
                    </div>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="space-y-1.5">
                  <div className="flex justify-between font-mono text-[11px] text-slate-400">
                    <span>Utilisasi Batch</span>
                    <span>{pctUsed}% teralokasi</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-[#070A10] ring-1 ring-white/[0.06]">
                    <div
                      className="h-full bg-emerald-500 transition-all duration-500 ease-spring"
                      style={{ width: `${pctUsed}%` }}
                    />
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
