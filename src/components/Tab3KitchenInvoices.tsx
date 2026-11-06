'use client';

import React, { useMemo, useState } from 'react';
import { buildInvoiceLines, buildInvoiceWaText, resolvePaymentAccount, summarizeInvoice } from '../lib/invoice-view';
import { useMbgStore } from '../lib/mbg-store';
import { shareToWhatsApp } from '../lib/share';
import { formatKgNum, formatRp, INVOICE_LABEL, invoiceTone, shortKitchenName, sumIdr } from '../lib/ui-format';
import { ChevronDownIcon } from './Icons';
import {
  type GroupMode,
  OrderInvoiceEditSheet,
  sortAndGroupItems,
  SortGroupControls,
  type SortMode,
} from './OrderInvoiceEditSheet';
import { PrintableDocument, type PrintDocMode } from './PrintDocuments';
import { Badge, BottomSheet, Card, NoAccess, SegmentedControl, Toast, type ToastState } from './ui';

type InvFilter = 'unpaid' | 'paid' | 'all';

export function Tab3KitchenInvoices() {
  const store = useMbgStore();
  const { activeRole, isSyncing, invoices, kitchens, ledgerEntries, markInvoicePaid, deleteOrder } = store;

  const [invFilter, setInvFilter] = useState<InvFilter>('unpaid');
  const [sortBy, setSortBy] = useState<SortMode>('date_desc');
  const [groupBy, setGroupBy] = useState<GroupMode>('none');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [editingDeliveryId, setEditingDeliveryId] = useState<string | null>(null);
  const [confirmPaidId, setConfirmPaidId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [printDoc, setPrintDoc] = useState<PrintDocMode | null>(null);
  const [toast, setToast] = useState<ToastState>(null);

  const kitchenById = useMemo(() => new Map(kitchens.map((k) => [k.id, k])), [kitchens]);
  const unpaid = useMemo(() => invoices.filter((i) => i.payment_status !== 'PAID'), [invoices]);
  const paid = useMemo(() => invoices.filter((i) => i.payment_status === 'PAID'), [invoices]);
  const unpaidTotal = useMemo(() => sumIdr(unpaid.map((i) => i.total_invoice_amount)), [unpaid]);
  const paidTotal = useMemo(() => sumIdr(paid.map((i) => i.total_invoice_amount)), [paid]);
  const grandTotal = useMemo(() => sumIdr([unpaidTotal, paidTotal]), [unpaidTotal, paidTotal]);
  const paidPct = grandTotal > 0 ? Math.round((paidTotal / grandTotal) * 100) : 0;

  const filteredInvoices = invFilter === 'paid' ? paid : invFilter === 'unpaid' ? unpaid : invoices;
  const allExpanded = filteredInvoices.length > 0 && filteredInvoices.every((i) => expandedIds.has(i.id));
  const toggleCard = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleExpandAll = () =>
    setExpandedIds(allExpanded ? new Set() : new Set(filteredInvoices.map((i) => i.id)));

  const groupedInvoices = useMemo(
    () =>
      sortAndGroupItems(filteredInvoices, sortBy, groupBy, {
        getDate: (inv) => inv.invoice_date || '',
        getKitchenName: (inv) => {
          const k = kitchenById.get(inv.kitchen_id);
          return k ? shortKitchenName(k.name) : '-';
        },
        getKitchenCode: (inv) => kitchenById.get(inv.kitchen_id)?.kitchen_code ?? '-',
        getCode: (inv) => inv.invoice_number,
      }),
    [filteredInvoices, sortBy, groupBy, kitchenById]
  );

  if (activeRole === 'FIELD_TEAM') return <NoAccess />;

  const isAdmin = activeRole === 'OWNER_ADMIN' || activeRole === 'FINANCE';

  return (
    <section aria-label="Invoice Dapur" className="space-y-3.5">
      <div className="no-print space-y-3.5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-[20px] font-bold tracking-tight text-ink">Invoice Dapur</h1>
            <p className="text-[12px] text-muted">Rekap tagihan bahan baku dapur dan pelunasan</p>
          </div>
          <span className="inline-flex h-6 shrink-0 items-center rounded-[6px] border border-rule bg-white px-2.5 text-[11px] font-medium text-ink-2 tabular-nums">
            {invoices.length} invoice
          </span>
        </div>

        <Toast toast={toast} onClose={() => setToast(null)} />

        {/* Hairline-divided KPI Ledger Strip + Collection Progress */}
        <Card className="overflow-hidden">
          <div className="grid grid-cols-3 divide-x divide-rule">
            <div className="p-2.5 sm:p-3.5">
              <div className="text-[11px] text-muted">Belum Dibayar</div>
              <div className="mt-1 text-[13px] sm:text-[17px] font-bold tracking-tight tabular-nums text-ink">
                {formatRp(unpaidTotal)}
              </div>
              <div className="mt-0.5 text-[11px] text-muted tabular-nums">{unpaid.length} tagihan terbuka</div>
            </div>
            <div className="p-2.5 sm:p-3.5">
              <div className="text-[11px] text-muted">Sudah Lunas</div>
              <div className="mt-1 text-[13px] sm:text-[17px] font-bold tracking-tight tabular-nums text-success">
                {formatRp(paidTotal)}
              </div>
              <div className="mt-0.5 text-[11px] text-muted tabular-nums">{paid.length} tagihan selesai</div>
            </div>
            <div className="p-2.5 sm:p-3.5">
              <div className="text-[11px] text-muted">Total Tagihan</div>
              <div className="mt-1 text-[13px] sm:text-[17px] font-bold tracking-tight tabular-nums text-ink">
                {formatRp(grandTotal)}
              </div>
              <div className="mt-0.5 text-[11px] text-muted tabular-nums">{paidPct}% terbayar</div>
            </div>
          </div>
          <div className="border-t border-rule bg-paper-2 px-3.5 py-2">
            <div aria-hidden="true" className="flex h-1.5 w-full overflow-hidden rounded-[4px] bg-paper-3">
              <div style={{ width: `${paidPct}%` }} className="h-full bg-success" />
            </div>
          </div>
        </Card>

        <div className="space-y-3.5 lg:grid lg:grid-cols-12 lg:items-start lg:gap-4 lg:space-y-0">
          <div className="space-y-3.5 lg:col-span-5 lg:sticky lg:top-28">
            {/* Unified Invoice Filter & Sort/Group Toolbar */}
            <div className="ledger-toolbar">
              <div className="hs-card-header bg-paper-2">
                <h2 className="text-[15px] font-medium text-ink">Filter &amp; Urutan Invoice</h2>
                <span className="inline-flex h-6 items-center rounded-[6px] border border-rule bg-white px-2 text-[11px] font-medium text-ink-2 tabular-nums">
                  {filteredInvoices.length} tampil
                </span>
              </div>
              <div className="space-y-2.5 p-3">
                <SegmentedControl
                  label="Filter status invoice"
                  value={invFilter}
                  onChange={setInvFilter}
                  options={[
                    { value: 'unpaid', label: `Belum Bayar (${unpaid.length})` },
                    { value: 'paid', label: `Lunas (${paid.length})` },
                    { value: 'all', label: `Semua (${invoices.length})` },
                  ]}
                />

                <SortGroupControls
                  sortBy={sortBy}
                  onSortChange={setSortBy}
                  groupBy={groupBy}
                  onGroupChange={setGroupBy}
                  idPrefix="invoice"
                  allExpanded={allExpanded}
                  onToggleExpandAll={toggleExpandAll}
                  itemCount={filteredInvoices.length}
                />
              </div>
            </div>
          </div>

          <div className="space-y-3.5 lg:col-span-7">
            {filteredInvoices.length === 0 && (
              <Card className="p-6 text-center text-[13px] text-muted">Tidak ada invoice pada filter ini.</Card>
            )}

            <div className="space-y-4">
          {groupedInvoices.map((bucket) => {
            const bucketTotal = sumIdr(bucket.items.map((i) => i.total_invoice_amount));
            return (
              <div key={bucket.key} className="space-y-2.5">
                {groupBy !== 'none' && (
                  <div className="flex items-center justify-between gap-2 rounded-[6px] border border-rule bg-group px-3 py-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      {bucket.sublabel && (
                        <span className="shrink-0 rounded-[4px] border border-control bg-white px-1.5 py-0.5 font-mono text-[11px] font-medium text-ink-2">
                          {bucket.sublabel}
                        </span>
                      )}
                      <span className="truncate text-[13px] font-bold text-ink">{bucket.label}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-right text-[11px] font-medium text-ink-2 tabular-nums">
                      <span>{bucket.items.length} invoice</span>
                      <span className="font-bold text-ink">{formatRp(bucketTotal)}</span>
                    </div>
                  </div>
                )}

                <div className="space-y-3">
                  {bucket.items.map((inv) => {
                    const kitchen = kitchenById.get(inv.kitchen_id);
                    const lines = buildInvoiceLines(store, inv);
                    const summary = summarizeInvoice(lines);
                    const account = resolvePaymentAccount(store, inv);
                    const isPaid = inv.payment_status === 'PAID';
                    const hasPaidOut = ledgerEntries.some(
                      (le) => le.invoice_id === inv.id && le.payout_status === 'PAID_OUT'
                    );
                    const title = kitchen ? `${kitchen.kitchen_code} — ${shortKitchenName(kitchen.name)}` : '-';
                    const isExpanded = expandedIds.has(inv.id);
                    const firstExpandedUnpaidId = filteredInvoices.find(
                      (i) => i.payment_status !== 'PAID' && expandedIds.has(i.id)
                    )?.id;

                    return (
                      <Card as="article" key={inv.id} className="overflow-hidden">
                        <button
                          type="button"
                          aria-expanded={isExpanded}
                          onClick={() => toggleCard(inv.id)}
                          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-paper-2"
                        >
                          <div className="min-w-0">
                            <h2 className="truncate text-[14px] font-medium text-ink">{title}</h2>
                            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-muted tabular-nums">
                              <span>{inv.invoice_date}</span>
                              <span>{inv.invoice_number}</span>
                              <span>
                                {summary.line_count} brg ({formatKgNum(summary.total_accepted_kg)} kg)
                              </span>
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <div className="flex flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-2">
                              <span className="text-[13px] font-bold tabular-nums text-ink">
                                {formatRp(inv.total_invoice_amount)}
                              </span>
                              <Badge tone={invoiceTone(inv.payment_status)}>{INVOICE_LABEL[inv.payment_status]}</Badge>
                            </div>
                            <ChevronDownIcon
                              className={`h-4 w-4 shrink-0 text-muted transition-transform motion-reduce:transition-none ${
                                isExpanded ? 'rotate-180' : ''
                              }`}
                            />
                          </div>
                        </button>

                        {isExpanded && (
                          <>
                            <ul className="divide-y divide-rule-2 border-t border-rule px-4">
                              {lines.map((l) => (
                                <li key={l.id} className="space-y-0.5 py-2.5 text-[13px]">
                                  <div className="flex items-baseline justify-between gap-2">
                                    <span className="min-w-0 truncate font-medium text-ink">{l.item_name}</span>
                                    <span className="shrink-0 font-bold tabular-nums text-ink">
                                      {formatRp(l.line_total)}
                                    </span>
                                  </div>
                                  <div className="text-[12px] tabular-nums text-muted">
                                    {formatKgNum(l.qty_accepted_kg)} kg × {formatRp(l.unit_price)}
                                  </div>
                                  {l.weighed && l.qty_shrinkage_kg > 0 && (
                                    <div className="text-[11px] text-error">
                                      Order {formatKgNum(l.qty_ordered_kg)} kg, selisih -
                                      {formatKgNum(l.qty_shrinkage_kg)} kg tidak ditagih
                                      {l.reason ? ` (${l.reason})` : ''}
                                    </div>
                                  )}
                                </li>
                              ))}
                            </ul>

                            <div className="hs-card-footer space-y-2.5">
                              <div className="flex items-end justify-between gap-2">
                                <span className="text-[12px] text-muted">
                                  Total Tagihan Dapur
                                  <span className="flex items-center gap-x-2 tabular-nums text-muted">
                                    <span>{summary.line_count} barang</span>
                                    <span>({formatKgNum(summary.total_accepted_kg)} kg)</span>
                                  </span>
                                </span>
                                <span className="text-[20px] font-bold tracking-tight tabular-nums text-ink">
                                  {formatRp(inv.total_invoice_amount)}
                                </span>
                              </div>

                              <div className="rounded-[6px] border border-rule bg-paper-2 px-3 py-2 text-[12px]">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-muted">Supplier</span>
                                  <span className="truncate font-medium text-ink">
                                    {account.supplier_name ?? 'Supplier MBG'}
                                  </span>
                                </div>
                                <div className="mt-1 flex items-center justify-between gap-2 border-t border-paper-3 pt-1">
                                  <span className="text-muted">Rekening</span>
                                  <span className="flex flex-wrap items-center justify-end gap-x-1.5 truncate font-mono text-[11px] font-medium text-ink">
                                    <span>{account.payment_bank_name}</span>
                                    <span>{account.payment_account_number}</span>
                                    <span>({account.payment_account_holder})</span>
                                  </span>
                                </div>
                              </div>

                              {isAdmin && (
                                <div className="space-y-2 pt-0.5">
                                  {!isPaid &&
                                    (confirmPaidId === inv.id ? (
                                      <div className="flex items-center justify-between gap-2 rounded-[6px] border border-rule bg-white px-3 py-2">
                                        <span className="text-[13px] font-medium text-ink">Tandai lunas?</span>
                                        <div className="flex items-center gap-1.5">
                                          <button
                                            type="button"
                                            disabled={isSyncing}
                                            onClick={async () => {
                                              setConfirmPaidId(null);
                                              const res = await markInvoicePaid(inv.id);
                                              if (!res.ok) {
                                                setToast({ kind: 'error', text: res.error });
                                                return;
                                              }
                                              setToast({
                                                kind: 'ok',
                                                text: 'Invoice berhasil ditandai Lunas.',
                                              });
                                            }}
                                            className="btn-primary min-h-[40px] px-3 text-[12px]"
                                          >
                                            Ya
                                          </button>
                                          <button
                                            type="button"
                                            disabled={isSyncing}
                                            onClick={() => setConfirmPaidId(null)}
                                            className="btn-secondary min-h-[40px] px-3 text-[12px]"
                                          >
                                            Tidak
                                          </button>
                                        </div>
                                      </div>
                                    ) : (
                                      <button
                                        type="button"
                                        disabled={isSyncing}
                                        onClick={() => setConfirmPaidId(inv.id)}
                                        className={`${inv.id === firstExpandedUnpaidId ? 'btn-primary' : 'btn-secondary'} w-full`}
                                      >
                                        Tandai Lunas
                                      </button>
                                    ))}
                                  <div className={`grid gap-2 ${!hasPaidOut ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'}`}>
                                    {!hasPaidOut && (
                                      <button
                                        type="button"
                                        onClick={() => setEditingDeliveryId(inv.delivery_id)}
                                        className="btn-secondary min-h-[40px] px-2 text-[12px]"
                                      >
                                        Edit Invoice
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => setPrintDoc({ type: 'INVOICE', invoiceId: inv.id })}
                                      className="btn-secondary min-h-[40px] px-2 text-[12px]"
                                    >
                                      Cetak / PDF
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        void shareToWhatsApp(kitchen?.pic_phone, buildInvoiceWaText(store, inv)).then(
                                          (ok) =>
                                            setToast(
                                              ok
                                                ? { kind: 'ok', text: 'Tagihan disalin & WhatsApp dibuka.' }
                                                : {
                                                    kind: 'error',
                                                    text: 'Gagal menyalin otomatis. WhatsApp tetap dibuka.',
                                                  }
                                            )
                                        )
                                      }
                                      className="btn-secondary min-h-[40px] px-2 text-[12px]"
                                    >
                                      Salin &amp; WA
                                    </button>
                                    <button
                                      type="button"
                                      disabled={isSyncing}
                                      onClick={() => setConfirmDeleteId(inv.id)}
                                      className="btn-secondary min-h-[40px] border-error-border px-2 text-[12px] !text-error hover:!bg-error-bg"
                                    >
                                      Hapus Invoice
                                    </button>
                                    {hasPaidOut && (
                                      <p className="col-span-3 pt-0.5 text-[11px] text-muted">
                                        Pengeditan invoice dikunci karena bagi hasil sudah dicairkan.
                                      </p>
                                    )}
                                  </div>
                                  {confirmDeleteId === inv.id && (
                                    <div className="flex items-center justify-between gap-2 rounded-[6px] border border-error-border bg-error-bg px-3 py-2">
                                      <span className="text-[13px] font-medium text-error-ink">
                                        Hapus invoice {inv.invoice_number}?
                                      </span>
                                      <div className="flex shrink-0 items-center gap-1.5">
                                        <button
                                          type="button"
                                          disabled={isSyncing}
                                          onClick={async () => {
                                            setConfirmDeleteId(null);
                                            const res = await deleteOrder(inv.delivery_id);
                                            if (!res.ok) {
                                              setToast({ kind: 'error', text: res.error });
                                              return;
                                            }
                                            setToast({
                                              kind: 'ok',
                                              text: `Invoice ${inv.invoice_number} (${title}) dihapus.`,
                                            });
                                          }}
                                          className="btn-primary min-h-[40px] !border-error !bg-error px-3 text-[12px]"
                                        >
                                          Ya
                                        </button>
                                        <button
                                          type="button"
                                          disabled={isSyncing}
                                          onClick={() => setConfirmDeleteId(null)}
                                          className="btn-secondary min-h-[40px] bg-white px-3 text-[12px]"
                                        >
                                          Tidak
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
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
        </div>
      </div>
    </div>

      <OrderInvoiceEditSheet
        deliveryId={editingDeliveryId}
        mode="invoice"
        onClose={() => setEditingDeliveryId(null)}
        onSaved={(msg) => setToast({ kind: 'ok', text: msg })}
      />

      {/* Accessible On-screen print preview via BottomSheet */}
      <BottomSheet
        open={Boolean(printDoc)}
        title="Pratinjau Invoice"
        onClose={() => setPrintDoc(null)}
        headerActions={
          <button
            type="button"
            onClick={() => window.print()}
            className="btn-primary min-h-[40px] px-3 text-[12px]"
          >
            Cetak / PDF
          </button>
        }
      >
        {printDoc && <PrintableDocument doc={printDoc} />}
      </BottomSheet>

      <div className="print-only p-6">{printDoc && <PrintableDocument doc={printDoc} />}</div>
    </section>
  );
}
