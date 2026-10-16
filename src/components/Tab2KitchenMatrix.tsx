'use client';

import React, { useMemo, useState } from 'react';
import { formatIdr, formatKg, useMbgStore } from '../lib/mbg-store';
import { ArrowUpRightIcon, LockClosedIcon, MatrixGridIcon } from './Icons';

export function Tab2KitchenMatrix() {
  const {
    activeRole,
    kitchens,
    batches,
    suppliers,
    items,
    deliveryItems,
    deliveries,
    splitConfig,
    allocateBatchToKitchens,
    getBatchRemainingKg,
    setActiveTab,
  } = useMbgStore();

  const defaultBatch =
    batches.find((b) => getBatchRemainingKg(b.id) > 0) ?? batches[0];

  const [selectedBatchId, setSelectedBatchId] = useState<string>(
    defaultBatch?.id ?? 'batch-sup-c-telur'
  );
  const selectedBatch =
    batches.find((b) => b.id === selectedBatchId) ?? batches[0];

  const [markupPerKg, setMarkupPerKg] = useState<string>('3500');
  const [gridValues, setGridValues] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [message, setMessage] = useState<string | null>(null);

  const isFieldTeam = activeRole === 'FIELD_TEAM';
  const isReadOnly = activeRole !== 'OWNER_ADMIN' && activeRole !== 'FINANCE';

  const supplierCost = selectedBatch?.supplier_actual_cost_per_kg ?? 0;
  const markupNum = Math.max(0, Number(markupPerKg) || 0);
  const kitchenUnitPrice = supplierCost + markupNum;

  const remainingBatchKg = selectedBatch ? getBatchRemainingKg(selectedBatch.id) : 0;

  const totalDraftAllocatedKg = useMemo(() => {
    return Object.values(gridValues).reduce((acc, v) => {
      const n = Number(v);
      return acc + (Number.isFinite(n) && n > 0 ? n : 0);
    }, 0);
  }, [gridValues]);

  const activeKitchenCount = useMemo(() => {
    return Object.values(gridValues).filter((v) => Number(v) > 0).length;
  }, [gridValues]);

  const filteredKitchens = useMemo(() => {
    if (!searchQuery.trim()) return kitchens;
    const q = searchQuery.toLowerCase();
    return kitchens.filter(
      (k) =>
        k.name.toLowerCase().includes(q) ||
        k.kitchen_code.toLowerCase().includes(q) ||
        k.pic_name.toLowerCase().includes(q)
    );
  }, [kitchens, searchQuery]);

  const handleQuickFill = (startIdx: number, endIdx: number, kgVal: string) => {
    if (isReadOnly) return;
    const next: Record<string, string> = { ...gridValues };
    kitchens.slice(startIdx, endIdx).forEach((k) => {
      next[k.id] = kgVal;
    });
    setGridValues(next);
    setMessage(null);
  };

  const handleStepKitchenKg = (kitchenId: string, deltaKg: number) => {
    if (isReadOnly) return;
    const curr = Number(gridValues[kitchenId] || 0);
    const nextVal = Math.max(0, Math.round((curr + deltaKg) * 1000) / 1000);
    setGridValues((prev) => ({
      ...prev,
      [kitchenId]: nextVal > 0 ? nextVal.toFixed(3) : '',
    }));
  };

  const handleSaveMatrixAllocations = () => {
    if (!selectedBatch || isReadOnly) return;
    if (totalDraftAllocatedKg <= 0) {
      setMessage('Error: Masukkan alokasi bobot (kg) minimal pada 1 dapur MBG.');
      return;
    }
    if (totalDraftAllocatedKg > remainingBatchKg + 0.0001) {
      setMessage(
        `Error: Total alokasi (${formatKg(totalDraftAllocatedKg)}) melebihi sisa stok batch (${formatKg(remainingBatchKg)}).`
      );
      return;
    }

    const allocations = Object.entries(gridValues)
      .map(([kitchen_id, val]) => ({
        kitchen_id,
        qty_dispatched_kg: Number(val),
      }))
      .filter((a) => Number.isFinite(a.qty_dispatched_kg) && a.qty_dispatched_kg > 0);

    allocateBatchToKitchens({
      supplier_batch_id: selectedBatch.id,
      kitchen_unit_price_per_kg: kitchenUnitPrice,
      allocations,
    });

    setGridValues({});
    setMessage(
      `Berhasil menerbitkan ${allocations.length} Surat Jalan & mengunci Snapshot Harga ke Dapur MBG.`
    );
  };

  const batchSupplier = suppliers.find((s) => s.id === selectedBatch?.supplier_id);
  const batchItem = items.find((i) => i.id === selectedBatch?.item_id);

  return (
    <section aria-label="Matriks Alokasi 25 Dapur MBG" className="space-y-5">
      {/* Header Matrix Info (Double-Bezel Emerald) */}
      <div className="bezel-shell-emerald">
        <div className="bezel-core-emerald space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-300">
              Matriks Cepat 25 Dapur (SPPG 01–25)
            </span>
            <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-300 ring-1 ring-emerald-400/30">
              {isFieldTeam
                ? 'Mode Gudang (Tanpa Harga)'
                : isReadOnly
                ? 'Mode Pantau Koperasi'
                : 'Snapshot Harga Aktif'}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-emerald-100/85">
            Alokasikan bobot kirim (<code>qty_dispatched_kg</code>) dari Batch Supplier ke 20–30
            dapur sekaligus tanpa membuka form satu per satu.
          </p>
        </div>
      </div>

      {/* Batch Selector & Markup Config */}
      <div className="bezel-shell">
        <div className="bezel-core space-y-4">
          <div className="flex items-center gap-2.5 border-b border-white/[0.07] pb-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
              <MatrixGridIcon className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold tracking-tight text-white">
                Konfigurasi Batch & Markup Dapur
              </h2>
              <p className="text-[11px] text-slate-400">
                Invariant 3: Snapshot harga beli & harga jual dikunci saat alokasi
              </p>
            </div>
          </div>

          <div>
            <label
              htmlFor="matrix-batch-select"
              className="mb-1.5 block text-xs font-semibold text-slate-200"
            >
              Pilih Batch Supplier Sumber Alokasi
            </label>
            <select
              id="matrix-batch-select"
              value={selectedBatch?.id ?? ''}
              onChange={(e) => {
                setSelectedBatchId(e.target.value);
                setMessage(null);
              }}
              className="field-input"
            >
              {batches.map((b) => {
                const sup = suppliers.find((s) => s.id === b.supplier_id);
                const itm = items.find((i) => i.id === b.item_id);
                const rem = getBatchRemainingKg(b.id);
                return (
                  <option key={b.id} value={b.id}>
                    {b.batch_code} • {itm?.name} (Sisa: {formatKg(rem)})
                    {!isFieldTeam ? ` @ ${formatIdr(b.supplier_actual_cost_per_kg)}/kg` : ''} —{' '}
                    {sup?.name}
                  </option>
                );
              })}
            </select>
          </div>

          {/* Hide Pricing & Markup strictly for FIELD_TEAM (Invariant 5) */}
          {!isFieldTeam ? (
            <div className="rounded-xl border border-white/[0.06] bg-[#070A10] p-3.5 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
                    HPP Aktual Batch Supplier
                  </div>
                  <div className="mt-1 font-mono text-sm font-bold text-amber-300">
                    {formatIdr(supplierCost)} / kg
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-400">
                    {batchSupplier?.name} ({batchItem?.sku})
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="matrix-markup-input"
                    className="block font-mono text-[10px] uppercase tracking-wider font-semibold text-emerald-300"
                  >
                    Markup per Kg (IDR)
                  </label>
                  <input
                    id="matrix-markup-input"
                    type="number"
                    step="100"
                    min="0"
                    disabled={isReadOnly}
                    value={markupPerKg}
                    onChange={(e) => setMarkupPerKg(e.target.value)}
                    className="mt-1 min-h-[40px] w-full rounded-lg border border-slate-700 bg-[#0D131F] px-3 py-1.5 font-mono text-xs font-bold text-emerald-300 focus:border-emerald-500 disabled:opacity-60"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-2.5 text-xs">
                <div>
                  <span className="text-slate-400">Harga Jual Dapur (Snapshot): </span>
                  <strong className="font-mono text-white">
                    {formatIdr(kitchenUnitPrice)} / kg
                  </strong>
                </div>
                <div className="font-mono text-[11px] text-emerald-300">
                  Bagi Hasil/kg: Tim ({splitConfig.team_share_pct}%){' '}
                  {formatIdr((markupNum * splitConfig.team_share_pct) / 100)} • Kop (
                  {splitConfig.cooperative_share_pct}%){' '}
                  {formatIdr((markupNum * splitConfig.cooperative_share_pct) / 100)}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-950/20 p-3 text-xs text-amber-200">
              <LockClosedIcon className="h-4 w-4 shrink-0 text-amber-400" />
              <span>
                <strong>Mode FIELD_TEAM Aktif:</strong> Kolom Harga Modal Supplier dan Markup
                disembunyikan otomatis sesuai Invariant 5.
              </span>
            </div>
          )}

          {/* Batch Stock Progress & Quick-Fill Toolbar */}
          <div className="rounded-xl border border-white/[0.06] bg-[#070A10] p-3.5 space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Sisa Stok Batch Tersedia:</span>
              <span className="font-mono font-bold text-emerald-400">
                {formatKg(remainingBatchKg)}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">
                Total Input Alokasi Baru ({activeKitchenCount} dapur):
              </span>
              <span
                className={`font-mono font-bold ${
                  totalDraftAllocatedKg > remainingBatchKg ? 'text-rose-400' : 'text-white'
                }`}
              >
                {formatKg(totalDraftAllocatedKg)}
              </span>
            </div>

            {!isReadOnly && (
              <div className="border-t border-white/[0.06] pt-2.5 space-y-2">
                <div className="font-mono text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Pintasan Alokasi Massal (1-Tap Matrix Auto-Fill):
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => handleQuickFill(0, 25, '20.000')}
                    className="min-h-[38px] rounded-lg border border-emerald-500/35 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-500/25 active:scale-[0.98]"
                  >
                    Isi 20.000 kg × 25 Dapur (500 kg)
                  </button>
                  <button
                    type="button"
                    onClick={() => handleQuickFill(5, 15, '15.500')}
                    className="min-h-[38px] rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.08] active:scale-[0.98]"
                  >
                    Dapur 06–15 @ 15.500 kg
                  </button>
                  <button
                    type="button"
                    onClick={() => setGridValues({})}
                    className="min-h-[38px] rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-semibold text-slate-400 transition hover:text-white"
                  >
                    Bersihkan Grid
                  </button>
                </div>
              </div>
            )}
          </div>

          {message && (
            <div
              role={message.startsWith('Error') ? 'alert' : 'status'}
              className={`rounded-xl border px-3.5 py-2.5 text-xs ${
                message.startsWith('Error')
                  ? 'border-rose-500/40 bg-rose-950/60 text-rose-200'
                  : 'border-emerald-500/40 bg-emerald-950/60 text-emerald-200'
              }`}
            >
              {message}
            </div>
          )}

          {!isReadOnly && (
            <button
              type="button"
              onClick={handleSaveMatrixAllocations}
              className="group flex min-h-[46px] w-full items-center justify-between rounded-full bg-emerald-500 pl-5 pr-2 py-1.5 text-xs font-extrabold text-slate-950 shadow-[0_8px_24px_-6px_rgba(16,185,129,0.5)] transition-all duration-300 ease-spring hover:bg-emerald-400 active:scale-[0.98]"
            >
              <span>
                Terbitkan Surat Jalan & Kunci Snapshot ({activeKitchenCount} Dapur •{' '}
                {formatKg(totalDraftAllocatedKg)})
              </span>
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-950/15 transition-transform duration-300 ease-spring group-hover:translate-x-0.5">
                <ArrowUpRightIcon className="h-4 w-4 text-slate-950" />
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Filter & 25-Kitchen Sticky Grid */}
      <div className="bezel-shell">
        <div className="bezel-core space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-slate-200">
              Grid 25 Dapur MBG ({filteredKitchens.length})
            </h3>
            <div>
              <label htmlFor="matrix-search-kitchen" className="sr-only">
                Cari Dapur atau PIC
              </label>
              <input
                id="matrix-search-kitchen"
                type="search"
                placeholder="Cari dapur / PIC..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="min-h-[38px] w-44 rounded-lg border border-slate-700 bg-[#070A10] px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-emerald-500"
              />
            </div>
          </div>

          <div
            role="list"
            aria-label="Daftar 25 Dapur MBG"
            className="max-h-[440px] overflow-y-auto divide-y divide-white/[0.06] pr-1"
          >
            {filteredKitchens.map((kitchen) => {
              const existingDelivIds = new Set(
                deliveries.filter((d) => d.kitchen_id === kitchen.id).map((d) => d.id)
              );
              const existingItems = deliveryItems.filter((di) =>
                existingDelivIds.has(di.delivery_id)
              );
              const alreadyDispatchedKg = existingItems.reduce(
                (sum, di) => sum + di.qty_dispatched_kg,
                0
              );
              const currentInput = gridValues[kitchen.id] ?? '';

              return (
                <div
                  key={kitchen.id}
                  role="listitem"
                  className="py-3 flex items-center justify-between gap-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-emerald-300 ring-1 ring-emerald-500/25">
                        {kitchen.kitchen_code}
                      </span>
                      <span className="truncate text-xs font-bold text-white">
                        {kitchen.name}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                      <span>PIC: {kitchen.pic_name}</span>
                      {alreadyDispatchedKg > 0 && (
                        <span className="rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-300">
                          Terkirim: {formatKg(alreadyDispatchedKg)}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {!isReadOnly && (
                      <button
                        type="button"
                        aria-label={`Tambah 10 kilogram untuk ${kitchen.name}`}
                        onClick={() => handleStepKitchenKg(kitchen.id, 10)}
                        className="min-h-[40px] min-w-[40px] rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-mono text-xs font-bold text-slate-200 transition hover:bg-white/[0.1] active:scale-[0.96]"
                        title="Tambah 10.000 kg"
                      >
                        +10
                      </button>
                    )}
                    <div className="relative w-28">
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        disabled={isReadOnly}
                        aria-label={`Alokasi kilogram untuk ${kitchen.name}`}
                        placeholder="0.000"
                        value={currentInput}
                        onChange={(e) =>
                          setGridValues((prev) => ({
                            ...prev,
                            [kitchen.id]: e.target.value,
                          }))
                        }
                        className="min-h-[40px] w-full rounded-lg border border-slate-700 bg-[#070A10] px-2.5 py-1.5 pr-7 text-right font-mono text-xs font-semibold text-white focus:border-emerald-500 disabled:opacity-60"
                      />
                      <span className="pointer-events-none absolute right-2 top-2.5 font-mono text-[10px] font-bold text-slate-400">
                        kg
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="border-t border-white/[0.07] pt-3 flex items-center justify-between text-xs">
            <span className="text-slate-400">
              Total Pengiriman Aktif: <strong className="text-white">{deliveryItems.length} dapur</strong>
            </span>
            <button
              type="button"
              onClick={() => setActiveTab('bast')}
              className="inline-flex min-h-[36px] items-center gap-1 font-bold text-emerald-400 hover:text-emerald-300"
            >
              <span>Lanjut ke BAST Lapangan</span>
              <ArrowUpRightIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
