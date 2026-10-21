'use client';

import React, { useState } from 'react';
import { buildInvoiceLines, buildInvoiceWaText, summarizeInvoice } from '../lib/invoice-view';
import { useMbgStore } from '../lib/mbg-store';
import { shareToWhatsApp } from '../lib/share';
import { formatKgNum, formatRp, INVOICE_LABEL, invoiceTone, shortKitchenName, sumIdr } from '../lib/ui-format';
import { PrintableDocument, type PrintDocMode } from './PrintDocuments';
import { Badge, Card, NoAccess, Toast, type ToastState } from './ui';

type InvFilter = 'unpaid' | 'paid' | 'all';

/**
 * Tab 3 — "Invoice Dapur": 100% tagihan ke dapur (tanpa sub-tab supplier).
 * 1 Invoice Dapur Gabungan (multi-barang) per Order Dapur; each line is billed
 * on qty_accepted_kg × Harga Dapur / kg (Invariant 2).
 */
export function Tab3KitchenInvoices() {
  const store = useMbgStore();
  const { activeRole, invoices, kitchens, markInvoicePaid } = store;

  const [invFilter, setInvFilter] = useState<InvFilter>('unpaid');
  const [printDoc, setPrintDoc] = useState<PrintDocMode | null>(null);
  const [toast, setToast] = useState<ToastState>(null);

  if (activeRole === 'FIELD_TEAM') return <NoAccess />;

  const isAdmin = activeRole === 'OWNER_ADMIN' || activeRole === 'FINANCE';

  const unpaid = invoices.filter((i) => i.payment_status !== 'PAID');
  const paid = invoices.filter((i) => i.payment_status === 'PAID');
  const unpaidTotal = sumIdr(unpaid.map((i) => i.total_invoice_amount));
  const paidTotal = sumIdr(paid.map((i) => i.total_invoice_amount));

  const filteredInvoices = (invFilter === 'paid' ? paid : invFilter === 'unpaid' ? unpaid : invoices)
    .slice()
    .sort((a, b) => a.invoice_number.localeCompare(b.invoice_number, 'id'));

  const openPrint = (doc: PrintDocMode) => {
    setPrintDoc(doc);
  };

  return (
    <section aria-label="Invoice Dapur" className="space-y-3">
      <div className="no-print space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Card className="p-3">
            <div className="text-xs font-medium text-slate-600">Belum Dibayar Dapur</div>
            <div className="truncate text-base font-bold tabular-nums text-rose-700">{formatRp(unpaidTotal)}</div>
          </Card>
          <Card className="p-3">
            <div className="text-xs font-medium text-slate-600">Sudah Lunas</div>
            <div className="truncate text-base font-bold tabular-nums text-emerald-700">{formatRp(paidTotal)}</div>
          </Card>
        </div>

        <div role="group" aria-label="Filter status" className="flex gap-2">
          {(
            [
              { v: 'unpaid', l: `Belum Bayar (${unpaid.length})` },
              { v: 'paid', l: `Lunas (${paid.length})` },
              { v: 'all', l: `Semua (${invoices.length})` },
            ] as const
          ).map((f) => (
            <button
              key={f.v}
              type="button"
              aria-pressed={invFilter === f.v}
              onClick={() => setInvFilter(f.v)}
              className={`min-h-[36px] rounded-full px-3 text-xs font-semibold transition ${
                invFilter === f.v
                  ? 'bg-slate-900 text-white'
                  : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
              }`}
            >
              {f.l}
            </button>
          ))}
        </div>

        <Toast toast={toast} onClose={() => setToast(null)} />

        {filteredInvoices.length === 0 && (
          <Card className="p-6 text-center text-sm font-medium text-slate-600">Tidak ada invoice.</Card>
        )}

        <div className="space-y-2">
          {filteredInvoices.map((inv) => {
            const kitchen = kitchens.find((k) => k.id === inv.kitchen_id);
            const lines = buildInvoiceLines(store, inv);
            const summary = summarizeInvoice(lines);
            const isPaid = inv.payment_status === 'PAID';
            const title = kitchen ? `${kitchen.kitchen_code} • ${shortKitchenName(kitchen.name)}` : '-';

            return (
              <Card as="article" key={inv.id} className="space-y-2.5 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-bold text-slate-900">{title}</h3>
                    <p className="truncate font-mono text-[11px] text-slate-500">{inv.invoice_number}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge tone={invoiceTone(inv.payment_status)}>{INVOICE_LABEL[inv.payment_status]}</Badge>
                  </div>
                </div>

                <ul className="divide-y divide-slate-100 rounded-lg bg-slate-50 px-2.5 ring-1 ring-inset ring-slate-200">
                  {lines.map((l) => (
                    <li key={l.id} className="space-y-0.5 py-1.5 text-xs">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate font-semibold text-slate-800">{l.item_name}</span>
                        <span className="shrink-0 font-bold tabular-nums text-slate-900">{formatRp(l.line_total)}</span>
                      </div>
                      <div className="tabular-nums text-slate-600">
                        {formatKgNum(l.qty_accepted_kg)} kg × {formatRp(l.unit_price)} = {formatRp(l.line_total)}
                      </div>
                      {l.weighed && l.qty_shrinkage_kg > 0 && (
                        <div className="text-rose-700">
                          Order {formatKgNum(l.qty_ordered_kg)} kg, selisih -{formatKgNum(l.qty_shrinkage_kg)} kg tidak
                          ditagih{l.reason ? ` • ${l.reason}` : ''}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>

                <div className="flex items-end justify-between gap-2">
                  <span className="text-xs font-medium text-slate-600">
                    Total Tagihan Dapur
                    <span className="block tabular-nums text-slate-500">
                      {summary.line_count} barang • {formatKgNum(summary.total_accepted_kg)} kg
                    </span>
                  </span>
                  <span className="text-2xl font-extrabold tabular-nums tracking-tight text-slate-900">
                    {formatRp(inv.total_invoice_amount)}
                  </span>
                </div>

                {isAdmin && (
                  <>
                    {!isPaid && (
                      <button
                        type="button"
                        onClick={async () => {
                          const res = await markInvoicePaid(inv.id);
                          setToast(
                            res.ok
                              ? { kind: 'ok', text: `${title} lunas. Bagi hasil siap dicairkan.` }
                              : { kind: 'error', text: res.error }
                          );
                        }}
                        className="btn-primary w-full"
                      >
                        ✓ Tandai Lunas
                      </button>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => openPrint({ type: 'INVOICE', invoiceId: inv.id })}
                        className="btn-secondary min-h-[40px] px-1 text-xs leading-tight"
                      >
                        🖨️ PDF Invoice Dapur
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void shareToWhatsApp(kitchen?.pic_phone, buildInvoiceWaText(store, inv)).then((ok) =>
                            setToast(
                              ok
                                ? { kind: 'ok', text: 'Tagihan disalin & WhatsApp dibuka.' }
                                : { kind: 'error', text: 'Gagal menyalin otomatis. WhatsApp tetap dibuka.' }
                            )
                          )
                        }
                        className="btn-secondary min-h-[40px] px-1 text-xs leading-tight"
                      >
                        💬 Salin &amp; WA Tagihan
                      </button>
                    </div>
                  </>
                )}
              </Card>
            );
          })}
        </div>
      </div>

      {/* On-screen print preview */}
      {printDoc && (
        <div className="no-print fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Pratinjau dokumen"
            className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl"
          >
            <div className="mb-3 flex items-center justify-between gap-2 border-b border-slate-200 pb-2">
              <span className="text-sm font-bold text-slate-900">Pratinjau</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => window.print()} className="btn-primary min-h-[36px] text-xs">
                  🖨️ Cetak / PDF
                </button>
                <button type="button" onClick={() => setPrintDoc(null)} className="btn-secondary min-h-[36px] text-xs">
                  Tutup
                </button>
              </div>
            </div>
            <PrintableDocument doc={printDoc} />
          </div>
        </div>
      )}

      <div className="print-only p-6">{printDoc && <PrintableDocument doc={printDoc} />}</div>
    </section>
  );
}
