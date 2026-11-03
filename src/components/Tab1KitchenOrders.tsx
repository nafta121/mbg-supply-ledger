'use client';

import React, { useMemo, useRef, useState } from 'react';
import { type OrderLineInput, useMbgStore } from '../lib/mbg-store';
import { findOpenOrder, linesForDelivery, summarizeOrderDraft } from '../lib/order-engine';
import {
  formatKgNum,
  formatRp,
  formatThousands,
  getJakartaTodayYmd,
  parseKgInput,
  parseRpInput,
  shortKitchenName,
  sumIdr,
} from '../lib/ui-format';
import { ChevronDownIcon } from './Icons';
import {
  emptyDraftLine,
  type GroupMode,
  type OrderDraftLine,
  OrderInvoiceEditSheet,
  OrderLinesSection,
  sortAndGroupItems,
  SortGroupControls,
  type SortMode,
} from './OrderInvoiceEditSheet';
import { Badge, Card, NoAccess, SegmentedControl, Toast, type ToastState } from './ui';

type ListFilter = 'active' | 'paid';

export function Tab1KitchenOrders() {
  const {
    activeRole,
    kitchens,
    items,
    deliveries,
    deliveryItems,
    invoices,
    ledgerEntries,
    createOrder,
    removeOrderLine,
    deleteOrder,
  } = useMbgStore();

  const todayYmd = getJakartaTodayYmd();
  const [kitchenId, setKitchenId] = useState<string | null>(null);
  const [kitchenQuery, setKitchenQuery] = useState('');
  const [orderDate, setOrderDate] = useState<string>(() => getJakartaTodayYmd());
  const [lines, setLines] = useState<OrderDraftLine[]>(() => [emptyDraftLine()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [filter, setFilter] = useState<ListFilter>('active');
  const [sortBy, setSortBy] = useState<SortMode>('date_desc');
  const [groupBy, setGroupBy] = useState<GroupMode>('none');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [editingDeliveryId, setEditingDeliveryId] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const kitchenById = useMemo(() => new Map(kitchens.map((k) => [k.id, k])), [kitchens]);
  const itemById = useMemo(() => new Map(items.map((it) => [it.id, it])), [items]);

  const allOrders = useMemo(
    () =>
      deliveries.map((d) => ({
        delivery: d,
        kitchen: kitchenById.get(d.kitchen_id),
        invoice: invoices.find((i) => i.delivery_id === d.id),
        lines: deliveryItems.filter((di) => di.delivery_id === d.id),
      })),
    [deliveries, kitchenById, invoices, deliveryItems]
  );
  const activeOrders = useMemo(() => allOrders.filter((o) => o.invoice?.payment_status !== 'PAID'), [allOrders]);
  const paidOrders = useMemo(() => allOrders.filter((o) => o.invoice?.payment_status === 'PAID'), [allOrders]);
  const shownOrders = filter === 'active' ? activeOrders : paidOrders;
  const allExpanded = shownOrders.length > 0 && shownOrders.every((o) => expandedIds.has(o.delivery.id));
  const toggleCard = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleExpandAll = () =>
    setExpandedIds(allExpanded ? new Set() : new Set(shownOrders.map((o) => o.delivery.id)));

  const groupedOrders = useMemo(
    () =>
      sortAndGroupItems(shownOrders, sortBy, groupBy, {
        getDate: (o) => o.delivery.delivery_date || o.invoice?.invoice_date || '',
        getKitchenName: (o) => (o.kitchen ? shortKitchenName(o.kitchen.name) : '-'),
        getKitchenCode: (o) => o.kitchen?.kitchen_code ?? '-',
        getCode: (o) => o.delivery.delivery_number,
      }),
    [shownOrders, sortBy, groupBy]
  );

  if (activeRole !== 'OWNER_ADMIN' && activeRole !== 'FINANCE') return <NoAccess />;

  const targetDate = orderDate || todayYmd;
  const data = { deliveries, deliveryItems, invoices };
  const kitchen = kitchenId ? (kitchenById.get(kitchenId) ?? null) : null;
  const openOrder = kitchen ? findOpenOrder(data, kitchen.id, targetDate) : undefined;
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

  const patchLine = (key: number, patch: Partial<OrderDraftLine>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const pickItem = (key: number, itemId: string) => {
    const it = itemById.get(itemId);
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
    setLines([emptyDraftLine()]);
    setFormError(null);
  };

  const startAddToKitchen = (id: string, dateYmd?: string) => {
    setKitchenId(id);
    if (dateYmd) setOrderDate(dateYmd);
    setLines([emptyDraftLine()]);
    setFormError(null);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const submit = async () => {
    if (!kitchen) {
      setFormError('Pilih dapur tujuan dulu.');
      return;
    }
    const filled = orderLines.filter((l, idx) => l.item_id || lines[idx]!.kgStr.trim() !== '');
    const res = await createOrder({ kitchen_id: kitchen.id, order_date: targetDate, lines: filled });
    if (!res.ok) {
      setFormError(res.error);
      return;
    }
    const title = `${kitchen.kitchen_code} · ${shortKitchenName(kitchen.name)}`;
    setToast({
      kind: 'ok',
      text: res.merged
        ? `${title}: ${res.count ?? filled.length} barang ditambahkan ke order (${targetDate}).`
        : `${title}: order tersimpan (${res.count ?? filled.length} barang).`,
    });
    resetForm();
  };

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
    <section aria-label="Order Dapur" className="space-y-3.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-[20px] font-bold tracking-tight text-[#0a0a0a]">Order Dapur</h1>
          <p className="text-[12px] text-[#6b6b6b]">Input pesanan bahan baku dapur dan estimasi bagi hasil</p>
        </div>
        <span className="inline-flex h-6 shrink-0 items-center rounded-[6px] border border-[#e6e6e6] bg-white px-2.5 font-mono text-[11px] font-medium text-[#3d3d3d] tabular-nums">
          {todayYmd}
        </span>
      </div>

      <Toast toast={toast} onClose={() => setToast(null)} />

      <div ref={formRef} className="scroll-mt-16">
        <Card as="section" className="overflow-hidden">
          <div className="hs-card-header bg-[#f8f9fa]">
            <h2 className="text-[15px] font-medium text-[#0a0a0a]">Buat Order Dapur Baru</h2>
            <span className="inline-flex h-6 items-center rounded-[6px] border border-[#e6e6e6] bg-white px-2 text-[11px] font-medium text-[#3d3d3d] tabular-nums">
              {summary.item_count} jenis
            </span>
          </div>

          <div className="space-y-4 p-4">
            {/* Tanggal Order */}
            <div className="space-y-1.5">
              <label htmlFor="order-date-input" className="field-label">
                Tanggal Order
              </label>
              <input
                id="order-date-input"
                type="date"
                value={orderDate}
                onChange={(e) => {
                  setOrderDate(e.target.value);
                  setFormError(null);
                }}
                className="field-input tabular-nums"
              />
            </div>

            {/* 1. Dapur tujuan (Preline Searchbox + List Group) */}
            <div className="space-y-1.5">
              <span className="field-label">Dapur Tujuan</span>
              {kitchen ? (
                <div className="flex items-center justify-between gap-2 rounded-[6px] border border-[#e6e6e6] bg-[#f8f9fa] px-3 py-2.5">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-1.5 truncate text-[14px] font-medium text-[#0a0a0a]">
                      <span className="rounded-[4px] border border-[#e6e6e6] bg-white px-1.5 py-0.5 font-mono text-[11px] text-[#3d3d3d]">
                        {kitchen.kitchen_code}
                      </span>
                      <span className="truncate">{shortKitchenName(kitchen.name)}</span>
                    </div>
                    <div className="truncate text-[12px] text-[#6b6b6b]">PIC: {kitchen.pic_name}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setKitchenId(null)}
                    className="min-h-[32px] shrink-0 rounded-[6px] border border-[#d4d4d4] bg-white px-2.5 text-[12px] font-medium text-[#0a0a0a] hover:bg-[#f2f4f7]"
                  >
                    Ganti
                  </button>
                </div>
              ) : (
                <>
                  <label htmlFor="order-kitchen-search" className="sr-only">
                    Cari dapur
                  </label>
                  <div className="relative">
                    <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-[#6b6b6b]">
                      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                        <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.75" />
                        <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
                      </svg>
                    </div>
                    <input
                      id="order-kitchen-search"
                      type="search"
                      placeholder="Cari dapur (nama, kode, atau PIC)…"
                      value={kitchenQuery}
                      onChange={(e) => setKitchenQuery(e.target.value)}
                      className="field-input pl-9 pr-8"
                    />
                    {kitchenQuery && (
                      <button
                        type="button"
                        aria-label="Bersihkan pencarian dapur"
                        onClick={() => setKitchenQuery('')}
                        className="absolute inset-y-0 right-0 flex items-center pr-2.5 text-base text-[#6b6b6b] hover:text-[#0a0a0a]"
                      >
                        ×
                      </button>
                    )}
                  </div>
                  <ul
                    aria-label="Daftar dapur"
                    className="max-h-48 divide-y divide-[#f0f0f0] overflow-y-auto rounded-[6px] border border-[#e6e6e6] bg-white"
                  >
                    {kitchenMatches.length === 0 && (
                      <li className="px-3 py-2.5 text-[12px] text-[#6b6b6b]">Dapur tidak ditemukan.</li>
                    )}
                    {kitchenMatches.map((k) => {
                      const hasOpen = !!findOpenOrder(data, k.id, targetDate);
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
                            <span className="flex min-w-0 items-center gap-2 truncate text-[14px] text-[#0a0a0a]">
                              <span className="shrink-0 rounded-[4px] border border-[#e6e6e6] bg-[#f8f9fa] px-1.5 py-0.5 font-mono text-[11px] text-[#6b6b6b]">
                                {k.kitchen_code}
                              </span>
                              <span className="truncate">{shortKitchenName(k.name)}</span>
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
                <p className="rounded-[6px] border border-[#fde68a] bg-[#fffbeb] px-3 py-2 text-[12px] text-[#92400e]">
                  Dapur ini sudah memiliki order pada tanggal {targetDate} ({openOrder.delivery_number}). Barang baru
                  akan digabung ke invoice yang sama.
                </p>
              )}
            </div>

            {/* 2 & 3. Daftar barang pesanan + Divided Ledger Summary Strip */}
            <OrderLinesSection
              lines={lines}
              items={items}
              previewLines={previewLines}
              summary={summary}
              idPrefix="ol"
              sectionLabel="Daftar Barang Pesanan"
              kgLabel="Berat (kg)"
              invoiceTotalLabel="Tagihan Dapur"
              disabledItemIds={openItemIds}
              onPickItem={pickItem}
              onPatchLine={patchLine}
              onRemoveLine={(key) => setLines((prev) => prev.filter((o) => o.key !== key))}
              onAddLine={() => setLines((prev) => [...prev, emptyDraftLine()])}
            />

            {formError && (
              <p role="alert" className="rounded-[6px] border border-[#f5c2c0] bg-[#ffedea] px-3 py-2 text-[13px] font-medium text-[#831c1e]">
                {formError}
              </p>
            )}

            <button type="button" onClick={submit} className="btn-primary min-h-[44px] w-full">
              Simpan Order Dapur
            </button>
          </div>
        </Card>
      </div>

      {/* Daftar Order Dapur */}
      <div className="flex items-center justify-between gap-2 pt-2">
        <h2 className="text-[16px] font-medium text-[#0a0a0a]">Daftar Order Dapur</h2>
        <span className="inline-flex h-6 items-center rounded-[6px] border border-[#e6e6e6] bg-white px-2 text-[11px] font-medium text-[#3d3d3d] tabular-nums">
          {allOrders.length} order
        </span>
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

      <SortGroupControls
        sortBy={sortBy}
        onSortChange={setSortBy}
        groupBy={groupBy}
        onGroupChange={setGroupBy}
        idPrefix="order"
        allExpanded={allExpanded}
        onToggleExpandAll={toggleExpandAll}
        itemCount={shownOrders.length}
      />

      {shownOrders.length === 0 && (
        <Card className="p-6 text-center text-[13px] text-[#6b6b6b]">
          {filter === 'active' ? 'Belum ada order aktif.' : 'Belum ada order yang lunas.'}
        </Card>
      )}

      <div className="space-y-4">
        {groupedOrders.map((bucket) => {
          const bucketTotal = sumIdr(bucket.items.map((o) => o.invoice?.total_invoice_amount ?? 0));
          return (
            <div key={bucket.key} className="space-y-2.5">
              {groupBy !== 'none' && (
                <div className="flex items-center justify-between gap-2 rounded-[6px] border border-[#e6e6e6] bg-[#e9edf2] px-3 py-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    {bucket.sublabel && (
                      <span className="shrink-0 rounded-[4px] border border-[#d4d4d4] bg-white px-1.5 py-0.5 font-mono text-[11px] font-medium text-[#3d3d3d]">
                        {bucket.sublabel}
                      </span>
                    )}
                    <span className="truncate text-[13px] font-bold text-[#0a0a0a]">{bucket.label}</span>
                  </div>
                  <div className="shrink-0 text-right text-[11px] font-medium text-[#3d3d3d] tabular-nums">
                    {bucket.items.length} order · <span className="font-bold text-[#0a0a0a]">{formatRp(bucketTotal)}</span>
                  </div>
                </div>
              )}

              <div className="space-y-3">
                {bucket.items.map(({ delivery, kitchen: k, invoice, lines: ol }) => {
                  const locked = invoice?.payment_status === 'PAID';
                  const hasPaidOut = invoice
                    ? ledgerEntries.some((le) => le.invoice_id === invoice.id && le.payout_status === 'PAID_OUT')
                    : false;
                  const title = k ? `${k.kitchen_code} · ${shortKitchenName(k.name)}` : '-';
                  const marginTotal = sumIdr(ol.map((l) => l.line_margin_amount));
                  const totalKg = ol.reduce((acc, l) => acc + l.qty_dispatched_kg, 0);
                  const isExpanded = expandedIds.has(delivery.id);
                  return (
                    <Card as="article" key={delivery.id} className="overflow-hidden">
                      <button
                        type="button"
                        aria-expanded={isExpanded}
                        onClick={() => toggleCard(delivery.id)}
                        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-[#f8f9fa]"
                      >
                        <div className="min-w-0">
                          <h3 className="truncate text-[14px] font-medium text-[#0a0a0a]">{title}</h3>
                          <p className="truncate font-mono text-[11px] text-[#6b6b6b] tabular-nums">
                            {delivery.delivery_date} · {delivery.delivery_number} · {ol.length} brg (
                            {formatKgNum(totalKg)} kg)
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <div className="text-right">
                            <div className="text-[13px] font-bold tabular-nums text-[#0a0a0a]">
                              {formatRp(invoice?.total_invoice_amount ?? 0)}
                            </div>
                            <div className="text-[11px] font-medium tabular-nums text-[#1d5fbf]">
                              Margin {formatRp(marginTotal)}
                            </div>
                          </div>
                          <Badge tone={locked ? 'green' : 'amber'}>{locked ? 'Lunas' : 'Belum Bayar'}</Badge>
                          <ChevronDownIcon
                            className={`h-4 w-4 shrink-0 text-[#6b6b6b] transition-transform ${
                              isExpanded ? 'rotate-180' : ''
                            }`}
                          />
                        </div>
                      </button>

                      {isExpanded && (
                        <>
                          <ul className="divide-y divide-[#f0f0f0] border-t border-[#e6e6e6] px-4">
                            {ol.map((l) => {
                              const name = itemById.get(l.item_id)?.name ?? 'Barang';
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
                                      {formatRp(l.kitchen_unit_price_snapshot)}/kg · margin{' '}
                                      {formatRp(l.margin_per_kg_snapshot)}/kg
                                    </div>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-2">
                                    <span className="text-[13px] font-bold tabular-nums text-[#0a0a0a]">
                                      {formatRp(l.line_invoice_amount)}
                                    </span>
                                    {!locked && !hasPaidOut && (
                                      <button
                                        type="button"
                                        onClick={() => handleRemoveLine(l.id, name)}
                                        aria-label={`Hapus ${name} dari order ${title}`}
                                        className="flex h-7 w-7 items-center justify-center rounded-[4px] border border-transparent text-base text-[#6b6b6b] hover:border-[#f5c2c0] hover:bg-[#ffedea] hover:text-[#831c1e]"
                                      >
                                        ×
                                      </button>
                                    )}
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                          <footer className="hs-card-footer space-y-2">
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
                            {!hasPaidOut && (
                              <div className={`grid gap-2 pt-1 ${locked ? 'grid-cols-1' : 'grid-cols-3'}`}>
                                <button
                                  type="button"
                                  onClick={() => setEditingDeliveryId(delivery.id)}
                                  className="btn-secondary min-h-[36px] text-[12px]"
                                >
                                  Edit Order
                                </button>
                                {!locked && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => startAddToKitchen(delivery.kitchen_id, delivery.delivery_date)}
                                      className="btn-secondary min-h-[36px] text-[12px]"
                                    >
                                      + Tambah Barang
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteOrder(delivery.id, title)}
                                      className="btn-secondary min-h-[36px] border-[#f5c2c0] text-[12px] !text-[#c4242a] hover:!bg-[#ffedea]"
                                    >
                                      Hapus Order
                                    </button>
                                  </>
                                )}
                              </div>
                            )}
                          </footer>
                        </>
                      )}
                    </Card>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <OrderInvoiceEditSheet
        deliveryId={editingDeliveryId}
        mode="order"
        onClose={() => setEditingDeliveryId(null)}
        onSaved={(msg) => setToast({ kind: 'ok', text: msg })}
      />
    </section>
  );
}
