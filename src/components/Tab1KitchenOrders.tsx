'use client';

import React, { useRef, useState } from 'react';
import { type OrderLineInput, useMbgStore } from '../lib/mbg-store';
import { findOpenOrder, linesForDelivery, orderProgress, summarizeOrderDraft } from '../lib/order-engine';
import {
  formatKg,
  formatKgNum,
  formatRp,
  formatThousands,
  getJakartaTodayYmd,
  ORDER_PROGRESS_LABEL,
  orderProgressTone,
  parseKgInput,
  parseRpInput,
  shortKitchenName,
  sumIdr,
} from '../lib/ui-format';
import { Badge, Card, NoAccess, SegmentedControl, Toast, type ToastState } from './ui';

interface DraftLine {
  key: number;
  item_id: string;
  kgStr: string;
  priceStr: string;
  marginStr: string;
}

type ListFilter = 'active' | 'paid';

let lineSeq = 0;
const emptyLine = (): DraftLine => ({ key: (lineSeq += 1), item_id: '', kgStr: '', priceStr: '', marginStr: '' });

/** Rupiah input: keeps only digits and re-formats with thousand dots ("14.000"). */
const rpText = (raw: string): string => (raw.replace(/\D/g, '') ? formatThousands(parseRpInput(raw)) : '');

/**
 * Tab 1 — "Order Dapur" (Admin / Keuangan only).
 * 1 Order Dapur (multi-barang) = 1 kartu kurir = 1 Invoice Dapur Gabungan.
 */
export function Tab1KitchenOrders() {
  const {
    activeRole,
    kitchens,
    items,
    deliveries,
    deliveryItems,
    invoices,
    createOrder,
    removeOrderLine,
    deleteOrder,
  } = useMbgStore();

  const [kitchenId, setKitchenId] = useState<string | null>(null);
  const [kitchenQuery, setKitchenQuery] = useState('');
  const [lines, setLines] = useState<DraftLine[]>(() => [emptyLine()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [filter, setFilter] = useState<ListFilter>('active');
  const formRef = useRef<HTMLDivElement>(null);

  if (activeRole !== 'OWNER_ADMIN' && activeRole !== 'FINANCE') return <NoAccess />;

  const todayYmd = getJakartaTodayYmd();
  const data = { deliveries, deliveryItems, invoices };
  const kitchen = kitchens.find((k) => k.id === kitchenId) ?? null;
  const openOrder = kitchen ? (findOpenOrder(data, kitchen.id, todayYmd) ?? findOpenOrder(data, kitchen.id)) : undefined;
  const openItemIds = new Set(openOrder ? linesForDelivery(data, openOrder.id).map((l) => l.item_id) : []);

  const q = kitchenQuery.trim().toLowerCase();
  const kitchenMatches = kitchens.filter(
    (k) => !q || k.name.toLowerCase().includes(q) || k.kitchen_code.toLowerCase().includes(q) || k.pic_name.toLowerCase().includes(q)
  );

  const orderLines: OrderLineInput[] = lines.map((l) => ({
    item_id: l.item_id,
    qty_ordered_kg: parseKgInput(l.kgStr),
    kitchen_unit_price_rp: parseRpInput(l.priceStr),
    margin_per_kg_rp: parseRpInput(l.marginStr),
  }));
  const previewLines: OrderLineInput[] = orderLines.map((l, idx) => ({
    ...l,
    item_id: l.item_id || (l.qty_ordered_kg > 0 ? `draft-${idx}` : ''),
  }));
  const summary = summarizeOrderDraft(previewLines);

  // ---------- Draft actions ----------

  const patchLine = (key: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const pickItem = (key: number, itemId: string) => {
    const it = items.find((i) => i.id === itemId);
    setLines((prev) =>
      prev.map((l) => {
        if (l.key !== key) return l;
        return {
          ...l,
          item_id: itemId,
          // Auto-fill default prices when > 0 so Admin does not retype them (still editable).
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
  };

  const resetForm = () => {
    setKitchenId(null);
    setKitchenQuery('');
    setLines([emptyLine()]);
    setFormError(null);
  };

  const startAddToKitchen = (id: string) => {
    setKitchenId(id);
    setLines([emptyLine()]);
    setFormError(null);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const submit = async () => {
    if (!kitchen) {
      setFormError('Pilih dapur tujuan dulu.');
      return;
    }
    const filled = orderLines.filter((l, idx) => l.item_id || lines[idx]!.kgStr.trim() !== '');
    const res = await createOrder({ kitchen_id: kitchen.id, lines: filled });
    if (!res.ok) {
      setFormError(res.error);
      return;
    }
    const title = `${kitchen.kitchen_code} • ${shortKitchenName(kitchen.name)}`;
    setToast({
      kind: 'ok',
      text: res.merged
        ? `${title}: ${res.count ?? filled.length} barang ditambahkan ke order hari ini & daftar kurir.`
        : `${title}: order tersimpan (${res.count ?? filled.length} barang) & masuk daftar kurir.`,
    });
    resetForm();
  };

  // ---------- Active order list ----------

  const todayOrders = deliveries
    .map((d) => ({
      delivery: d,
      kitchen: kitchens.find((k) => k.id === d.kitchen_id),
      invoice: invoices.find((i) => i.delivery_id === d.id),
      lines: deliveryItems.filter((di) => di.delivery_id === d.id),
    }))
    .sort((a, b) => (a.kitchen?.kitchen_code ?? '').localeCompare(b.kitchen?.kitchen_code ?? '', 'id'));
  const activeOrders = todayOrders.filter((o) => o.invoice?.payment_status !== 'PAID');
  const paidOrders = todayOrders.filter((o) => o.invoice?.payment_status === 'PAID');
  const shownOrders = filter === 'active' ? activeOrders : paidOrders;

  const confirmDo = (text: string) => typeof window === 'undefined' || window.confirm(text);

  const handleRemoveLine = async (lineId: string, label: string) => {
    if (!confirmDo(`Hapus ${label} dari order?`)) return;
    const res = await removeOrderLine(lineId);
    setToast(res.ok ? { kind: 'ok', text: `${label} dihapus dari order.` } : { kind: 'error', text: res.error });
  };

  const handleDeleteOrder = async (deliveryId: string, label: string) => {
    if (!confirmDo(`Hapus seluruh order ${label}? Invoice & bagi hasilnya ikut terhapus.`)) return;
    const res = await deleteOrder(deliveryId);
    setToast(res.ok ? { kind: 'ok', text: `Order ${label} dihapus.` } : { kind: 'error', text: res.error });
  };

  // ---------- Render ----------

  return (
    <section aria-label="Order Dapur" className="space-y-3">
      <Toast toast={toast} onClose={() => setToast(null)} />

      <div ref={formRef} className="scroll-mt-16">
        <Card as="section" className="space-y-3 p-3">
          <h2 className="text-sm font-extrabold text-slate-900">+ Buat Order Dapur Baru</h2>

          {/* 1. Dapur tujuan */}
          <div className="space-y-1.5">
            <span className="block text-xs font-semibold text-slate-700">Dapur Tujuan</span>
            {kitchen ? (
              <div className="flex items-center justify-between gap-2 rounded-lg bg-emerald-50 px-3 py-2 ring-1 ring-inset ring-emerald-200">
                <div className="min-w-0">
                  <div className="truncate text-sm font-bold text-slate-900">
                    {kitchen.kitchen_code} • {shortKitchenName(kitchen.name)}
                  </div>
                  <div className="truncate text-xs text-slate-600">PIC: {kitchen.pic_name}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setKitchenId(null)}
                  className="min-h-[36px] shrink-0 rounded-md px-2 text-xs font-semibold text-emerald-700 hover:underline"
                >
                  Ganti
                </button>
              </div>
            ) : (
              <>
                <label htmlFor="order-kitchen-search" className="sr-only">
                  Cari dapur
                </label>
                <input
                  id="order-kitchen-search"
                  type="search"
                  placeholder="Cari dapur (nama / kode / PIC)…"
                  value={kitchenQuery}
                  onChange={(e) => setKitchenQuery(e.target.value)}
                  className="field-input"
                />
                <ul
                  aria-label="Daftar dapur"
                  className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-lg ring-1 ring-inset ring-slate-200"
                >
                  {kitchenMatches.length === 0 && (
                    <li className="px-3 py-2 text-xs text-slate-500">Dapur tidak ditemukan.</li>
                  )}
                  {kitchenMatches.map((k) => {
                    const hasOpen = !!(findOpenOrder(data, k.id, todayYmd) ?? findOpenOrder(data, k.id));
                    return (
                      <li key={k.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setKitchenId(k.id);
                            setFormError(null);
                          }}
                          className="flex min-h-[44px] w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-slate-50"
                        >
                          <span className="min-w-0 truncate text-sm text-slate-900">
                            <span className="font-semibold">{k.kitchen_code}</span> • {shortKitchenName(k.name)}
                          </span>
                          {hasOpen && <Badge tone="amber">Ada order</Badge>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {openOrder && (
              <p className="text-xs text-amber-800">
                Dapur ini sudah punya order hari ini ({openOrder.delivery_number}). Barang baru akan ditambahkan ke
                order &amp; invoice yang sama.
              </p>
            )}
          </div>

          {/* 2. Daftar barang pesanan */}
          <div className="space-y-2">
            <span className="block text-xs font-semibold text-slate-700">Daftar Barang Pesanan</span>
            {lines.map((l, idx) => {
              const chosenElsewhere = new Set(lines.filter((o) => o.key !== l.key).map((o) => o.item_id));
              const kg = parseKgInput(l.kgStr);
              const price = parseRpInput(l.priceStr);
              const lineTotal = kg > 0 && price > 0 ? summarizeOrderDraft([previewLines[idx]!]).estimated_invoice : 0;
              const idp = `ol-${l.key}`;
              return (
                <div key={l.key} className="space-y-2 rounded-lg bg-slate-50 p-2.5 ring-1 ring-inset ring-slate-200">
                  <div className="flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <label htmlFor={`${idp}-item`} className="block text-[11px] font-medium text-slate-600">
                        Barang {idx + 1}
                      </label>
                      <select
                        id={`${idp}-item`}
                        value={l.item_id}
                        onChange={(e) => pickItem(l.key, e.target.value)}
                        className="field-input mt-0.5"
                      >
                        <option value="">Pilih barang…</option>
                        {items.map((it) => {
                          const taken = openItemIds.has(it.id) || chosenElsewhere.has(it.id);
                          return (
                            <option key={it.id} value={it.id} disabled={taken}>
                              {it.name}
                              {openItemIds.has(it.id) ? ' (sudah di order)' : ''}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                    {lines.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setLines((prev) => prev.filter((o) => o.key !== l.key))}
                        aria-label={`Hapus baris barang ${idx + 1}`}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-lg text-slate-500 hover:bg-rose-50 hover:text-rose-600"
                      >
                        ×
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,1fr)] gap-2">
                    <div>
                      <label htmlFor={`${idp}-kg`} className="block text-[11px] font-medium text-slate-600">
                        Berat (kg)
                      </label>
                      <input
                        id={`${idp}-kg`}
                        type="text"
                        inputMode="decimal"
                        step="any"
                        placeholder="Contoh: 12,5 atau 0,2"
                        value={l.kgStr}
                        onChange={(e) => patchLine(l.key, { kgStr: e.target.value })}
                        className="field-input mt-0.5 text-right font-bold tabular-nums"
                      />
                    </div>
                    <div>
                      <label htmlFor={`${idp}-price`} className="block text-[11px] font-medium text-slate-600">
                        Harga Dapur/kg (Rp)
                      </label>
                      <input
                        id={`${idp}-price`}
                        type="text"
                        inputMode="numeric"
                        placeholder="0"
                        value={l.priceStr}
                        onChange={(e) => patchLine(l.key, { priceStr: rpText(e.target.value) })}
                        className="field-input mt-0.5 text-right tabular-nums"
                      />
                    </div>
                    <div>
                      <label htmlFor={`${idp}-margin`} className="block text-[11px] font-medium text-slate-600">
                        Margin Kita/kg
                      </label>
                      <input
                        id={`${idp}-margin`}
                        type="text"
                        inputMode="numeric"
                        placeholder="0"
                        value={l.marginStr}
                        onChange={(e) => patchLine(l.key, { marginStr: rpText(e.target.value) })}
                        className="field-input mt-0.5 text-right text-xs tabular-nums"
                      />
                    </div>
                  </div>
                  {lineTotal > 0 && (
                    <p className="text-right text-[11px] tabular-nums text-slate-600">
                      {formatKg(kg)} × {formatRp(price)} = <span className="font-semibold">{formatRp(lineTotal)}</span>
                    </p>
                  )}
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => setLines((prev) => [...prev, emptyLine()])}
              className="btn-secondary min-h-[40px] w-full text-xs"
            >
              + Tambah Barang Lain
            </button>
          </div>

          {/* 3. Preview */}
          <div className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold tabular-nums text-white">
            Total Barang: {summary.item_count} jenis ({formatKgNum(summary.total_kg)} kg) • Estimasi Tagihan Dapur:{' '}
            {formatRp(summary.estimated_invoice)}
            {summary.estimated_margin > 0 && (
              <span className="block font-medium text-slate-300">
                Estimasi bagi hasil (Tim + Koperasi): {formatRp(summary.estimated_margin)}
              </span>
            )}
          </div>

          {formError && (
            <p role="alert" className="text-sm font-medium text-rose-700">
              {formError}
            </p>
          )}

          <button type="button" onClick={submit} className="btn-primary min-h-[48px] w-full">
            Simpan Order &amp; Kirim ke Daftar Kurir
          </button>
        </Card>
      </div>

      {/* Daftar Order Dapur hari ini */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <h2 className="text-sm font-extrabold text-slate-900">Order Dapur Hari Ini</h2>
        <span className="text-xs text-slate-500">{todayYmd}</span>
      </div>
      <SegmentedControl<ListFilter>
        label="Filter order"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'active', label: `Aktif (${activeOrders.length})` },
          { value: 'paid', label: `Lunas (${paidOrders.length})` },
        ]}
      />

      {shownOrders.length === 0 && (
        <Card className="p-6 text-center text-sm font-medium text-slate-600">
          {filter === 'active' ? 'Belum ada order aktif.' : 'Belum ada order yang lunas.'}
        </Card>
      )}

      <div className="space-y-2">
        {shownOrders.map(({ delivery, kitchen: k, invoice, lines: ol }) => {
          const progress = orderProgress(ol);
          const locked = invoice?.payment_status === 'PAID';
          const title = k ? `${k.kitchen_code} • ${shortKitchenName(k.name)}` : '-';
          const marginTotal = sumIdr(ol.map((l) => l.line_margin_amount));
          return (
            <Card as="article" key={delivery.id} className="overflow-hidden">
              <header className="flex items-start justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2.5">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-extrabold text-slate-900">{title}</h3>
                  <p className="truncate font-mono text-[11px] text-slate-500">{delivery.delivery_number}</p>
                </div>
                <Badge tone={locked ? 'green' : orderProgressTone(progress)}>
                  {locked ? 'Lunas' : ORDER_PROGRESS_LABEL[progress]}
                </Badge>
              </header>
              <ul className="divide-y divide-slate-100 px-3">
                {ol.map((l) => {
                  const name = items.find((i) => i.id === l.item_id)?.name ?? 'Barang';
                  const weighed = l.weighed_at !== null;
                  return (
                    <li key={l.id} className="flex items-center justify-between gap-2 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-slate-900">
                          {name} <span className="tabular-nums">{formatKgNum(l.qty_dispatched_kg)} kg</span>
                        </div>
                        <div className="truncate text-[11px] tabular-nums text-slate-500">
                          {formatRp(l.kitchen_unit_price_snapshot)}/kg • margin {formatRp(l.margin_per_kg_snapshot)}/kg
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {weighed ? (
                          <Badge tone={l.qty_shrinkage_kg > 0 ? 'red' : 'green'}>
                            ✓ {formatKgNum(l.qty_accepted_kg)}/{formatKgNum(l.qty_dispatched_kg)} kg
                          </Badge>
                        ) : (
                          <Badge tone="slate">Belum ditimbang</Badge>
                        )}
                        {!locked && (
                          <button
                            type="button"
                            onClick={() => handleRemoveLine(l.id, name)}
                            aria-label={`Hapus ${name} dari order ${title}`}
                            className="flex h-8 w-8 items-center justify-center rounded-md text-base text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <footer className="space-y-2 border-t border-slate-200 px-3 py-2.5">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="text-slate-600">
                    {progress === 'BAST_DONE' ? 'Tagihan Dapur' : 'Estimasi Tagihan Dapur'}
                  </span>
                  <span className="text-base font-extrabold tabular-nums text-slate-900">
                    {formatRp(invoice?.total_invoice_amount ?? 0)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="text-slate-600">Bagi hasil (Tim + Koperasi)</span>
                  <span className="font-semibold tabular-nums text-slate-800">{formatRp(marginTotal)}</span>
                </div>
                {!locked && (
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => startAddToKitchen(delivery.kitchen_id)}
                      className="btn-secondary min-h-[40px] text-xs"
                    >
                      + Tambah Barang
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteOrder(delivery.id, title)}
                      className="btn-secondary min-h-[40px] text-xs !text-rose-700"
                    >
                      Hapus Order
                    </button>
                  </div>
                )}
              </footer>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
