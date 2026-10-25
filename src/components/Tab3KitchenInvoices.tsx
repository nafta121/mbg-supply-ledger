'use client';

import React, { useState } from 'react';
import { buildInvoiceLines, buildInvoiceWaText, resolvePaymentAccount, summarizeInvoice } from '../lib/invoice-view';
import { useMbgStore } from '../lib/mbg-store';
import { shareToWhatsApp } from '../lib/share';
import { formatKgNum, formatRp, INVOICE_LABEL, invoiceTone, shortKitchenName, sumIdr } from '../lib/ui-format';
import { PrintableDocument, type PrintDocMode } from './PrintDocuments';
import { Badge, Card, NoAccess, Toast, type ToastState } from './ui';

type InvFilter = 'unpaid' | 'paid' | 'all';

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

  return (
    <section aria-label="Invoice Dapur" className="space-y-3.5">
      <div className="no-print space-y-3.5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-[20px] font-bold tracking-tight text-[#0a0a0a]">Invoice Dapur</h1>
            <p className="text-[12px] text-[#6b6b6b]">Rekap tagihan bahan baku dapur dan pelunasan</p>
          </div>
          <span className="inline-flex h-6 shrink-0 items-center rounded-[6px] border border-[#e6e6e6] bg-white px-2.5 text-[11px] font-medium text-[#3d3d3d] tabular-nums">
            {invoices.length} invoice
          </span>
        </div>

        {/* Preline Divided KPI Stat Card */}
        <Card className="grid grid-cols-2 divide-x divide-[#e6e6e6] overflow-hidden">
          <div className="p-4">
            <div className="inline-flex items-center gap-1.5 text-[12px] text-[#6b6b6b]">
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[#92400e]" />
              Belum Dibayar Dapur
            </div>
            <div className="mt-1 truncate text-[20px] font-bold tracking-tight tabular-nums text-[#0a0a0a]">
              {formatRp(unpaidTotal)}
            </div>
            <div className="mt-0.5 text-[11px] text-[#6b6b6b] tabular-nums">{unpaid.length} tagihan terbuka</div>
          </div>
          <div className="p-4">
            <div className="inline-flex items-center gap-1.5 text-[12px] text-[#6b6b6b]">
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[#2e7d32]" />
              Sudah Lunas
            </div>
            <div className="mt-1 truncate text-[20px] font-bold tracking-tight tabular-nums text-[#2e7d32]">
              {formatRp(paidTotal)}
            </div>
            <div className="mt-0.5 text-[11px] text-[#6b6b6b] tabular-nums">{paid.length} tagihan selesai</div>
          </div>
        </Card>

        <div role="group" aria-label="Filter status" className="flex gap-1.5">
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
              className={`min-h-[34px] rounded-[6px] px-3 text-[12px] font-medium transition-colors ${
                invFilter === f.v
                  ? 'bg-[#141414] text-white'
                  : 'border border-[#d4d4d4] bg-white text-[#3d3d3d] hover:bg-[#f8f9fa]'
              }`}
            >
              {f.l}
            </button>
          ))}
        </div>

        <Toast toast={toast} onClose={() => setToast(null)} />

        {filteredInvoices.length === 0 && (
          <Card className="p-6 text-center text-[13px] text-[#6b6b6b]">Tidak ada invoice pada filter ini.</Card>
        )}

        <div className="space-y-3">
          {filteredInvoices.map((inv) => {
            const kitchen = kitchens.find((k) => k.id === inv.kitchen_id);
            const lines = buildInvoiceLines(store, inv);
            const summary = summarizeInvoice(lines);
            const account = resolvePaymentAccount(store, inv);
            const isPaid = inv.payment_status === 'PAID';
            const title = kitchen ? `${kitchen.kitchen_code} · ${shortKitchenName(kitchen.name)}` : '-';

            return (
              <Card as="article" key={inv.id} className="overflow-hidden">
                <div className="hs-card-header">
                  <div className="min-w-0">
                    <h2 className="truncate text-[14px] font-medium text-[#0a0a0a]">{title}</h2>
                    <p className="truncate font-mono text-[11px] text-[#6b6b6b]">{inv.invoice_number}</p>
                  </div>
                  <Badge tone={invoiceTone(inv.payment_status)}>{INVOICE_LABEL[inv.payment_status]}</Badge>
                </div>

                <ul className="divide-y divide-[#f0f0f0] px-4">
                  {lines.map((l) => (
                    <li key={l.id} className="space-y-0.5 py-2.5 text-[13px]">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate font-medium text-[#0a0a0a]">{l.item_name}</span>
                        <span className="shrink-0 font-bold tabular-nums text-[#0a0a0a]">{formatRp(l.line_total)}</span>
                      </div>
                      <div className="text-[12px] tabular-nums text-[#6b6b6b]">
                        {formatKgNum(l.qty_accepted_kg)} kg × {formatRp(l.unit_price)}
                      </div>
                      {l.weighed && l.qty_shrinkage_kg > 0 && (
                        <div className="text-[11px] text-[#c4242a]">
                          Order {formatKgNum(l.qty_ordered_kg)} kg, selisih -{formatKgNum(l.qty_shrinkage_kg)} kg tidak
                          ditagih{l.reason ? ` · ${l.reason}` : ''}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>

                <div className="hs-card-footer space-y-2.5">
                  <div className="flex items-end justify-between gap-2">
                    <span className="text-[12px] text-[#6b6b6b]">
                      Total Tagihan Dapur
                      <span className="block tabular-nums text-[#6b6b6b]">
                        {summary.line_count} barang · {formatKgNum(summary.total_accepted_kg)} kg
                      </span>
                    </span>
                    <span className="text-[20px] font-bold tracking-tight tabular-nums text-[#0a0a0a]">
                      {formatRp(inv.total_invoice_amount)}
                    </span>
                  </div>

                  <div className="rounded-[6px] border border-[#e6e6e6] bg-[#f8f9fa] px-3 py-2 text-[12px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[#6b6b6b]">Supplier</span>
                      <span className="truncate font-medium text-[#0a0a0a]">
                        {account.supplier_name ?? 'Supplier MBG'}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 border-t border-[#eeeeee] pt-1">
                      <span className="text-[#6b6b6b]">Rekening</span>
                      <span className="truncate font-mono text-[11px] font-medium text-[#0a0a0a]">
                        {account.payment_bank_name} · {account.payment_account_number} ({account.payment_account_holder})
                      </span>
                    </div>
                  </div>

                  {isAdmin && (
                    <div className="space-y-2 pt-0.5">
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
                          Tandai Lunas
                        </button>
                      )}
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setPrintDoc({ type: 'INVOICE', invoiceId: inv.id })}
                          className="btn-secondary min-h-[36px] px-2 text-[12px]"
                        >
                          Cetak / PDF Invoice
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
                          className="btn-secondary min-h-[36px] px-2 text-[12px]"
                        >
                          Salin &amp; Kirim WA
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      {/* On-screen print preview */}
      {printDoc && (
        <div className="no-print fixed inset-0 z-50 flex items-end justify-center bg-[#0a0a0a]/40 sm:items-center sm:p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Pratinjau dokumen"
            className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-[12px] border border-[#e6e6e6] bg-white p-4 sm:rounded-[10px]"
          >
            <div className="mb-3 flex items-center justify-between gap-2 border-b border-[#e6e6e6] pb-3">
              <span className="text-[15px] font-medium text-[#0a0a0a]">Pratinjau Invoice</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => window.print()} className="btn-primary min-h-[34px] text-[12px]">
                  Cetak / PDF
                </button>
                <button type="button" onClick={() => setPrintDoc(null)} className="btn-secondary min-h-[34px] text-[12px]">
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
