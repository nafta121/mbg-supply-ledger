'use client';

import React, { useState } from 'react';
import { formatIdr, useMbgStore } from '../lib/mbg-store';
import {
  formatKgNum,
  formatRp,
  INVOICE_LABEL,
  invoiceTone,
  SETTLEMENT_LABEL,
  shortKitchenName,
  sumIdr,
  toWaNumber,
} from '../lib/ui-format';
import { PrintableDocument, type PrintDocMode } from './PrintDocuments';
import { Badge, Card, NoAccess, SegmentedControl, StatRow, Toast, type ToastState } from './ui';

type SubView = 'kitchen' | 'supplier';
type InvFilter = 'unpaid' | 'paid' | 'all';

export function Tab4InvoicesAndSettlements() {
  const {
    activeRole,
    invoices,
    kitchens,
    deliveries,
    deliveryItems,
    items,
    suppliers,
    batches,
    supplierSettlements,
    markInvoicePaid,
    markSupplierSettlementPaid,
  } = useMbgStore();

  const [subView, setSubView] = useState<SubView>('kitchen');
  const [invFilter, setInvFilter] = useState<InvFilter>('unpaid');
  const [printDoc, setPrintDoc] = useState<PrintDocMode | null>(null);
  const [toast, setToast] = useState<ToastState>(null);

  if (activeRole === 'FIELD_TEAM') return <NoAccess />;

  const isAdmin = activeRole === 'OWNER_ADMIN' || activeRole === 'FINANCE';
  // Supplier cost data is Admin/Finance only (Invariant 5).
  const view: SubView = isAdmin ? subView : 'kitchen';

  const unpaidTotal = sumIdr(
    invoices.filter((i) => i.payment_status !== 'PAID').map((i) => i.total_invoice_amount)
  );
  const paidTotal = sumIdr(
    invoices.filter((i) => i.payment_status === 'PAID').map((i) => i.total_invoice_amount)
  );
  const unpaidCount = invoices.filter((i) => i.payment_status !== 'PAID').length;

  const filteredInvoices = invoices.filter((inv) => {
    if (invFilter === 'paid') return inv.payment_status === 'PAID';
    if (invFilter === 'unpaid') return inv.payment_status !== 'PAID';
    return true;
  });

  const openPrint = (doc: PrintDocMode) => {
    setPrintDoc(doc);
    setTimeout(() => window.print(), 150);
  };

  const copyText = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fall through to legacy copy
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  };

  const shareToWhatsApp = (phone: string | null | undefined, text: string) => {
    // Start the copy while this document still has focus, then open WhatsApp
    // synchronously inside the click handler so popup blockers allow it.
    const copied = copyText(text);
    const num = toWaNumber(phone);
    const url = `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
    void copied.then((ok) =>
      setToast(
        ok
          ? { kind: 'ok', text: 'Ringkasan tagihan disalin & siap ditempel ke Grup WA' }
          : { kind: 'error', text: 'Gagal menyalin otomatis. WhatsApp tetap dibuka.' }
      )
    );
  };

  return (
    <section aria-label="Tagihan" className="space-y-3">
      <div className="no-print space-y-3">
        {isAdmin && (
          <SegmentedControl<SubView>
            label="Jenis tagihan"
            value={view}
            onChange={setSubView}
            options={[
              { value: 'kitchen', label: 'Tagihan Dapur' },
              { value: 'supplier', label: 'Bayar Supplier' },
            ]}
          />
        )}

        <Toast toast={toast} onClose={() => setToast(null)} />

        {view === 'kitchen' ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Card className="p-3">
                <div className="text-xs font-medium text-slate-600">Belum Bayar</div>
                <div className="truncate text-base font-bold tabular-nums text-rose-700">
                  {formatRp(unpaidTotal)}
                </div>
              </Card>
              <Card className="p-3">
                <div className="text-xs font-medium text-slate-600">Lunas</div>
                <div className="truncate text-base font-bold tabular-nums text-emerald-700">
                  {formatRp(paidTotal)}
                </div>
              </Card>
            </div>

            <div role="group" aria-label="Filter status" className="flex gap-2">
              {(
                [
                  { v: 'unpaid', l: `Belum Bayar (${unpaidCount})` },
                  { v: 'paid', l: `Lunas (${invoices.length - unpaidCount})` },
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

            {filteredInvoices.length === 0 && (
              <Card className="p-6 text-center text-sm font-medium text-slate-600">
                Tidak ada tagihan.
              </Card>
            )}

            <div className="space-y-2">
              {filteredInvoices.map((inv) => {
                const kitchen = kitchens.find((k) => k.id === inv.kitchen_id);
                const deliv = deliveries.find((d) => d.id === inv.delivery_id);
                const ditem = deliveryItems.find((di) => di.delivery_id === inv.delivery_id);
                const item = items.find((i) => i.id === ditem?.item_id);
                const paid = inv.payment_status === 'PAID';

                const waText = [
                  `Invoice ${inv.invoice_number}`,
                  `${kitchen?.name ?? '-'}`,
                  `${item?.name ?? '-'}: ${formatKgNum(ditem?.qty_accepted_kg ?? 0)} kg`,
                  `Total: ${formatIdr(inv.total_invoice_amount)}`,
                  `Status: ${INVOICE_LABEL[inv.payment_status]}`,
                  `Jatuh tempo: ${inv.due_date}`,
                ].join('\n');

                return (
                  <Card as="article" key={inv.id} className="space-y-2.5 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-bold text-slate-900">
                          {kitchen ? `${kitchen.kitchen_code} • ${shortKitchenName(kitchen.name)}` : '-'}
                        </h3>
                        <p className="truncate text-xs text-slate-600">
                          {item?.name ?? '-'} •{' '}
                          <span className="font-semibold tabular-nums text-slate-800">
                            {formatKgNum(ditem?.qty_accepted_kg ?? 0)} kg
                          </span>
                        </p>
                      </div>
                      <Badge tone={invoiceTone(inv.payment_status)}>
                        {INVOICE_LABEL[inv.payment_status]}
                      </Badge>
                    </div>

                    <div className="text-2xl font-extrabold tabular-nums tracking-tight text-slate-900">
                      {formatRp(inv.total_invoice_amount)}
                    </div>

                    {isAdmin && (
                      <>
                        {!paid && (
                          <button
                            type="button"
                            onClick={() => {
                              markInvoicePaid(inv.id);
                              setToast({
                                kind: 'ok',
                                text: `${shortKitchenName(kitchen?.name ?? '')} lunas. Bagi hasil siap cair.`,
                              });
                            }}
                            className="btn-primary w-full"
                          >
                            ✓ Tandai Lunas
                          </button>
                        )}
                        <div className="grid grid-cols-3 gap-2">
                          <button
                            type="button"
                            onClick={() => openPrint({ type: 'INVOICE', invoiceId: inv.id })}
                            className="btn-secondary min-h-[40px] px-1 text-xs"
                          >
                            🖨️ PDF Invoice
                          </button>
                          <button
                            type="button"
                            onClick={() => shareToWhatsApp(kitchen?.pic_phone, waText)}
                            className="btn-secondary min-h-[40px] px-1 text-xs"
                          >
                            💬 WA
                          </button>
                          <button
                            type="button"
                            disabled={!deliv}
                            onClick={() => openPrint({ type: 'BAST', deliveryId: inv.delivery_id })}
                            className="btn-secondary min-h-[40px] px-1 text-xs"
                          >
                            📄 Surat Jalan
                          </button>
                        </div>
                      </>
                    )}
                  </Card>
                );
              })}
            </div>
          </>
        ) : (
          <div className="space-y-2">
            {supplierSettlements.length === 0 && (
              <Card className="p-6 text-center text-sm font-medium text-slate-600">
                Belum ada tagihan supplier.
              </Card>
            )}
            {supplierSettlements.map((stl) => {
              const supplier = suppliers.find((s) => s.id === stl.supplier_id);
              const batch = batches.find((b) => b.id === stl.supplier_batch_id);
              const item = items.find((i) => i.id === batch?.item_id);
              const paid = stl.status === 'PAID';

              return (
                <Card as="article" key={stl.id} className="space-y-2.5 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-bold text-slate-900">{supplier?.name ?? '-'}</h3>
                      <p className="truncate text-xs text-slate-600">
                        {item?.name ?? '-'} • {formatRp(stl.supplier_actual_cost_per_kg)}/kg
                      </p>
                    </div>
                    <Badge tone={paid ? 'green' : 'red'}>{SETTLEMENT_LABEL[stl.status]}</Badge>
                  </div>

                  <div className="space-y-1.5 rounded-lg bg-slate-50 p-2.5 ring-1 ring-inset ring-slate-200">
                    <StatRow
                      label={`Kirim Awal (${formatKgNum(stl.total_dispatched_kg)} kg)`}
                      value={formatRp(stl.gross_payable_amount)}
                    />
                    <StatRow
                      tone="red"
                      label={`Potongan Susut Dapur (${formatKgNum(stl.total_shrinkage_claim_kg)} kg)`}
                      value={`-${formatRp(stl.shrinkage_claim_deduction_amount)}`}
                    />
                    <div className="border-t border-slate-300 pt-1.5">
                      <StatRow
                        strong
                        tone="green"
                        label="Total Bersih Dibayar"
                        value={formatRp(stl.net_payable_amount)}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => openPrint({ type: 'SUPPLIER_CLAIM', settlementId: stl.id })}
                      className="btn-secondary min-h-[40px] text-xs"
                    >
                      🖨️ Nota Potongan
                    </button>
                    <button
                      type="button"
                      disabled={paid}
                      onClick={() => {
                        markSupplierSettlementPaid(stl.id);
                        setToast({
                          kind: 'ok',
                          text: `${supplier?.name ?? 'Supplier'} dibayar ${formatRp(stl.net_payable_amount)}.`,
                        });
                      }}
                      className="btn-primary min-h-[40px] text-xs"
                    >
                      {paid ? '✓ Sudah Dibayar' : 'Verifikasi Bayar'}
                    </button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
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
                <button
                  type="button"
                  onClick={() => setPrintDoc(null)}
                  className="btn-secondary min-h-[36px] text-xs"
                >
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
