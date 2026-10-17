'use client';

import React, { useState } from 'react';
import { useMbgStore } from '../lib/mbg-store';
import { formatKgNum, formatRp, sumKg } from '../lib/ui-format';
import { BottomSheet, Card, NoAccess, Toast, type ToastState } from './ui';

export function Tab1SupplierBatches({ onAllocate }: { onAllocate: (batchId: string) => void }) {
  const { activeRole, suppliers, items, batches, addSupplierBatch, getBatchRemainingKg } =
    useMbgStore();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [supplierId, setSupplierId] = useState<string>(suppliers[0]?.id ?? '');
  const [itemId, setItemId] = useState<string>(items[0]?.id ?? '');
  const [qtyKg, setQtyKg] = useState('');
  const [costPerKg, setCostPerKg] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);

  if (activeRole !== 'OWNER_ADMIN' && activeRole !== 'FINANCE') {
    return <NoAccess />;
  }

  const rows = batches.map((b) => ({
    batch: b,
    supplier: suppliers.find((s) => s.id === b.supplier_id),
    item: items.find((i) => i.id === b.item_id),
    remainingKg: getBatchRemainingKg(b.id),
  }));
  const totalRemainingKg = sumKg(rows.map((r) => r.remainingKg));
  const activeCount = rows.filter((r) => r.remainingKg > 0).length;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const qty = Number(qtyKg);
    const cost = Number(costPerKg);
    if (!Number.isFinite(qty) || qty <= 0) {
      setFormError('Isi berat masuk lebih dari 0 kg.');
      return;
    }
    if (!Number.isFinite(cost) || cost <= 0) {
      setFormError('Isi harga beli per kg.');
      return;
    }
    addSupplierBatch({
      supplier_id: supplierId,
      item_id: itemId,
      qty_received_kg: qty,
      supplier_actual_cost_per_kg: cost,
    });
    const itemName = items.find((i) => i.id === itemId)?.name ?? 'Barang';
    setToast({ kind: 'ok', text: `${itemName} ${formatKgNum(qty)} kg tersimpan.` });
    setQtyKg('');
    setCostPerKg('');
    setFormError(null);
    setSheetOpen(false);
  };

  return (
    <section aria-label="Stok dan HPP" className="space-y-3">
      <button type="button" onClick={() => setSheetOpen(true)} className="btn-primary w-full">
        <span className="text-lg leading-none">+</span>
        <span>Tambah Barang Masuk (Supplier)</span>
      </button>

      <Toast toast={toast} onClose={() => setToast(null)} />

      <Card as="section" className="overflow-hidden">
        <div className="flex items-baseline justify-between border-b border-slate-200 px-3 py-2.5">
          <h2 className="text-sm font-bold text-slate-900">Stok Batch Aktif ({activeCount})</h2>
          <span className="text-xs font-semibold text-slate-600 tabular-nums">
            Sisa {formatKgNum(totalRemainingKg)} kg
          </span>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-2 border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          <span>Barang</span>
          <span className="w-[76px] text-right">HPP/kg</span>
          <span className="w-[64px] text-right">Sisa kg</span>
          <span className="w-[76px]" aria-hidden="true" />
        </div>

        <ul className="divide-y divide-slate-100">
          {rows.map(({ batch, supplier, item, remainingKg }) => {
            const empty = remainingKg <= 0;
            return (
              <li
                key={batch.id}
                className={`grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-2 px-3 py-2 ${
                  empty ? 'opacity-60' : ''
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-900">
                    {item?.name ?? '-'}
                  </div>
                  <div className="truncate text-xs text-slate-500">{supplier?.name ?? '-'}</div>
                </div>
                <span className="w-[76px] text-right text-sm font-semibold tabular-nums text-slate-800">
                  {formatRp(batch.supplier_actual_cost_per_kg)}
                </span>
                <span
                  className={`w-[64px] text-right text-sm font-bold tabular-nums ${
                    empty ? 'text-slate-400' : 'text-emerald-700'
                  }`}
                >
                  {formatKgNum(remainingKg)}
                </span>
                <button
                  type="button"
                  disabled={empty}
                  onClick={() => onAllocate(batch.id)}
                  className="w-[76px] min-h-[36px] rounded-md bg-emerald-600 px-2 text-xs font-bold text-white transition hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-500"
                >
                  {empty ? 'Habis' : 'Alokasikan'}
                </button>
              </li>
            );
          })}
        </ul>
      </Card>

      <BottomSheet
        open={sheetOpen}
        title="Barang Masuk dari Supplier"
        onClose={() => {
          setSheetOpen(false);
          setFormError(null);
        }}
      >
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="in-supplier" className="mb-1 block text-xs font-semibold text-slate-700">
                Supplier
              </label>
              <select
                id="in-supplier"
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                className="field-input"
              >
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="in-item" className="mb-1 block text-xs font-semibold text-slate-700">
                Bahan Baku
              </label>
              <select
                id="in-item"
                value={itemId}
                onChange={(e) => setItemId(e.target.value)}
                className="field-input"
              >
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="in-qty" className="mb-1 block text-xs font-semibold text-slate-700">
                Berat Masuk (kg)
              </label>
              <input
                id="in-qty"
                type="number"
                inputMode="decimal"
                step="0.001"
                min="0.001"
                placeholder="0.000"
                value={qtyKg}
                onChange={(e) => setQtyKg(e.target.value)}
                className="field-input text-right font-semibold tabular-nums"
                required
              />
            </div>
            <div>
              <label htmlFor="in-cost" className="mb-1 block text-xs font-semibold text-slate-700">
                Harga Beli/kg (Rp)
              </label>
              <input
                id="in-cost"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="1"
                placeholder="0"
                value={costPerKg}
                onChange={(e) => setCostPerKg(e.target.value)}
                className="field-input text-right font-semibold tabular-nums"
                required
              />
            </div>
          </div>

          {formError && (
            <p role="alert" className="text-sm font-medium text-rose-700">
              {formError}
            </p>
          )}

          <button type="submit" className="btn-primary w-full">
            Simpan Barang Masuk
          </button>
        </form>
      </BottomSheet>
    </section>
  );
}
