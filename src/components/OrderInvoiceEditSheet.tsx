'use client';

import React, { useEffect, useState } from 'react';
import { type OrderLineInput, type UpdateOrderLineInput, useMbgStore } from '../lib/mbg-store';
import { summarizeOrderDraft } from '../lib/order-engine';
import {
  formatKg,
  formatKgNum,
  formatRp,
  formatThousands,
  getJakartaTodayYmd,
  parseKgInput,
  parseRpInput,
  shortKitchenName,
} from '../lib/ui-format';
import { BottomSheet } from './ui';

export type SortMode = 'date_desc' | 'date_asc' | 'kitchen_asc' | 'kitchen_desc';
export type GroupMode = 'none' | 'date' | 'kitchen';

export interface SortGroupControlsProps {
  sortBy: SortMode;
  onSortChange: (v: SortMode) => void;
  groupBy: GroupMode;
  onGroupChange: (v: GroupMode) => void;
  idPrefix: string;
}

export function SortGroupControls({
  sortBy,
  onSortChange,
  groupBy,
  onGroupChange,
  idPrefix,
}: SortGroupControlsProps) {
  return (
    <div className="grid grid-cols-2 gap-2 rounded-[8px] border border-[#e6e6e6] bg-white p-2.5">
      <div>
        <label htmlFor={`${idPrefix}-sort`} className="mb-1 block text-[11px] font-medium text-[#6b6b6b]">
          Urutkan (Sort)
        </label>
        <select
          id={`${idPrefix}-sort`}
          value={sortBy}
          onChange={(e) => onSortChange(e.target.value as SortMode)}
          className="field-input !min-h-[34px] !py-1 text-[12px]"
        >
          <option value="date_desc">Tanggal Terbaru</option>
          <option value="date_asc">Tanggal Terlama</option>
          <option value="kitchen_asc">Nama Dapur (A–Z)</option>
          <option value="kitchen_desc">Nama Dapur (Z–A)</option>
        </select>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-group`} className="mb-1 block text-[11px] font-medium text-[#6b6b6b]">
          Kelompokkan (Group)
        </label>
        <select
          id={`${idPrefix}-group`}
          value={groupBy}
          onChange={(e) => onGroupChange(e.target.value as GroupMode)}
          className="field-input !min-h-[34px] !py-1 text-[12px]"
        >
          <option value="none">Tanpa Grup</option>
          <option value="date">Per Tanggal</option>
          <option value="kitchen">Per Nama Dapur</option>
        </select>
      </div>
    </div>
  );
}

export interface GroupedBucket<T> {
  key: string;
  label: string;
  sublabel?: string;
  items: T[];
}

export function sortAndGroupItems<T>(
  list: T[],
  sortBy: SortMode,
  groupBy: GroupMode,
  getters: {
    getDate: (item: T) => string;
    getKitchenName: (item: T) => string;
    getKitchenCode: (item: T) => string;
    getCode: (item: T) => string;
  }
): GroupedBucket<T>[] {
  const sorted = list.slice().sort((a, b) => {
    const dateA = getters.getDate(a);
    const dateB = getters.getDate(b);
    const nameA = getters.getKitchenName(a);
    const nameB = getters.getKitchenName(b);
    const codeA = getters.getCode(a);
    const codeB = getters.getCode(b);

    if (sortBy === 'date_desc') {
      const cmp = dateB.localeCompare(dateA, 'id');
      if (cmp !== 0) return cmp;
      const kCmp = nameA.localeCompare(nameB, 'id');
      return kCmp !== 0 ? kCmp : codeB.localeCompare(codeA, 'id');
    }
    if (sortBy === 'date_asc') {
      const cmp = dateA.localeCompare(dateB, 'id');
      if (cmp !== 0) return cmp;
      const kCmp = nameA.localeCompare(nameB, 'id');
      return kCmp !== 0 ? kCmp : codeA.localeCompare(codeB, 'id');
    }
    if (sortBy === 'kitchen_asc') {
      const cmp = nameA.localeCompare(nameB, 'id');
      if (cmp !== 0) return cmp;
      const dCmp = dateB.localeCompare(dateA, 'id');
      return dCmp !== 0 ? dCmp : codeA.localeCompare(codeB, 'id');
    }
    const cmp = nameB.localeCompare(nameA, 'id');
    if (cmp !== 0) return cmp;
    const dCmp = dateB.localeCompare(dateA, 'id');
    return dCmp !== 0 ? dCmp : codeA.localeCompare(codeB, 'id');
  });

  if (groupBy === 'none') {
    return [{ key: 'all', label: '', items: sorted }];
  }

  const map = new Map<string, GroupedBucket<T>>();
  for (const item of sorted) {
    if (groupBy === 'date') {
      const dateStr = getters.getDate(item) || '-';
      const existing = map.get(dateStr);
      if (existing) {
        existing.items.push(item);
      } else {
        map.set(dateStr, {
          key: `date-${dateStr}`,
          label: `Tanggal ${dateStr}`,
          items: [item],
        });
      }
    } else {
      const kCode = getters.getKitchenCode(item);
      const kName = getters.getKitchenName(item);
      const key = `${kCode}::${kName}`;
      const existing = map.get(key);
      if (existing) {
        existing.items.push(item);
      } else {
        map.set(key, {
          key: `kitchen-${key}`,
          label: kName,
          sublabel: kCode,
          items: [item],
        });
      }
    }
  }
  return Array.from(map.values());
}

interface EditDraftLine {
  key: number;
  id?: string;
  item_id: string;
  kgStr: string;
  priceStr: string;
  marginStr: string;
}

let editLineSeq = 0;
const nextEditKey = () => (editLineSeq += 1);

const rpText = (raw: string): string => (raw.replace(/\D/g, '') ? formatThousands(parseRpInput(raw)) : '');

export interface OrderInvoiceEditSheetProps {
  deliveryId: string | null;
  mode: 'order' | 'invoice';
  onClose: () => void;
  onSaved: (message: string) => void;
}

export function OrderInvoiceEditSheet({ deliveryId, mode, onClose, onSaved }: OrderInvoiceEditSheetProps) {
  const { kitchens, items, deliveries, deliveryItems, invoices, isSyncing, updateOrder } = useMbgStore();

  const delivery = deliveryId ? deliveries.find((d) => d.id === deliveryId) : undefined;
  const invoice = deliveryId ? invoices.find((i) => i.delivery_id === deliveryId) : undefined;

  const [kitchenId, setKitchenId] = useState<string>('');
  const [orderDate, setOrderDate] = useState<string>('');
  const [lines, setLines] = useState<EditDraftLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!deliveryId) return;
    const del = deliveries.find((d) => d.id === deliveryId);
    const inv = invoices.find((i) => i.delivery_id === deliveryId);
    const existing = deliveryItems.filter((di) => di.delivery_id === deliveryId);
    if (!del) return;

    setKitchenId(del.kitchen_id);
    setOrderDate(inv?.invoice_date || del.delivery_date || getJakartaTodayYmd());
    setLines(
      existing.length > 0
        ? existing.map((di) => {
            const effKg = di.weighed_at !== null ? di.qty_accepted_kg : di.qty_dispatched_kg;
            return {
              key: nextEditKey(),
              id: di.id,
              item_id: di.item_id,
              kgStr: String(effKg).replace('.', ','),
              priceStr: formatThousands(di.kitchen_unit_price_snapshot),
              marginStr: formatThousands(di.margin_per_kg_snapshot),
            };
          })
        : [{ key: nextEditKey(), item_id: '', kgStr: '', priceStr: '', marginStr: '' }]
    );
    setError(null);
  }, [deliveryId, deliveries, deliveryItems, invoices]);

  if (!deliveryId || !delivery) return null;

  const patchLine = (key: number, patch: Partial<EditDraftLine>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    if (error) setError(null);
  };

  const pickItem = (key: number, itemId: string) => {
    const it = items.find((i) => i.id === itemId);
    setLines((prev) =>
      prev.map((l) => {
        if (l.key !== key) return l;
        return {
          ...l,
          item_id: itemId,
          priceStr: it
            ? it.default_kitchen_price_per_kg > 0
              ? formatThousands(it.default_kitchen_price_per_kg)
              : l.priceStr
            : '',
          marginStr: it
            ? it.default_margin_per_kg > 0
              ? formatThousands(it.default_margin_per_kg)
              : l.marginStr
            : '',
        };
      })
    );
    if (error) setError(null);
  };

  const parsedLines: UpdateOrderLineInput[] = lines.map((l) => {
    const kg = parseKgInput(l.kgStr);
    return {
      id: l.id,
      item_id: l.item_id,
      qty_ordered_kg: kg,
      qty_accepted_kg: kg,
      kitchen_unit_price_rp: parseRpInput(l.priceStr),
      margin_per_kg_rp: parseRpInput(l.marginStr),
    };
  });

  const previewLines: OrderLineInput[] = parsedLines.map((l, idx) => ({
    item_id: l.item_id || (l.qty_ordered_kg > 0 ? `edit-draft-${idx}` : ''),
    qty_ordered_kg: l.qty_ordered_kg,
    kitchen_unit_price_rp: l.kitchen_unit_price_rp,
    margin_per_kg_rp: l.margin_per_kg_rp,
  }));
  const summary = summarizeOrderDraft(previewLines);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!kitchenId) {
      setError('Pilih dapur tujuan.');
      return;
    }
    if (!orderDate) {
      setError('Pilih tanggal terlebih dahulu.');
      return;
    }
    const res = await updateOrder({
      delivery_id: delivery.id,
      kitchen_id: kitchenId,
      order_date: orderDate,
      lines: parsedLines,
    });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const k = kitchens.find((x) => x.id === kitchenId);
    const kTitle = k ? `${k.kitchen_code} · ${shortKitchenName(k.name)}` : delivery.delivery_number;
    onSaved(
      mode === 'invoice'
        ? `Invoice ${invoice?.invoice_number ?? ''} (${kTitle}) berhasil diperbarui.`
        : `Order ${delivery.delivery_number} (${kTitle}) berhasil diperbarui.`
    );
    onClose();
  };

  const docCode = mode === 'invoice' ? invoice?.invoice_number ?? delivery.delivery_number : delivery.delivery_number;

  return (
    <BottomSheet
      open={Boolean(deliveryId)}
      title={mode === 'invoice' ? `Edit Invoice · ${docCode}` : `Edit Order · ${docCode}`}
      onClose={onClose}
    >
      <form onSubmit={handleSave} className="space-y-3.5 text-[13px] text-[#0a0a0a]">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <div>
            <label htmlFor="edit-order-date" className="field-label">
              {mode === 'invoice' ? 'Tanggal Invoice / Order' : 'Tanggal Order'}
            </label>
            <input
              id="edit-order-date"
              type="date"
              value={orderDate}
              onChange={(e) => {
                setOrderDate(e.target.value);
                if (error) setError(null);
              }}
              className="field-input tabular-nums"
            />
          </div>
          <div>
            <label htmlFor="edit-order-kitchen" className="field-label">
              Dapur Tujuan
            </label>
            <select
              id="edit-order-kitchen"
              value={kitchenId}
              onChange={(e) => {
                setKitchenId(e.target.value);
                if (error) setError(null);
              }}
              className="field-input"
            >
              <option value="">Pilih dapur…</option>
              {kitchens.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.kitchen_code} · {shortKitchenName(k.name)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-2.5">
          <span className="field-label">Daftar Barang, Qty &amp; Harga</span>
          {lines.map((l, idx) => {
            const chosenElsewhere = new Set(lines.filter((o) => o.key !== l.key).map((o) => o.item_id));
            const kg = parseKgInput(l.kgStr);
            const price = parseRpInput(l.priceStr);
            const lineTotal = kg > 0 && price > 0 ? summarizeOrderDraft([previewLines[idx]!]).estimated_invoice : 0;
            const idp = `edit-ol-${l.key}`;

            return (
              <div key={l.key} className="space-y-2 rounded-[8px] border border-[#e6e6e6] bg-[#f8f9fa] p-3">
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <label htmlFor={`${idp}-item`} className="mb-1 block text-[11px] font-medium text-[#6b6b6b]">
                      Barang {idx + 1}
                    </label>
                    <select
                      id={`${idp}-item`}
                      value={l.item_id}
                      onChange={(e) => pickItem(l.key, e.target.value)}
                      className="field-input"
                    >
                      <option value="">Pilih barang…</option>
                      {items.map((it) => (
                        <option key={it.id} value={it.id} disabled={chosenElsewhere.has(it.id)}>
                          {it.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {lines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setLines((prev) => prev.filter((o) => o.key !== l.key))}
                      aria-label={`Hapus baris barang ${idx + 1}`}
                      className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-[6px] border border-[#d4d4d4] bg-white text-base text-[#6b6b6b] hover:border-[#f5c2c0] hover:bg-[#ffedea] hover:text-[#831c1e]"
                    >
                      ×
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label htmlFor={`${idp}-kg`} className="mb-1 block text-[11px] font-medium text-[#6b6b6b]">
                      Qty (kg)
                    </label>
                    <input
                      id={`${idp}-kg`}
                      type="text"
                      inputMode="decimal"
                      placeholder="0"
                      value={l.kgStr}
                      onChange={(e) => patchLine(l.key, { kgStr: e.target.value })}
                      className="field-input text-right font-medium tabular-nums"
                    />
                  </div>
                  <div>
                    <label htmlFor={`${idp}-price`} className="mb-1 block text-[11px] font-medium text-[#6b6b6b]">
                      Harga / kg (Rp)
                    </label>
                    <input
                      id={`${idp}-price`}
                      type="text"
                      inputMode="numeric"
                      placeholder="0"
                      value={l.priceStr}
                      onChange={(e) => patchLine(l.key, { priceStr: rpText(e.target.value) })}
                      className="field-input text-right tabular-nums"
                    />
                  </div>
                  <div>
                    <label htmlFor={`${idp}-margin`} className="mb-1 block text-[11px] font-medium text-[#6b6b6b]">
                      Margin / kg
                    </label>
                    <input
                      id={`${idp}-margin`}
                      type="text"
                      inputMode="numeric"
                      placeholder="0"
                      value={l.marginStr}
                      onChange={(e) => patchLine(l.key, { marginStr: rpText(e.target.value) })}
                      className="field-input text-right tabular-nums"
                    />
                  </div>
                </div>

                {lineTotal > 0 && (
                  <div className="flex items-baseline justify-between border-t border-[#e6e6e6] pt-1.5 text-[12px] tabular-nums">
                    <span className="text-[#6b6b6b]">
                      {formatKg(kg)} × {formatRp(price)}
                    </span>
                    <span className="font-bold text-[#0a0a0a]">{formatRp(lineTotal)}</span>
                  </div>
                )}
              </div>
            );
          })}

          <button
            type="button"
            onClick={() =>
              setLines((prev) => [...prev, { key: nextEditKey(), item_id: '', kgStr: '', priceStr: '', marginStr: '' }])
            }
            className="btn-secondary min-h-[36px] w-full text-[12px]"
          >
            + Tambah Barang Lain
          </button>
        </div>

        <div className="grid grid-cols-3 divide-x divide-[#e6e6e6] rounded-[8px] border border-[#e6e6e6] bg-[#f8f9fa]">
          <div className="px-3 py-2">
            <div className="text-[11px] text-[#6b6b6b]">Total Berat</div>
            <div className="mt-0.5 truncate text-[13px] font-medium tabular-nums text-[#0a0a0a]">
              {formatKgNum(summary.total_kg)} <span className="text-[11px] text-[#6b6b6b]">kg</span>
            </div>
          </div>
          <div className="px-3 py-2">
            <div className="text-[11px] text-[#6b6b6b]">Total Tagihan</div>
            <div className="mt-0.5 truncate text-[13px] font-bold tabular-nums text-[#0a0a0a]">
              {formatRp(summary.estimated_invoice)}
            </div>
          </div>
          <div className="px-3 py-2">
            <div className="text-[11px] text-[#6b6b6b]">Bagi Hasil</div>
            <div className="mt-0.5 truncate text-[13px] font-bold tabular-nums text-[#1d5fbf]">
              {formatRp(summary.estimated_margin)}
            </div>
          </div>
        </div>

        {error && (
          <p role="alert" className="rounded-[6px] border border-[#f5c2c0] bg-[#ffedea] px-3 py-2 text-[12px] font-medium text-[#831c1e]">
            {error}
          </p>
        )}

        <div className="grid grid-cols-2 gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary min-h-[40px] w-full">
            Batal
          </button>
          <button type="submit" disabled={isSyncing} className="btn-primary min-h-[40px] w-full">
            {isSyncing ? 'Menyimpan…' : 'Simpan Perubahan'}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}
