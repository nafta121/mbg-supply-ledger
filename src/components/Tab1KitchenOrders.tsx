'use client';

import React, { useRef, useState } from 'react';
import { type OrderLineInput, useMbgStore } from '../lib/mbg-store';
import { findOpenOrder, linesForDelivery, summarizeOrderDraft } from '../lib/order-engine';
import {
  formatKg,
  formatKgNum,
  formatRp,
  formatThousands,
  getJakartaTodayYmd,
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
  const openOrder = kitchen ? findOpenOrder(data, kitchen.id, todayYmd) : undefined;
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
    const title = `${kitchen.kitchen_code} · ${shortKitchenName(kitchen.name)}`;
    setToast({
      kind: 'ok',
      text: res.merged
        ? `${title}: ${res.count ?? filled.length} barang ditambahkan ke order hari ini.`
        : `${title}: order tersimpan (${res.count ?? filled.length} barang).`,
    });
    resetForm();
  };

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

  return (
    <section aria-label="Order Dapur" className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <h1 className="text-[20px] font-bold tracking-tight text-[#0a0a0a]">Order Dapur</h1>
          <p className="text-[12px] text-[#6b6b6b]">Input pesanan bahan baku dapur dan estimasi bagi hasil</p>
        </div>
        <span className="shrink-0 font-mono text-[12px] text-[#6b6b6b] tabular-nums">{todayYmd}</span>
      </div>

      <Toast toast={toast} onClose={() => setToast(null)} />

      <div ref={formRef} className="scroll-mt-16">
        <Card as="section" className="space-y-3.5 p-3.5">
          <div className="flex items-center justify-between border-b border-[#f0f0f0] pb-2.5">
            <h2 className="text-[15px] font-medium text-[#0a0a0a]">Buat Order Dapur Baru</h2>
            <span className="text-[12px] text-[#6b6b6b] tabular-nums">{summary.item_count} jenis</span>
          </div>

          {/* 1. Dapur tujuan */}
          <div className="space-y-1.5">
            <span className="field-label">Dapur Tujuan</span>
            {kitchen ? (
              <div className="flex items-center justify-between gap-2 rounded-[6px] border border-[#e6e6e6] bg-[#f8f9fa] px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-medium text-[#0a0a0a]">
                    <span className="font-mono text-[12px] text-[#6b6b6b]">{kitchen.kitchen_code}</span> ·{' '}
                    {shortKitchenName(kitchen.name)}
                  </div>
                  <div className="truncate text-[12px] text-[#6b6b6b]">PIC: {kitchen.pic_name}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setKitchenId(null)}
                  className="min-h-[32px] shrink-0 rounded-[6px] border border-[#d4d4d4] bg-white px-2.5 text-[12px] font-medium text-[#0a0a0a] hover:bg-[#f8f8f8]"
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
                  placeholder="Cari dapur (nama, kode, atau PIC)…"
                  value={kitchenQuery}
                  onChange={(e) => setKitchenQuery(e.target.value)}
                  className="field-input"
                />
                <ul
                  aria-label="Daftar dapur"
                  className="max-h-48 divide-y divide-[#f0f0f0] overflow-y-auto rounded-[6px] border border-[#e6e6e6] bg-white"
                >
                  {kitchenMatches.length === 0 && (
                    <li className="px-3 py-2.5 text-[12px] text-[#6b6b6b]">Dapur tidak ditemukan.</li>
                  )}
                  {kitchenMatches.map((k) => {
                    const hasOpen = !!findOpenOrder(data, k.id, todayYmd);
                    return (
                      <li key={k.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setKitchenId(k.id);
                            setFormError(null);
                          }}
                          className="flex min-h-[42px] w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[#f8f9fa]"
                        >
                          <span className="min-w-0 truncate text-[14px] text-[#0a0a0a]">
                            <span className="font-mono text-[12px] text-[#6b6b6b]">{k.kitchen_code}</span> ·{' '}
                            {shortKitchenName(k.name)}
                          </span>
                          {hasOpen && <Badge tone="amber">Order aktif</Badge>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {openOrder && (
              <p className="rounded-[6px] border border-[#fde68a] bg-[#fffbeb] px-2.5 py-1.5 text-[12px] text-[#92400e]">
                Dapur ini sudah memiliki order hari ini ({openOrder.delivery_number}). Barang baru akan digabung ke
                invoice yang sama.
              </p>
            )}
          </div>

          {/* 2. Daftar barang pesanan */}
          <div className="space-y-2">
            <span className="field-label">Daftar Barang Pesanan</span>
            {lines.map((l, idx) => {
              const chosenElsewhere = new Set(lines.filter((o) => o.key !== l.key).map((o) => o.item_id));
              const kg = parseKgInput(l.kgStr);
              const price = parseRpInput(l.priceStr);
              const lineTotal = kg > 0 && price > 0 ? summarizeOrderDraft([previewLines[idx]!]).estimated_invoice : 0;
              const idp = `ol-${l.key}`;
              return (
                <div key={l.key} className="space-y-2.5 rounded-[6px] border border-[#e6e6e6] bg-[#f8f9fa] p-2.5">
                  <div className="flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <label htmlFor={`${idp}-item`} className="mb-1 block text-[12px] font-medium text-[#6b6b6b]">
                        Barang {idx + 1}
                      </label>
                      <select
                        id={`${idp}-item`}
                        value={l.item_id}
                        onChange={(e) => pickItem(l.key, e.target.value)}
                        className="field-input"
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
                        className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-[6px] border border-[#d4d4d4] bg-white text-base text-[#6b6b6b] hover:bg-[#ffedea] hover:text-[#831c1e]"
                      >
                        ×
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label htmlFor={`${idp}-kg`} className="mb-1 block text-[12px] font-medium text-[#6b6b6b]">
                        Berat (kg)
                      </label>
                      <input
                        id={`${idp}-kg`}
                        type="text"
                        inputMode="decimal"
                        step="any"
                        placeholder="0"
                        value={l.kgStr}
                        onChange={(e) => patchLine(l.key, { kgStr: e.target.value })}
                        className="field-input text-right font-medium tabular-nums"
                      />
                    </div>
                    <div>
                      <label htmlFor={`${idp}-price`} className="mb-1 block text-[12px] font-medium text-[#6b6b6b]">
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
                      <label htmlFor={`${idp}-margin`} className="mb-1 block text-[12px] font-medium text-[#6b6b6b]">
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
              onClick={() => setLines((prev) => [...prev, emptyLine()])}
              className="btn-secondary min-h-[38px] w-full text-[13px]"
            >
              + Tambah Barang Lain
            </button>
          </div>

          {/* 3. Divided Ledger Summary Strip */}
          <div className="grid grid-cols-3 divide-x divide-[#e6e6e6] rounded-[6px] border border-[#e6e6e6] bg-[#f8f9fa]">
            <div className="px-2.5 py-2">
              <div className="text-[11px] text-[#6b6b6b]">Total Berat</div>
              <div className="mt-0.5 truncate text-[14px] font-medium tabular-nums text-[#0a0a0a]">
                {formatKgNum(summary.total_kg)} <span className="text-[12px] text-[#6b6b6b]">kg</span>
              </div>
            </div>
            <div className="px-2.5 py-2">
              <div className="text-[11px] text-[#6b6b6b]">Tagihan Dapur</div>
              <div className="mt-0.5 truncate text-[14px] font-bold tabular-nums text-[#0a0a0a]">
                {formatRp(summary.estimated_invoice)}
              </div>
            </div>
            <div className="px-2.5 py-2">
              <div className="text-[11px] text-[#6b6b6b]">Bagi Hasil</div>
              <div className="mt-0.5 truncate text-[14px] font-bold tabular-nums text-[#1d5fbf]">
                {formatRp(summary.estimated_margin)}
              </div>
            </div>
          </div>

          {formError && (
            <p role="alert" className="rounded-[6px] bg-[#ffedea] px-3 py-2 text-[13px] font-medium text-[#831c1e]">
              {formError}
            </p>
          )}

          <button type="button" onClick={submit} className="btn-primary min-h-[44px] w-full">
            Simpan Order Dapur
          </button>
        </Card>
      </div>

      {/* Daftar Order Dapur */}
      <div className="flex items-center justify-between gap-2 pt-2">
        <h2 className="text-[16px] font-medium text-[#0a0a0a]">Daftar Order Dapur</h2>
        <span className="text-[12px] text-[#6b6b6b] tabular-nums">{todayOrders.length} order</span>
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
        <Card className="p-6 text-center text-[13px] text-[#6b6b6b]">
          {filter === 'active' ? 'Belum ada order aktif.' : 'Belum ada order yang lunas.'}
        </Card>
      )}

      <div className="space-y-2.5">
        {shownOrders.map(({ delivery, kitchen: k, invoice, lines: ol }) => {
          const locked = invoice?.payment_status === 'PAID';
          const title = k ? `${k.kitchen_code} · ${shortKitchenName(k.name)}` : '-';
          const marginTotal = sumIdr(ol.map((l) => l.line_margin_amount));
          return (
            <Card as="article" key={delivery.id} className="overflow-hidden">
              <header className="flex items-start justify-between gap-2 border-b border-[#f0f0f0] px-3.5 py-2.5">
                <div className="min-w-0">
                  <h3 className="truncate text-[14px] font-medium text-[#0a0a0a]">{title}</h3>
                  <p className="truncate font-mono text-[11px] text-[#6b6b6b]">{delivery.delivery_number}</p>
                </div>
                <Badge tone={locked ? 'green' : 'amber'}>
                  {locked ? 'Lunas' : 'Belum Bayar'}
                </Badge>
              </header>
              <ul className="divide-y divide-[#f0f0f0] px-3.5">
                {ol.map((l) => {
                  const name = items.find((i) => i.id === l.item_id)?.name ?? 'Barang';
                  return (
                    <li key={l.id} className="flex items-center justify-between gap-2 py-2.5">
                      <div className="min-w-0">
                        <div className="truncate text-[14px] font-medium text-[#0a0a0a]">
                          {name}{' '}
                          <span className="font-normal text-[#6b6b6b] tabular-nums">
                            · {formatKgNum(l.qty_dispatched_kg)} kg
                          </span>
                        </div>
                        <div className="truncate text-[12px] tabular-nums text-[#6b6b6b]">
                          {formatRp(l.kitchen_unit_price_snapshot)}/kg · margin {formatRp(l.margin_per_kg_snapshot)}/kg
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-[13px] font-bold tabular-nums text-[#0a0a0a]">
                          {formatRp(l.line_invoice_amount)}
                        </span>
                        {!locked && (
                          <button
                            type="button"
                            onClick={() => handleRemoveLine(l.id, name)}
                            aria-label={`Hapus ${name} dari order ${title}`}
                            className="flex h-7 w-7 items-center justify-center rounded-[4px] text-base text-[#6b6b6b] hover:bg-[#ffedea] hover:text-[#831c1e]"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <footer className="space-y-2 border-t border-[#f0f0f0] bg-[#f8f9fa] px-3.5 py-2.5">
                <div className="flex items-baseline justify-between gap-2 text-[13px]">
                  <span className="text-[#6b6b6b]">Tagihan Dapur</span>
                  <span className="text-[15px] font-bold tabular-nums text-[#0a0a0a]">
                    {formatRp(invoice?.total_invoice_amount ?? 0)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-2 text-[12px]">
                  <span className="text-[#6b6b6b]">Bagi hasil (Tim + Koperasi)</span>
                  <span className="font-bold tabular-nums text-[#1d5fbf]">{formatRp(marginTotal)}</span>
                </div>
                {!locked && (
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => startAddToKitchen(delivery.kitchen_id)}
                      className="btn-secondary min-h-[36px] text-[12px]"
                    >
                      + Tambah Barang
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteOrder(delivery.id, title)}
                      className="btn-secondary min-h-[36px] text-[12px] !text-[#c4242a] hover:!bg-[#ffedea]"
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
