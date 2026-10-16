'use client';

import React, { useMemo, useState } from 'react';
import { formatIdr, formatKg, useMbgStore } from '../lib/mbg-store';

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
      `✓ Berhasil menerbitkan ${allocations.length} Surat Jalan & mengunci Snapshot Harga ke Dapur MBG!`
    );
  };

  const batchSupplier = suppliers.find((s) => s.id === selectedBatch?.supplier_id);
  const batchItem = items.find((i) => i.id === selectedBatch?.item_id);

  return (
    <div className="space-y-4">
      {/* Header Matrix Info */}
      <div className="rounded-2xl border border-indigo-500/30 bg-indigo-950/30 p-3.5 text-indigo-100">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-300">
            Matriks Cepat 25 Dapur MBG (SPPG 01–25)
          </span>
          <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-[10px] font-semibold text-indigo-300">
            {isFieldTeam ? 'Mode Gudang (Tanpa Harga)' : isReadOnly ? 'Mode Pantau Koperasi' : 'Kunci Snapshot Harga'}
          </span>
        </div>
        <p className="mt-1 text-xs text-indigo-200/80">
          Alokasikan bobot kirim (<code>qty_dispatched_kg</code>) dari Batch Supplier ke 20–30 dapur
          sekaligus tanpa membuka form satu per satu.
        </p>
      </div>

      {/* Batch Selector & Markup Config */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-3.5 shadow-lg space-y-3">
        <div>
          <label className="block text-[11px] font-semibold text-slate-300 mb-1">
            Pilih Batch Supplier Sumber Alokasi
          </label>
          <select
            value={selectedBatch?.id ?? ''}
            onChange={(e) => {
              setSelectedBatchId(e.target.value);
              setMessage(null);
            }}
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none"
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
          <div className="rounded-xl border border-slate-800 bg-slate-950/90 p-3 space-y-2.5">
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <div className="text-[10px] uppercase text-slate-400">
                  HPP Aktual Batch Supplier
                </div>
                <div className="mt-0.5 font-mono text-xs font-bold text-amber-300">
                  {formatIdr(supplierCost)} / kg
                </div>
                <div className="text-[10px] text-slate-500">
                  {batchSupplier?.name} ({batchItem?.sku})
                </div>
              </div>

              <div>
                <label className="block text-[10px] uppercase font-semibold text-emerald-300">
                  Markup per Kg (IDR)
                </label>
                <input
                  type="number"
                  step="100"
                  min="0"
                  disabled={isReadOnly}
                  value={markupPerKg}
                  onChange={(e) => setMarkupPerKg(e.target.value)}
                  className="mt-0.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono text-xs font-bold text-emerald-300 focus:border-emerald-500 focus:outline-none disabled:opacity-60"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-2 text-[11px]">
              <div>
                <span className="text-slate-400">Harga Jual Dapur (Snapshot): </span>
                <strong className="font-mono text-white">
                  {formatIdr(kitchenUnitPrice)} / kg
                </strong>
              </div>
              <div className="text-[10px] text-emerald-300 font-mono">
                Bagi Hasil/kg: Tim ({splitConfig.team_share_pct}%){' '}
                {formatIdr((markupNum * splitConfig.team_share_pct) / 100)} • Koperasi (
                {splitConfig.cooperative_share_pct}%){' '}
                {formatIdr((markupNum * splitConfig.cooperative_share_pct) / 100)}
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-slate-800 bg-slate-950 p-2.5 text-[11px] text-slate-400">
            🔒 <strong>Mode FIELD_TEAM Aktif:</strong> Kolom Harga Modal Supplier dan Markup
            disembunyikan secara otomatis sesuai Invariant 5.
          </div>
        )}

        {/* Batch Stock Progress & Quick-Fill Toolbar */}
        <div className="rounded-xl border border-slate-800 bg-slate-950 p-2.5 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">Sisa Stok Batch Tersedia:</span>
            <span className="font-mono font-bold text-emerald-400">
              {formatKg(remainingBatchKg)}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">Total Input Alokasi Baru ({activeKitchenCount} dapur):</span>
            <span
              className={`font-mono font-bold ${
                totalDraftAllocatedKg > remainingBatchKg ? 'text-rose-400' : 'text-sky-400'
              }`}
            >
              {formatKg(totalDraftAllocatedKg)}
            </span>
          </div>

          {!isReadOnly && (
            <div className="pt-1 border-t border-slate-800/80 space-y-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Pintasan Alokasi Massal (1-Tap Matrix Auto-Fill):
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => handleQuickFill(0, 25, '20.000')}
                  className="rounded-lg bg-emerald-600/20 border border-emerald-500/40 px-2.5 py-1 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-600/30"
                >
                  ⚡ Isi 20.000 kg × 25 Dapur (500 kg)
                </button>
                <button
                  type="button"
                  onClick={() => handleQuickFill(5, 15, '15.500')}
                  className="rounded-lg bg-sky-600/20 border border-sky-500/40 px-2.5 py-1 text-[11px] font-semibold text-sky-300 hover:bg-sky-600/30"
                >
                  ⚡ Dapur 06–15 @ 15.500 kg
                </button>
                <button
                  type="button"
                  onClick={() => setGridValues({})}
                  className="rounded-lg bg-slate-800 px-2.5 py-1 text-[11px] font-semibold text-slate-300 hover:bg-slate-700"
                >
                  Bersihkan Grid
                </button>
              </div>
            </div>
          )}
        </div>

        {message && (
          <div
            className={`rounded-xl border px-3 py-2 text-xs ${
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
            className="w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-bold text-white shadow-md transition hover:bg-emerald-500 active:scale-[0.99]"
          >
            🚀 Terbitkan Surat Jalan & Kunci Snapshot ({activeKitchenCount} Dapur •{' '}
            {formatKg(totalDraftAllocatedKg)})
          </button>
        )}
      </div>

      {/* Filter & 25-Kitchen Sticky Grid */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-3 shadow-lg space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
            Grid 25 Dapur MBG ({filteredKitchens.length})
          </h3>
          <input
            type="text"
            placeholder="Cari dapur / PIC..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-40 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
          />
        </div>

        <div className="max-h-[420px] overflow-y-auto divide-y divide-slate-800/80 pr-0.5">
          {filteredKitchens.map((kitchen) => {
            // Check already dispatched kg today for this kitchen
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
                className="py-2.5 flex items-center justify-between gap-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] font-bold text-emerald-400">
                      {kitchen.kitchen_code}
                    </span>
                    <span className="truncate text-xs font-semibold text-white">
                      {kitchen.name}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
                    <span>PIC: {kitchen.pic_name}</span>
                    {alreadyDispatchedKg > 0 && (
                      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono font-semibold text-emerald-300">
                        Terkirim: {formatKg(alreadyDispatchedKg)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  {!isReadOnly && (
                    <button
                      type="button"
                      onClick={() => handleStepKitchenKg(kitchen.id, 10)}
                      className="rounded-lg border border-slate-700 bg-slate-800 px-1.5 py-1 font-mono text-[10px] font-bold text-slate-200 hover:bg-slate-700"
                      title="Tambah 10.000 kg"
                    >
                      +10
                    </button>
                  )}
                  <div className="relative w-24">
                    <input
                      type="number"
                      step="0.001"
                      min="0"
                      disabled={isReadOnly}
                      placeholder="0.000"
                      value={currentInput}
                      onChange={(e) =>
                        setGridValues((prev) => ({
                          ...prev,
                          [kitchen.id]: e.target.value,
                        }))
                      }
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 pr-6 text-right font-mono text-xs text-white focus:border-emerald-500 focus:outline-none disabled:opacity-60"
                    />
                    <span className="absolute right-1.5 top-1.5 text-[10px] font-bold text-slate-400">
                      kg
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="border-t border-slate-800 pt-2.5 flex items-center justify-between text-xs">
          <span className="text-slate-400">
            Total Pengiriman Aktif Hari Ini: <strong>{deliveryItems.length} item dapur</strong>
          </span>
          <button
            type="button"
            onClick={() => setActiveTab('bast')}
            className="font-semibold text-emerald-400 hover:underline"
          >
            Lanjut ke BAST Lapangan →
          </button>
        </div>
      </div>
    </div>
  );
}
