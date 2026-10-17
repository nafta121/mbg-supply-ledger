'use client';

import React, { useMemo, useState } from 'react';
import { gramsToKg, kgToGrams } from '../lib/financial-engine';
import { useMbgStore } from '../lib/mbg-store';
import {
  addIdr,
  formatKgNum,
  formatRp,
  parseKgInput,
  shortKitchenName,
  sumKg,
} from '../lib/ui-format';
import { Card, Toast, type ToastState } from './ui';

export function Tab2KitchenMatrix({ initialBatchId }: { initialBatchId?: string | null }) {
  const {
    activeRole,
    kitchens,
    batches,
    suppliers,
    items,
    deliveryItems,
    deliveries,
    allocateBatchToKitchens,
    getBatchRemainingKg,
  } = useMbgStore();

  const canEdit = activeRole === 'OWNER_ADMIN' || activeRole === 'FINANCE';

  const defaultBatch =
    batches.find((b) => b.id === initialBatchId) ??
    batches.find((b) => getBatchRemainingKg(b.id) > 0) ??
    batches[0];

  const [selectedBatchId, setSelectedBatchId] = useState<string>(defaultBatch?.id ?? '');
  const [markupPerKg, setMarkupPerKg] = useState('3500');
  const [gridValues, setGridValues] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<ToastState>(null);

  const selectedBatch = batches.find((b) => b.id === selectedBatchId) ?? batches[0];
  const remainingKg = selectedBatch ? getBatchRemainingKg(selectedBatch.id) : 0;
  const supplierCost = selectedBatch?.supplier_actual_cost_per_kg ?? 0;
  const markupNum = Math.max(0, Number(markupPerKg) || 0);
  const kitchenUnitPrice = addIdr(supplierCost, markupNum);

  const draftKg = useMemo(
    () => sumKg(Object.values(gridValues).map(parseKgInput)),
    [gridValues]
  );
  const draftCount = useMemo(
    () => Object.values(gridValues).filter((v) => parseKgInput(v) > 0).length,
    [gridValues]
  );
  const overStock = kgToGrams(draftKg) > kgToGrams(remainingKg);

  const dispatchedByKitchen = useMemo(() => {
    const deliveryToKitchen = new Map(deliveries.map((d) => [d.id, d.kitchen_id]));
    const acc = new Map<string, bigint>();
    for (const di of deliveryItems) {
      if (di.supplier_batch_id !== selectedBatch?.id) continue;
      const kid = deliveryToKitchen.get(di.delivery_id);
      if (!kid) continue;
      acc.set(kid, (acc.get(kid) ?? 0n) + kgToGrams(di.qty_dispatched_kg));
    }
    return acc;
  }, [deliveries, deliveryItems, selectedBatch?.id]);

  const setKitchenValue = (kitchenId: string, value: string) =>
    setGridValues((prev) => ({ ...prev, [kitchenId]: value }));

  const stepKitchen = (kitchenId: string, deltaKg: number) => {
    const nextGrams = kgToGrams(parseKgInput(gridValues[kitchenId])) + kgToGrams(deltaKg);
    setKitchenValue(kitchenId, nextGrams > 0n ? formatKgNum(gramsToKg(nextGrams)) : '');
  };

  const fillEvenly = () => {
    if (kitchens.length === 0) return;
    // Whole kg per kitchen (floor) so the sum never exceeds the remaining stock.
    const remainingWholeKg = kgToGrams(remainingKg) / 1000n;
    const perKitchenKg = remainingWholeKg / BigInt(kitchens.length);
    if (perKitchenKg <= 0n) {
      setToast({ kind: 'error', text: 'Stok batch ini sudah habis.' });
      return;
    }
    const val = String(perKitchenKg);
    setGridValues(Object.fromEntries(kitchens.map((k) => [k.id, val])));
  };

  const fillAll = (kg: number) =>
    setGridValues(Object.fromEntries(kitchens.map((k) => [k.id, formatKgNum(kg)])));

  const handleSave = () => {
    if (!selectedBatch || !canEdit) return;
    if (draftCount === 0) {
      setToast({ kind: 'error', text: 'Isi berat minimal untuk 1 dapur.' });
      return;
    }
    if (overStock) {
      setToast({
        kind: 'error',
        text: `Melebihi sisa stok (${formatKgNum(remainingKg)} kg).`,
      });
      return;
    }
    const allocations = Object.entries(gridValues)
      .map(([kitchen_id, raw]) => ({ kitchen_id, qty_dispatched_kg: parseKgInput(raw) }))
      .filter((a) => a.qty_dispatched_kg > 0);

    allocateBatchToKitchens({
      supplier_batch_id: selectedBatch.id,
      kitchen_unit_price_per_kg: kitchenUnitPrice,
      allocations,
    });
    setGridValues({});
    setToast({
      kind: 'ok',
      text: `${allocations.length} surat jalan dibuat (${formatKgNum(draftKg)} kg).`,
    });
  };

  return (
    <section aria-label="Bagi ke Dapur" className={`space-y-3 ${canEdit ? 'pb-20' : ''}`}>
      {/* Batch + markup in one thin card */}
      <Card className="space-y-2 p-3">
        <div className={`grid gap-2 ${canEdit ? 'grid-cols-[minmax(0,1fr)_112px]' : 'grid-cols-1'}`}>
          <div className="min-w-0">
            <label htmlFor="mx-batch" className="mb-1 block text-xs font-semibold text-slate-700">
              Batch Barang
            </label>
            <select
              id="mx-batch"
              value={selectedBatch?.id ?? ''}
              onChange={(e) => {
                setSelectedBatchId(e.target.value);
                setGridValues({});
              }}
              className="field-input truncate"
            >
              {batches.map((b) => {
                const itm = items.find((i) => i.id === b.item_id);
                const sup = suppliers.find((s) => s.id === b.supplier_id);
                return (
                  <option key={b.id} value={b.id}>
                    {itm?.name ?? '-'} — {sup?.name ?? '-'} ({formatKgNum(getBatchRemainingKg(b.id))} kg)
                  </option>
                );
              })}
            </select>
          </div>
          {canEdit && (
            <div>
              <label htmlFor="mx-markup" className="mb-1 block text-xs font-semibold text-slate-700">
                Markup/kg (Rp)
              </label>
              <input
                id="mx-markup"
                type="number"
                inputMode="decimal"
                min="0"
                step="100"
                value={markupPerKg}
                onChange={(e) => setMarkupPerKg(e.target.value)}
                className="field-input text-right font-semibold tabular-nums"
              />
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-slate-600">
          {canEdit ? (
            <span className="tabular-nums">
              HPP <strong className="text-slate-900">{formatRp(supplierCost)}</strong> →{' '}
              Harga Dapur <strong className="text-emerald-700">{formatRp(kitchenUnitPrice)}</strong>
            </span>
          ) : (
            <span>Sisa stok batch</span>
          )}
          <span className="tabular-nums">
            Sisa Stok: <strong className="text-slate-900">{formatKgNum(remainingKg)} kg</strong>
          </span>
        </div>
      </Card>

      {canEdit && (
        <div className="grid grid-cols-3 gap-2">
          <button type="button" onClick={fillEvenly} className="btn-secondary min-h-[40px] text-xs">
            Bagi Rata
          </button>
          <button type="button" onClick={() => fillAll(20)} className="btn-secondary min-h-[40px] text-xs">
            Isi 20 kg Semua
          </button>
          <button
            type="button"
            onClick={() => setGridValues({})}
            className="btn-secondary min-h-[40px] text-xs text-slate-600"
          >
            Reset
          </button>
        </div>
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />

      {/* Compact spreadsheet rows (≤48px each) */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          <span>Dapur ({kitchens.length})</span>
          <span>{canEdit ? 'Kirim (kg)' : 'Terkirim (kg)'}</span>
        </div>
        <ul className="divide-y divide-slate-100">
          {kitchens.map((k) => {
            const sentGrams = dispatchedByKitchen.get(k.id) ?? 0n;
            const value = gridValues[k.id] ?? '';
            const hasValue = parseKgInput(value) > 0;
            return (
              <li
                key={k.id}
                className={`flex h-12 items-center gap-2 px-3 ${hasValue ? 'bg-emerald-50/60' : ''}`}
              >
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="truncate text-sm text-slate-900">
                    <span className="font-bold tabular-nums">{k.kitchen_code}</span>
                    <span className="text-slate-400"> • </span>
                    <span className="font-medium">{shortKitchenName(k.name)}</span>
                  </div>
                  {sentGrams > 0n && canEdit && (
                    <div className="truncate text-[11px] text-slate-500 tabular-nums">
                      Terkirim {formatKgNum(gramsToKg(sentGrams))} kg
                    </div>
                  )}
                </div>

                {canEdit ? (
                  <>
                    <button
                      type="button"
                      aria-label={`Tambah 10 kg untuk ${k.name}`}
                      onClick={() => stepKitchen(k.id, 10)}
                      className="btn-chip w-11 tabular-nums"
                    >
                      +10
                    </button>
                    <button
                      type="button"
                      aria-label={`Tambah 50 kg untuk ${k.name}`}
                      onClick={() => stepKitchen(k.id, 50)}
                      className="btn-chip w-11 tabular-nums"
                    >
                      +50
                    </button>
                    <input
                      type="number"
                      inputMode="numeric"
                      step="1"
                      min="0"
                      placeholder="0"
                      aria-label={`Berat kirim (kg) untuk ${k.name}`}
                      value={value}
                      onChange={(e) => setKitchenValue(k.id, e.target.value)}
                      className={`h-9 w-[84px] rounded-md border px-2 text-right text-sm font-bold tabular-nums text-slate-900 focus:border-emerald-600 ${
                        hasValue ? 'border-emerald-500 bg-white' : 'border-slate-300 bg-white'
                      }`}
                    />
                  </>
                ) : (
                  <span className="text-sm font-bold tabular-nums text-slate-900">
                    {formatKgNum(gramsToKg(sentGrams))}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      {canEdit && (
        <div className="no-print fixed inset-x-0 bottom-[61px] z-20">
          <div className="mx-auto max-w-md px-3 pb-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={draftCount === 0}
              className={`btn-primary w-full shadow-lg ${overStock ? '!bg-rose-600' : ''}`}
            >
              <span className="truncate">
                Simpan &amp; Buat Surat Jalan ({draftCount} Dapur • {formatKgNum(draftKg)} kg)
              </span>
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
