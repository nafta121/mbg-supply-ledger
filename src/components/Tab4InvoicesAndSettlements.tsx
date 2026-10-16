'use client';

import React, { useState } from 'react';
import { formatIdr, formatKg, useMbgStore } from '../lib/mbg-store';

type PrintDocMode =
  | { type: 'INVOICE'; invoiceId: string }
  | { type: 'BAST'; deliveryId: string }
  | { type: 'SUPPLIER_CLAIM'; settlementId: string };

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
    ledgerEntries,
    markInvoicePaid,
    markSupplierSettlementPaid,
    setActiveTab,
  } = useMbgStore();

  const [subView, setSubView] = useState<'INVOICES' | 'SUPPLIER_SETTLEMENTS'>('INVOICES');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'UNPAID' | 'PAID'>('ALL');
  const [printDoc, setPrintDoc] = useState<PrintDocMode | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const isFieldTeam = activeRole === 'FIELD_TEAM';
  const isOwnerOrFinance = activeRole === 'OWNER_ADMIN' || activeRole === 'FINANCE';

  if (isFieldTeam) {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-rose-500/40 bg-rose-950/40 p-4 text-rose-100 shadow-lg">
          <div className="text-sm font-bold uppercase tracking-wider text-rose-300">
            🔒 Akses Invoice & Tagihan Supplier Dibatasi (Invariant 5)
          </div>
          <p className="mt-2 text-xs leading-relaxed text-rose-200/90">
            Role <strong>FIELD_TEAM</strong> hanya diizinkan mengakses kuantitas berat (<code>kg</code>)
            dan Surat Jalan / BAST tanpa harga.
          </p>
          <button
            type="button"
            onClick={() => setActiveTab('bast')}
            className="mt-3 w-full rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-rose-500"
          >
            Kembali ke Layar BAST Timbang Terima →
          </button>
        </div>
      </div>
    );
  }

  const copyWhatsAppText = async (text: string, label: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
      setToastMsg(`✓ Ringkasan WhatsApp (${label}) berhasil disalin ke Clipboard!`);
    } catch {
      setToastMsg(`✓ Ringkasan WhatsApp (${label}): ${text.slice(0, 80)}...`);
    }
  };

  const triggerPdfPrint = (doc: PrintDocMode) => {
    setPrintDoc(doc);
    setTimeout(() => {
      if (typeof window !== 'undefined') {
        window.print();
      }
    }, 120);
  };

  const filteredInvoices = invoices.filter((inv) => {
    if (statusFilter === 'PAID') return inv.payment_status === 'PAID';
    if (statusFilter === 'UNPAID') return inv.payment_status !== 'PAID';
    return true;
  });

  const totalInvoicedAmount = invoices.reduce((s, i) => s + i.total_invoice_amount, 0);
  const totalPaidAmount = invoices
    .filter((i) => i.payment_status === 'PAID')
    .reduce((s, i) => s + i.total_invoice_amount, 0);

  return (
    <div className="space-y-4">
      {/* Main Screen (Hidden during @media print when printDoc is active) */}
      <div className="no-print space-y-4">
        {/* Sub-Navigation Switcher */}
        <div className="grid grid-cols-2 gap-1.5 rounded-2xl border border-slate-800 bg-slate-900 p-1.5">
          <button
            type="button"
            onClick={() => setSubView('INVOICES')}
            className={`rounded-xl py-2 text-xs font-bold transition ${
              subView === 'INVOICES'
                ? 'bg-emerald-600 text-white shadow'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            🧾 Invoice Dapur ({invoices.length})
          </button>
          <button
            type="button"
            onClick={() => setSubView('SUPPLIER_SETTLEMENTS')}
            className={`rounded-xl py-2 text-xs font-bold transition ${
              subView === 'SUPPLIER_SETTLEMENTS'
                ? 'bg-amber-600 text-white shadow'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            🚛 Settlement Supplier ({supplierSettlements.length})
          </button>
        </div>

        {toastMsg && (
          <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/70 px-3 py-2 text-xs text-emerald-200 flex items-center justify-between">
            <span>{toastMsg}</span>
            <button
              type="button"
              onClick={() => setToastMsg(null)}
              className="ml-2 text-[11px] font-bold text-emerald-300"
            >
              ✕
            </button>
          </div>
        )}

        {subView === 'INVOICES' ? (
          <div className="space-y-3">
            {/* Summary Cards */}
            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-3">
                <div className="text-[10px] uppercase text-slate-400">
                  Total Tagihan Dapur MBG
                </div>
                <div className="mt-1 font-mono text-xs font-bold text-white">
                  {formatIdr(totalInvoicedAmount)}
                </div>
              </div>
              <div className="rounded-2xl border border-emerald-500/30 bg-emerald-950/30 p-3">
                <div className="text-[10px] uppercase text-emerald-300">
                  Total Terverifikasi PAID
                </div>
                <div className="mt-1 font-mono text-xs font-bold text-emerald-400">
                  {formatIdr(totalPaidAmount)}
                </div>
              </div>
            </div>

            {/* Filter Pills */}
            <div className="flex items-center gap-1.5">
              {(['ALL', 'UNPAID', 'PAID'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setStatusFilter(f)}
                  className={`rounded-lg px-3 py-1 text-[11px] font-bold transition ${
                    statusFilter === f
                      ? 'bg-slate-200 text-slate-900'
                      : 'bg-slate-900 text-slate-400 border border-slate-800'
                  }`}
                >
                  {f === 'ALL' ? 'Semua' : f === 'PAID' ? '✓ Sudah PAID' : '⏳ Belum Lunas'}
                </button>
              ))}
            </div>

            {/* Daftar Invoice Dapur */}
            {filteredInvoices.map((inv) => {
              const kitchen = kitchens.find((k) => k.id === inv.kitchen_id);
              const deliv = deliveries.find((d) => d.id === inv.delivery_id);
              const ditem = deliveryItems.find((di) => di.delivery_id === inv.delivery_id);
              const item = items.find((i) => i.id === ditem?.item_id);
              const linkedLedger = ledgerEntries.filter((le) => le.invoice_id === inv.id);
              const teamProfit =
                linkedLedger.find((le) => le.beneficiary_type === 'TEAM')?.profit_amount ?? 0;
              const coopProfit =
                linkedLedger.find((le) => le.beneficiary_type === 'COOPERATIVE')
                  ?.profit_amount ?? 0;

              const waInvoiceSummary = [
                `*INVOICE DAPUR MBG — ${inv.invoice_number}*`,
                `Dapur: ${kitchen?.name ?? '-'}`,
                `Tanggal: ${inv.invoice_date} (No. SJ: ${deliv?.delivery_number ?? '-'})`,
                `Komoditas: ${item?.name ?? '-'}`,
                `Bobot Kirim: ${formatKg(ditem?.qty_dispatched_kg ?? 0)}`,
                `Bobot Diterima BAST: *${formatKg(ditem?.qty_accepted_kg ?? 0)}*`,
                `Harga Satuan Dapur: ${formatIdr(ditem?.kitchen_unit_price_snapshot ?? 0)}/kg`,
                `*Total Tagihan Dapur: ${formatIdr(inv.total_invoice_amount)}*`,
                `Status Pembayaran: *${inv.payment_status}*`,
              ].join('\n');

              const waBastSummary = [
                `*SURAT JALAN & BAST TIMBANGAN — ${deliv?.delivery_number ?? '-'}*`,
                `Dapur Tujuan: ${kitchen?.name ?? '-'}`,
                `PIC Dapur: ${kitchen?.pic_name ?? '-'}`,
                `Komoditas: ${item?.name ?? '-'}`,
                `Bobot Kirim Awal: ${formatKg(ditem?.qty_dispatched_kg ?? 0)}`,
                `Bobot Bersih Diterima: *${formatKg(ditem?.qty_accepted_kg ?? 0)}*`,
                `Susut/Reject: ${formatKg(ditem?.qty_shrinkage_kg ?? 0)}`,
                `Catatan BAST: ${ditem?.rejection_reason ?? 'Diterima utuh sesuai Surat Jalan'}`,
              ].join('\n');

              return (
                <div
                  key={inv.id}
                  className="rounded-2xl border border-slate-800 bg-slate-900/90 p-3.5 shadow-lg space-y-3"
                >
                  <div className="flex items-start justify-between gap-2 border-b border-slate-800 pb-2.5">
                    <div>
                      <span className="inline-block rounded bg-slate-800 px-2 py-0.5 font-mono text-[10px] font-bold text-emerald-300">
                        {inv.invoice_number}
                      </span>
                      <h4 className="mt-1 text-xs font-bold text-white">{kitchen?.name}</h4>
                      <p className="text-[11px] text-slate-400">
                        {item?.name} • BAST Terima:{' '}
                        <strong className="font-mono text-white">
                          {formatKg(ditem?.qty_accepted_kg ?? 0)}
                        </strong>
                        {(ditem?.qty_shrinkage_kg ?? 0) > 0 && (
                          <span className="ml-1 text-amber-400">
                            (Susut -{formatKg(ditem?.qty_shrinkage_kg ?? 0)})
                          </span>
                        )}
                      </p>
                    </div>

                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                        inv.payment_status === 'PAID'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                          : inv.payment_status === 'PARTIALLY_PAID'
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                          : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                      }`}
                    >
                      {inv.payment_status}
                    </span>
                  </div>

                  {/* Rincian Angka Invoice */}
                  <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-950/90 p-2.5 text-xs">
                    <div>
                      <div className="text-[10px] text-slate-400">Harga Dapur / kg</div>
                      <div className="font-mono font-semibold text-slate-200">
                        {formatIdr(ditem?.kitchen_unit_price_snapshot ?? 0)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] text-slate-400">Total Tagihan Dapur</div>
                      <div className="font-mono font-bold text-emerald-400">
                        {formatIdr(inv.total_invoice_amount)}
                      </div>
                    </div>
                  </div>

                  {/* Info Trigger Bagi Hasil */}
                  <div className="rounded-xl border border-slate-800/80 bg-slate-950/60 px-2.5 py-2 text-[11px] flex items-center justify-between">
                    <span className="text-slate-400">
                      Status Ledger Bagi Hasil (Tim {formatIdr(teamProfit)} | Kop{' '}
                      {formatIdr(coopProfit)}):
                    </span>
                    <span
                      className={`font-mono text-[10px] font-bold ${
                        inv.payment_status === 'PAID' ? 'text-emerald-400' : 'text-amber-400'
                      }`}
                    >
                      {inv.payment_status === 'PAID'
                        ? '🔓 AVAILABLE_FOR_PAYOUT'
                        : '🔒 LOCKED_UNPAID'}
                    </span>
                  </div>

                  {/* Tombol Tandai Lunas (PAID) */}
                  {isOwnerOrFinance && inv.payment_status !== 'PAID' && (
                    <button
                      type="button"
                      onClick={() => {
                        markInvoicePaid(inv.id);
                        setToastMsg(
                          `✓ Invoice ${inv.invoice_number} ditandai PAID! Saldo bagi hasil Tim (${formatIdr(teamProfit)}) & Koperasi (${formatIdr(coopProfit)}) otomatis terbuka (AVAILABLE_FOR_PAYOUT).`
                        );
                      }}
                      className="w-full rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white shadow transition hover:bg-emerald-500"
                    >
                      ✓ Tandai Lunas (PAID) & Buka Kunci Bagi Hasil
                    </button>
                  )}

                  {/* Baris Tombol Cetak PDF & Salin WA */}
                  <div className="grid grid-cols-2 gap-1.5 pt-1">
                    <button
                      type="button"
                      onClick={() => triggerPdfPrint({ type: 'INVOICE', invoiceId: inv.id })}
                      className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-slate-700"
                    >
                      🖨️ Print PDF Invoice
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        copyWhatsAppText(waInvoiceSummary, `Invoice ${inv.invoice_number}`)
                      }
                      className="rounded-lg border border-emerald-500/40 bg-emerald-950/50 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-900/50"
                    >
                      📲 WA Ringkasan Invoice
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        triggerPdfPrint({
                          type: 'BAST',
                          deliveryId: inv.delivery_id,
                        })
                      }
                      className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold text-sky-300 hover:bg-slate-700"
                    >
                      🖨️ Print PDF Surat Jalan
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        copyWhatsAppText(waBastSummary, `BAST ${deliv?.delivery_number}`)
                      }
                      className="rounded-lg border border-sky-500/40 bg-sky-950/50 px-2.5 py-1.5 text-[11px] font-semibold text-sky-300 hover:bg-sky-900/50"
                    >
                      📲 WA Ringkasan BAST
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* Daftar Tagihan Bersih Supplier (Setelah Dipotong Susut Dapur) */
          <div className="space-y-3">
            <div className="rounded-2xl border border-amber-500/30 bg-amber-950/30 p-3 text-xs text-amber-200">
              <strong>Invariant 2 (Zero-Shrinkage Risk):</strong> Kewajiban bayar ke Supplier
              dihitung murni dari <code>total_accepted_by_kitchens_kg × supplier_actual_cost_per_kg</code>.
              Seluruh susut/reject saat BAST di dapur memotong tagihan Supplier 100%.
            </div>

            {supplierSettlements.map((stl) => {
              const supplier = suppliers.find((s) => s.id === stl.supplier_id);
              const batch = batches.find((b) => b.id === stl.supplier_batch_id);
              const item = items.find((i) => i.id === batch?.item_id);

              const waClaimText = [
                `*NOTA REKONSILIASI & POTONGAN SUSUT SUPPLIER — ${stl.settlement_number}*`,
                `Supplier: ${supplier?.name ?? '-'} (${supplier?.supplier_code ?? '-'})`,
                `Batch: ${batch?.batch_code ?? '-'} (${item?.name ?? '-'})`,
                `Bobot Kirim Awal: ${formatKg(stl.total_dispatched_kg)}`,
                `Bobot Diterima Dapur (BAST): ${formatKg(stl.total_accepted_by_kitchens_kg)}`,
                `Potongan Susut/Reject Dapur: *-${formatKg(stl.total_shrinkage_claim_kg)}*`,
                `Harga Aktual Batch: ${formatIdr(stl.supplier_actual_cost_per_kg)}/kg`,
                `Tagihan Kotor Awal: ${formatIdr(stl.gross_payable_amount)}`,
                `Potongan Klaim Susut: *-${formatIdr(stl.shrinkage_claim_deduction_amount)}*`,
                `*TOTAL BERSIH WAJIB BAYAR: ${formatIdr(stl.net_payable_amount)}*`,
              ].join('\n');

              return (
                <div
                  key={stl.id}
                  className="rounded-2xl border border-slate-800 bg-slate-900/90 p-3.5 shadow-lg space-y-3"
                >
                  <div className="flex items-start justify-between gap-2 border-b border-slate-800 pb-2.5">
                    <div>
                      <span className="inline-block rounded bg-slate-800 px-2 py-0.5 font-mono text-[10px] font-bold text-amber-300">
                        {stl.settlement_number}
                      </span>
                      <h4 className="mt-1 text-xs font-bold text-white">
                        {supplier?.name} ({supplier?.supplier_code})
                      </h4>
                      <p className="text-[11px] text-slate-400">
                        Batch: <span className="font-mono text-slate-300">{batch?.batch_code}</span>{' '}
                        • {item?.name}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                        stl.status === 'PAID'
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-amber-500/20 text-amber-300'
                      }`}
                    >
                      {stl.status}
                    </span>
                  </div>

                  {/* Tabel Rincian Potongan Susut Supplier */}
                  <div className="space-y-1.5 rounded-xl bg-slate-950/90 p-3 text-xs">
                    <div className="flex justify-between text-slate-300">
                      <span>Bobot Kirim Awal ({formatKg(stl.total_dispatched_kg)}):</span>
                      <span className="font-mono">{formatIdr(stl.gross_payable_amount)}</span>
                    </div>
                    <div className="flex justify-between text-rose-400 font-semibold">
                      <span>
                        Potongan Susut/Reject Dapur (-{formatKg(stl.total_shrinkage_claim_kg)}):
                      </span>
                      <span className="font-mono">
                        -{formatIdr(stl.shrinkage_claim_deduction_amount)}
                      </span>
                    </div>
                    <div className="border-t border-slate-800 pt-1.5 flex justify-between font-bold text-emerald-400">
                      <span>
                        Tagihan Bersih Supplier ({formatKg(stl.total_accepted_by_kitchens_kg)}):
                      </span>
                      <span className="font-mono">{formatIdr(stl.net_payable_amount)}</span>
                    </div>
                  </div>

                  {isOwnerOrFinance && stl.status !== 'PAID' && (
                    <button
                      type="button"
                      onClick={() => {
                        markSupplierSettlementPaid(stl.id);
                        setToastMsg(
                          `✓ Settlement Supplier ${stl.settlement_number} ditandai LUNAS (${formatIdr(stl.net_payable_amount)}).`
                        );
                      }}
                      className="w-full rounded-xl bg-amber-600 px-3 py-2 text-xs font-bold text-white hover:bg-amber-500"
                    >
                      ✓ Verifikasi Bayar Bersih ke Supplier ({formatIdr(stl.net_payable_amount)})
                    </button>
                  )}

                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        triggerPdfPrint({
                          type: 'SUPPLIER_CLAIM',
                          settlementId: stl.id,
                        })
                      }
                      className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-slate-700"
                    >
                      🖨️ Print PDF Nota Susut
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        copyWhatsAppText(waClaimText, `Nota Klaim ${stl.settlement_number}`)
                      }
                      className="rounded-lg border border-amber-500/40 bg-amber-950/50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-300 hover:bg-amber-900/50"
                    >
                      📲 WA Nota Klaim Susut
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Preview Dokumen Cetak di Layar (bila dipilih) */}
        {printDoc && (
          <div className="rounded-2xl border-2 border-emerald-500/50 bg-white p-4 text-slate-900 shadow-xl space-y-3">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-700">
                Pratinjau Dokumen Siap Cetak PDF (@media print)
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-bold text-white"
                >
                  🖨️ Cetak / Simpan PDF
                </button>
                <button
                  type="button"
                  onClick={() => setPrintDoc(null)}
                  className="rounded-lg bg-slate-200 px-2.5 py-1 text-xs font-bold text-slate-700"
                >
                  Tutup
                </button>
              </div>
            </div>
            <PrintableDocumentContent doc={printDoc} />
          </div>
        )}
      </div>

      {/* Dedicated @media print container */}
      <div className="print-only p-6">
        {printDoc ? (
          <PrintableDocumentContent doc={printDoc} />
        ) : (
          invoices[0] && (
            <PrintableDocumentContent
              doc={{ type: 'INVOICE', invoiceId: invoices[0].id }}
            />
          )
        )}
      </div>
    </div>
  );
}

function PrintableDocumentContent({ doc }: { doc: PrintDocMode }) {
  const {
    invoices,
    kitchens,
    deliveries,
    deliveryItems,
    items,
    suppliers,
    batches,
    supplierSettlements,
  } = useMbgStore();

  if (doc.type === 'INVOICE') {
    const inv = invoices.find((i) => i.id === doc.invoiceId) ?? invoices[0];
    if (!inv) return null;
    const kitchen = kitchens.find((k) => k.id === inv.kitchen_id);
    const deliv = deliveries.find((d) => d.id === inv.delivery_id);
    const ditem = deliveryItems.find((di) => di.delivery_id === inv.delivery_id);
    const item = items.find((i) => i.id === ditem?.item_id);

    return (
      <div className="space-y-4 text-xs text-slate-900">
        <div className="flex justify-between border-b-2 border-slate-900 pb-3">
          <div>
            <h1 className="text-base font-extrabold uppercase">
              INVOICE PENYEDIAAN BAHAN BAKU DAPUR MBG (SPPG)
            </h1>
            <p className="text-[11px] text-slate-600">
              Dokumen Tagihan Resmi Dapur Makan Bergizi Gratis (Tanpa Informasi Harga Modal Supplier)
            </p>
          </div>
          <div className="text-right font-mono">
            <div className="font-bold">{inv.invoice_number}</div>
            <div>Tanggal: {inv.invoice_date}</div>
            <div>Status: {inv.payment_status}</div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="font-bold uppercase text-slate-500">Ditagihkan Kepada:</div>
            <div className="font-bold text-sm">{kitchen?.name}</div>
            <div>{kitchen?.address}</div>
            <div>PIC Dapur: {kitchen?.pic_name} ({kitchen?.pic_phone})</div>
          </div>
          <div className="text-right">
            <div className="font-bold uppercase text-slate-500">Referensi BAST:</div>
            <div className="font-mono font-bold">{deliv?.delivery_number}</div>
            <div>Jatuh Tempo: {inv.due_date}</div>
          </div>
        </div>

        <table className="w-full border-collapse border border-slate-300 text-xs">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-300 p-2 text-left">Komoditas</th>
              <th className="border border-slate-300 p-2 text-right">Bobot Kirim</th>
              <th className="border border-slate-300 p-2 text-right">Bobot Terima BAST</th>
              <th className="border border-slate-300 p-2 text-right">Harga Satuan / kg</th>
              <th className="border border-slate-300 p-2 text-right">Total Tagihan</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border border-slate-300 p-2 font-semibold">{item?.name}</td>
              <td className="border border-slate-300 p-2 text-right font-mono">
                {formatKg(ditem?.qty_dispatched_kg ?? 0)}
              </td>
              <td className="border border-slate-300 p-2 text-right font-mono font-bold">
                {formatKg(ditem?.qty_accepted_kg ?? 0)}
              </td>
              <td className="border border-slate-300 p-2 text-right font-mono">
                {formatIdr(ditem?.kitchen_unit_price_snapshot ?? 0)}
              </td>
              <td className="border border-slate-300 p-2 text-right font-mono font-bold">
                {formatIdr(inv.total_invoice_amount)}
              </td>
            </tr>
          </tbody>
        </table>

        <div className="flex justify-between pt-4 text-[11px]">
          <div>
            <div className="font-bold">Disetujui PIC Dapur SPPG</div>
            <div className="mt-8 border-t border-slate-400 pt-1">{kitchen?.pic_name}</div>
          </div>
          <div className="text-right">
            <div className="font-bold">Bagian Keuangan Konsorsium Tim & Koperasi</div>
            <div className="mt-8 border-t border-slate-400 pt-1">Finance Verification</div>
          </div>
        </div>
      </div>
    );
  }

  if (doc.type === 'BAST') {
    const deliv = deliveries.find((d) => d.id === doc.deliveryId) ?? deliveries[0];
    if (!deliv) return null;
    const kitchen = kitchens.find((k) => k.id === deliv.kitchen_id);
    const ditem = deliveryItems.find((di) => di.delivery_id === deliv.id);
    const item = items.find((i) => i.id === ditem?.item_id);

    return (
      <div className="space-y-4 text-xs text-slate-900">
        <div className="flex justify-between border-b-2 border-slate-900 pb-3">
          <div>
            <h1 className="text-base font-extrabold uppercase">
              SURAT JALAN & BERITA ACARA SERAH TERIMA (BAST)
            </h1>
            <p className="text-[11px] text-slate-600">
              Dokumen Timbang Terima Lapangan (Invariant 5: Tanpa Informasi Harga / Uang)
            </p>
          </div>
          <div className="text-right font-mono">
            <div className="font-bold">{deliv.delivery_number}</div>
            <div>Tanggal: {deliv.delivery_date}</div>
          </div>
        </div>

        <div>
          <div className="font-bold">Dapur Tujuan: {kitchen?.name}</div>
          <div>Alamat: {kitchen?.address}</div>
          <div>PIC Penerima: {kitchen?.pic_name} ({kitchen?.pic_phone})</div>
        </div>

        <table className="w-full border-collapse border border-slate-300 text-xs">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-300 p-2 text-left">Komoditas Bahan Baku</th>
              <th className="border border-slate-300 p-2 text-right">Bobot Kirim (kg)</th>
              <th className="border border-slate-300 p-2 text-right">Bobot Diterima (kg)</th>
              <th className="border border-slate-300 p-2 text-right">Susut / Reject (kg)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border border-slate-300 p-2 font-semibold">
                [{item?.sku}] {item?.name}
              </td>
              <td className="border border-slate-300 p-2 text-right font-mono">
                {formatKg(ditem?.qty_dispatched_kg ?? 0)}
              </td>
              <td className="border border-slate-300 p-2 text-right font-mono font-bold">
                {formatKg(ditem?.qty_accepted_kg ?? 0)}
              </td>
              <td className="border border-slate-300 p-2 text-right font-mono">
                {formatKg(ditem?.qty_shrinkage_kg ?? 0)}
              </td>
            </tr>
          </tbody>
        </table>

        {ditem?.rejection_reason && (
          <div className="rounded border border-slate-400 p-2 text-[11px]">
            <strong>Berita Acara Susut / Reject:</strong> {ditem.rejection_reason} (100% menjadi
            potongan klaim ke Supplier asal Batch).
          </div>
        )}

        <div className="flex justify-between pt-4 text-[11px]">
          <div>
            <div className="font-bold">Kurir / Tim Lapangan</div>
            <div className="mt-8 border-t border-slate-400 pt-1">Petugas Pengiriman</div>
          </div>
          <div className="text-right">
            <div className="font-bold">Penerima BAST Dapur MBG</div>
            <div className="mt-8 border-t border-slate-400 pt-1">{kitchen?.pic_name}</div>
          </div>
        </div>
      </div>
    );
  }

  // SUPPLIER_CLAIM
  const stl =
    supplierSettlements.find((s) => s.id === doc.settlementId) ?? supplierSettlements[0];
  if (!stl) return null;
  const supplier = suppliers.find((s) => s.id === stl.supplier_id);
  const batch = batches.find((b) => b.id === stl.supplier_batch_id);
  const item = items.find((i) => i.id === batch?.item_id);

  return (
    <div className="space-y-4 text-xs text-slate-900">
      <div className="flex justify-between border-b-2 border-slate-900 pb-3">
        <div>
          <h1 className="text-base font-extrabold uppercase">
            NOTA REKONSILIASI & POTONGAN SUSUT SUPPLIER
          </h1>
          <p className="text-[11px] text-slate-600">
            Invariant 2: Seluruh Susut/Reject BAST Dapur Memotong Tagihan Supplier 100%
          </p>
        </div>
        <div className="text-right font-mono">
          <div className="font-bold">{stl.settlement_number}</div>
          <div>Batch: {batch?.batch_code}</div>
        </div>
      </div>

      <div>
        <div className="font-bold">
          Kepada Supplier: {supplier?.name} ({supplier?.supplier_code})
        </div>
        <div>
          Rekening Tujuan: {supplier?.bank_name} — {supplier?.bank_account_number} a.n.{' '}
          {supplier?.bank_account_holder}
        </div>
        <div>Komoditas: {item?.name}</div>
      </div>

      <table className="w-full border-collapse border border-slate-300 text-xs">
        <thead>
          <tr className="bg-slate-100">
            <th className="border border-slate-300 p-2 text-left">Komponen Rekonsiliasi</th>
            <th className="border border-slate-300 p-2 text-right">Kuantitas (kg)</th>
            <th className="border border-slate-300 p-2 text-right">Harga Aktual / kg</th>
            <th className="border border-slate-300 p-2 text-right">Nominal (IDR)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="border border-slate-300 p-2">Bobot Kirim Awal Batch</td>
            <td className="border border-slate-300 p-2 text-right font-mono">
              {formatKg(stl.total_dispatched_kg)}
            </td>
            <td className="border border-slate-300 p-2 text-right font-mono">
              {formatIdr(stl.supplier_actual_cost_per_kg)}
            </td>
            <td className="border border-slate-300 p-2 text-right font-mono">
              {formatIdr(stl.gross_payable_amount)}
            </td>
          </tr>
          <tr>
            <td className="border border-slate-300 p-2 font-semibold">
              Potongan Klaim Susut / Reject BAST Dapur
            </td>
            <td className="border border-slate-300 p-2 text-right font-mono">
              -{formatKg(stl.total_shrinkage_claim_kg)}
            </td>
            <td className="border border-slate-300 p-2 text-right font-mono">
              {formatIdr(stl.supplier_actual_cost_per_kg)}
            </td>
            <td className="border border-slate-300 p-2 text-right font-mono">
              -{formatIdr(stl.shrinkage_claim_deduction_amount)}
            </td>
          </tr>
          <tr className="bg-slate-100 font-bold">
            <td className="border border-slate-300 p-2">
              TOTAL BERSIH WAJIB DIBAYAR KE SUPPLIER
            </td>
            <td className="border border-slate-300 p-2 text-right font-mono">
              {formatKg(stl.total_accepted_by_kitchens_kg)}
            </td>
            <td className="border border-slate-300 p-2 text-right font-mono">
              {formatIdr(stl.supplier_actual_cost_per_kg)}
            </td>
            <td className="border border-slate-300 p-2 text-right font-mono">
              {formatIdr(stl.net_payable_amount)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
