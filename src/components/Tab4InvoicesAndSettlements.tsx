'use client';

import React, { useState } from 'react';
import { formatIdr, formatKg, useMbgStore } from '../lib/mbg-store';
import {
  ArrowUpRightIcon,
  CheckBadgeIcon,
  InvoiceReceiptIcon,
  LockClosedIcon,
  LockOpenIcon,
  PackageBatchIcon,
  PrinterDocIcon,
  ShareCopyIcon,
} from './Icons';

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
      <section aria-label="Akses Invoice Terbatas" className="space-y-4">
        <div className="bezel-shell-rose">
          <div className="bezel-core-rose space-y-3 text-rose-100">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-rose-300">
              <LockClosedIcon className="h-4 w-4 text-rose-400" />
              <span>Akses Invoice & Tagihan Supplier Dibatasi (Invariant 5)</span>
            </div>
            <p className="text-xs leading-relaxed text-rose-200/90">
              Role <strong>FIELD_TEAM</strong> hanya diizinkan mengakses kuantitas berat (
              <code>kg</code>) dan Surat Jalan / BAST tanpa harga.
            </p>
            <button
              type="button"
              onClick={() => setActiveTab('bast')}
              className="group flex min-h-[44px] w-full items-center justify-between rounded-full bg-rose-600 pl-5 pr-2 py-1.5 text-xs font-bold text-white transition hover:bg-rose-500 active:scale-[0.98]"
            >
              <span>Kembali ke Layar BAST Timbang Terima</span>
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/20">
                <ArrowUpRightIcon className="h-4 w-4" />
              </span>
            </button>
          </div>
        </div>
      </section>
    );
  }

  const copyWhatsAppText = async (text: string, label: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
      setToastMsg(`Ringkasan WhatsApp (${label}) berhasil disalin ke Clipboard.`);
    } catch {
      setToastMsg(`Ringkasan WhatsApp (${label}): ${text.slice(0, 80)}...`);
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
    <section aria-label="Invoice Dapur dan Rekonsiliasi Supplier" className="space-y-5">
      {/* Main Screen (Hidden during @media print when printDoc is active) */}
      <div className="no-print space-y-5">
        {/* Sub-Navigation Switcher (Double-Bezel) */}
        <div
          role="group"
          aria-label="Pilih Modul Tagihan"
          className="grid grid-cols-2 gap-1.5 rounded-2xl bg-white/[0.03] p-1.5 ring-1 ring-white/[0.08]"
        >
          <button
            type="button"
            aria-pressed={subView === 'INVOICES'}
            onClick={() => setSubView('INVOICES')}
            className={`min-h-[42px] inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-bold transition-all duration-300 ease-spring active:scale-[0.98] ${
              subView === 'INVOICES'
                ? 'bg-emerald-500 text-slate-950 shadow-[0_4px_16px_rgba(16,185,129,0.35)]'
                : 'text-slate-400 hover:bg-white/[0.04] hover:text-white'
            }`}
          >
            <InvoiceReceiptIcon className="h-4 w-4" />
            <span>Invoice Dapur ({invoices.length})</span>
          </button>
          <button
            type="button"
            aria-pressed={subView === 'SUPPLIER_SETTLEMENTS'}
            onClick={() => setSubView('SUPPLIER_SETTLEMENTS')}
            className={`min-h-[42px] inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-bold transition-all duration-300 ease-spring active:scale-[0.98] ${
              subView === 'SUPPLIER_SETTLEMENTS'
                ? 'bg-amber-500 text-slate-950 shadow-[0_4px_16px_rgba(245,158,11,0.35)]'
                : 'text-slate-400 hover:bg-white/[0.04] hover:text-white'
            }`}
          >
            <PackageBatchIcon className="h-4 w-4" />
            <span>Settlement Supplier ({supplierSettlements.length})</span>
          </button>
        </div>

        {toastMsg && (
          <div
            role="status"
            className="flex items-center justify-between rounded-xl border border-emerald-500/40 bg-emerald-950/70 px-3.5 py-2.5 text-xs text-emerald-200"
          >
            <span>{toastMsg}</span>
            <button
              type="button"
              aria-label="Tutup notifikasi"
              onClick={() => setToastMsg(null)}
              className="ml-3 rounded px-1.5 py-0.5 font-mono text-xs font-bold text-emerald-300 hover:bg-emerald-900/50"
            >
              ✕
            </button>
          </div>
        )}

        {subView === 'INVOICES' ? (
          <div className="space-y-4">
            {/* Summary Cards */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bezel-shell">
                <div className="bezel-core p-3.5">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
                    Total Tagihan Dapur
                  </div>
                  <div className="mt-1 font-mono text-sm font-bold text-white">
                    {formatIdr(totalInvoicedAmount)}
                  </div>
                </div>
              </div>
              <div className="bezel-shell-emerald">
                <div className="bezel-core-emerald p-3.5">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-emerald-300">
                    Terverifikasi PAID
                  </div>
                  <div className="mt-1 font-mono text-sm font-bold text-emerald-400">
                    {formatIdr(totalPaidAmount)}
                  </div>
                </div>
              </div>
            </div>

            {/* Filter Pills */}
            <div role="group" aria-label="Filter Status Invoice" className="flex items-center gap-2">
              {(['ALL', 'UNPAID', 'PAID'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={statusFilter === f}
                  onClick={() => setStatusFilter(f)}
                  className={`min-h-[38px] rounded-xl px-3.5 py-1.5 text-xs font-bold transition-all duration-300 ease-spring ${
                    statusFilter === f
                      ? 'bg-emerald-500 text-slate-950 shadow'
                      : 'border border-white/10 bg-[#0D131F] text-slate-400 hover:text-white'
                  }`}
                >
                  {f === 'ALL' ? 'Semua' : f === 'PAID' ? 'Sudah PAID' : 'Belum Lunas'}
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
                <article key={inv.id} className="bezel-shell">
                  <div className="bezel-core space-y-3.5">
                    <div className="flex items-start justify-between gap-2 border-b border-white/[0.07] pb-3">
                      <div>
                        <span className="inline-block rounded bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] font-bold text-emerald-300 ring-1 ring-emerald-500/25">
                          {inv.invoice_number}
                        </span>
                        <h3 className="mt-1.5 text-sm font-bold text-white">{kitchen?.name}</h3>
                        <p className="mt-0.5 text-xs text-slate-400">
                          {item?.name} • BAST Terima:{' '}
                          <strong className="font-mono text-white">
                            {formatKg(ditem?.qty_accepted_kg ?? 0)}
                          </strong>
                          {(ditem?.qty_shrinkage_kg ?? 0) > 0 && (
                            <span className="ml-1 font-mono text-amber-400">
                              (Susut -{formatKg(ditem?.qty_shrinkage_kg ?? 0)})
                            </span>
                          )}
                        </p>
                      </div>

                      <span
                        className={`shrink-0 rounded-full px-2.5 py-1 font-mono text-[10px] font-bold ${
                          inv.payment_status === 'PAID'
                            ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/35'
                            : inv.payment_status === 'PARTIALLY_PAID'
                            ? 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/35'
                            : 'bg-rose-500/20 text-rose-300 ring-1 ring-rose-500/35'
                        }`}
                      >
                        {inv.payment_status}
                      </span>
                    </div>

                    {/* Rincian Angka Invoice */}
                    <div className="grid grid-cols-2 gap-3 rounded-xl border border-white/[0.05] bg-[#070A10] p-3 text-xs">
                      <div>
                        <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
                          Harga Dapur / kg
                        </div>
                        <div className="mt-1 font-mono font-semibold text-slate-200">
                          {formatIdr(ditem?.kitchen_unit_price_snapshot ?? 0)}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
                          Total Tagihan Dapur
                        </div>
                        <div className="mt-1 font-mono text-sm font-bold text-emerald-400">
                          {formatIdr(inv.total_invoice_amount)}
                        </div>
                      </div>
                    </div>

                    {/* Info Trigger Bagi Hasil */}
                    <div className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.05] bg-[#070A10]/70 px-3 py-2.5 text-xs">
                      <span className="text-slate-400">
                        Hak Tim {formatIdr(teamProfit)} • Kop {formatIdr(coopProfit)}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 font-mono text-[10px] font-bold ${
                          inv.payment_status === 'PAID' ? 'text-emerald-400' : 'text-amber-400'
                        }`}
                      >
                        {inv.payment_status === 'PAID' ? (
                          <>
                            <LockOpenIcon className="h-3.5 w-3.5" />
                            <span>AVAILABLE_FOR_PAYOUT</span>
                          </>
                        ) : (
                          <>
                            <LockClosedIcon className="h-3.5 w-3.5" />
                            <span>LOCKED_UNPAID</span>
                          </>
                        )}
                      </span>
                    </div>

                    {/* Tombol Tandai Lunas (PAID) */}
                    {isOwnerOrFinance && inv.payment_status !== 'PAID' && (
                      <button
                        type="button"
                        onClick={() => {
                          markInvoicePaid(inv.id);
                          setToastMsg(
                            `Invoice ${inv.invoice_number} ditandai PAID. Saldo bagi hasil Tim (${formatIdr(teamProfit)}) & Koperasi (${formatIdr(coopProfit)}) otomatis terbuka (AVAILABLE_FOR_PAYOUT).`
                          );
                        }}
                        className="group flex min-h-[44px] w-full items-center justify-between rounded-full bg-emerald-500 pl-5 pr-2 py-1.5 text-xs font-extrabold text-slate-950 shadow-[0_6px_20px_-4px_rgba(16,185,129,0.45)] transition-all duration-300 ease-spring hover:bg-emerald-400 active:scale-[0.98]"
                      >
                        <span>Tandai Lunas (PAID) & Buka Kunci Bagi Hasil</span>
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-950/15">
                          <CheckBadgeIcon className="h-4 w-4 text-slate-950" />
                        </span>
                      </button>
                    )}

                    {/* Baris Tombol Cetak PDF & Salin WA */}
                    <div className="grid grid-cols-2 gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => triggerPdfPrint({ type: 'INVOICE', invoiceId: inv.id })}
                        className="min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-white transition hover:bg-white/[0.08]"
                      >
                        <PrinterDocIcon className="h-3.5 w-3.5 text-slate-300" />
                        <span>Print PDF Invoice</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          copyWhatsAppText(waInvoiceSummary, `Invoice ${inv.invoice_number}`)
                        }
                        className="min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-500/20"
                      >
                        <ShareCopyIcon className="h-3.5 w-3.5" />
                        <span>WA Ringkasan Invoice</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          triggerPdfPrint({
                            type: 'BAST',
                            deliveryId: inv.delivery_id,
                          })
                        }
                        className="min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.08]"
                      >
                        <PrinterDocIcon className="h-3.5 w-3.5 text-slate-300" />
                        <span>Print PDF Surat Jalan</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          copyWhatsAppText(waBastSummary, `BAST ${deliv?.delivery_number}`)
                        }
                        className="min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-white/[0.08]"
                      >
                        <ShareCopyIcon className="h-3.5 w-3.5" />
                        <span>WA Ringkasan BAST</span>
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          /* Daftar Tagihan Bersih Supplier (Setelah Dipotong Susut Dapur) */
          <div className="space-y-4">
            <div className="bezel-shell-amber">
              <div className="bezel-core-amber text-xs leading-relaxed text-amber-100/90">
                <strong>Invariant 2 (Zero-Shrinkage Risk):</strong> Kewajiban bayar ke Supplier
                dihitung murni dari{' '}
                <code>total_accepted_by_kitchens_kg × supplier_actual_cost_per_kg</code>. Seluruh
                susut/reject saat BAST di dapur memotong tagihan Supplier 100%.
              </div>
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
                <article key={stl.id} className="bezel-shell">
                  <div className="bezel-core space-y-3.5">
                    <div className="flex items-start justify-between gap-2 border-b border-white/[0.07] pb-3">
                      <div>
                        <span className="inline-block rounded bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] font-bold text-amber-300 ring-1 ring-amber-500/25">
                          {stl.settlement_number}
                        </span>
                        <h3 className="mt-1.5 text-sm font-bold text-white">
                          {supplier?.name} ({supplier?.supplier_code})
                        </h3>
                        <p className="mt-0.5 text-xs text-slate-400">
                          Batch:{' '}
                          <span className="font-mono text-slate-300">{batch?.batch_code}</span> •{' '}
                          {item?.name}
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-2.5 py-1 font-mono text-[10px] font-bold ${
                          stl.status === 'PAID'
                            ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/35'
                            : 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/35'
                        }`}
                      >
                        {stl.status}
                      </span>
                    </div>

                    {/* Tabel Rincian Potongan Susut Supplier */}
                    <div className="space-y-2 rounded-xl border border-white/[0.05] bg-[#070A10] p-3.5 text-xs">
                      <div className="flex justify-between text-slate-300">
                        <span>Bobot Kirim Awal ({formatKg(stl.total_dispatched_kg)}):</span>
                        <span className="font-mono">{formatIdr(stl.gross_payable_amount)}</span>
                      </div>
                      <div className="flex justify-between font-semibold text-rose-400">
                        <span>
                          Potongan Susut/Reject Dapur (-{formatKg(stl.total_shrinkage_claim_kg)}):
                        </span>
                        <span className="font-mono">
                          -{formatIdr(stl.shrinkage_claim_deduction_amount)}
                        </span>
                      </div>
                      <div className="flex justify-between border-t border-white/[0.07] pt-2 font-bold text-emerald-400">
                        <span>
                          Tagihan Bersih Supplier ({formatKg(stl.total_accepted_by_kitchens_kg)}):
                        </span>
                        <span className="font-mono text-sm">
                          {formatIdr(stl.net_payable_amount)}
                        </span>
                      </div>
                    </div>

                    {isOwnerOrFinance && stl.status !== 'PAID' && (
                      <button
                        type="button"
                        onClick={() => {
                          markSupplierSettlementPaid(stl.id);
                          setToastMsg(
                            `Settlement Supplier ${stl.settlement_number} ditandai LUNAS (${formatIdr(stl.net_payable_amount)}).`
                          );
                        }}
                        className="min-h-[44px] w-full rounded-full bg-amber-500 px-4 py-2 text-xs font-extrabold text-slate-950 transition hover:bg-amber-400 active:scale-[0.98]"
                      >
                        Verifikasi Bayar Bersih ke Supplier ({formatIdr(stl.net_payable_amount)})
                      </button>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          triggerPdfPrint({
                            type: 'SUPPLIER_CLAIM',
                            settlementId: stl.id,
                          })
                        }
                        className="min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-white transition hover:bg-white/[0.08]"
                      >
                        <PrinterDocIcon className="h-3.5 w-3.5 text-slate-300" />
                        <span>Print PDF Nota Susut</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          copyWhatsAppText(waClaimText, `Nota Klaim ${stl.settlement_number}`)
                        }
                        className="min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-300 transition hover:bg-amber-500/20"
                      >
                        <ShareCopyIcon className="h-3.5 w-3.5" />
                        <span>WA Nota Klaim Susut</span>
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {/* Preview Dokumen Cetak di Layar (bila dipilih) */}
        {printDoc && (
          <div className="rounded-2xl border-2 border-emerald-500/50 bg-white p-4 text-slate-900 shadow-2xl space-y-3">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2.5">
              <span className="font-mono text-xs font-bold uppercase tracking-wider text-emerald-700">
                Pratinjau Dokumen Siap Cetak PDF (@media print)
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white"
                >
                  <PrinterDocIcon className="h-3.5 w-3.5" />
                  <span>Cetak / Simpan PDF</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPrintDoc(null)}
                  className="min-h-[36px] rounded-lg bg-slate-200 px-3 py-1.5 text-xs font-bold text-slate-700"
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
    </section>
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
            <div>
              PIC Dapur: {kitchen?.pic_name} ({kitchen?.pic_phone})
            </div>
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
          <div>
            PIC Penerima: {kitchen?.pic_name} ({kitchen?.pic_phone})
          </div>
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
