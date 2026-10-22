'use client';

import React from 'react';
import { buildInvoiceLines, resolvePaymentAccount } from '../lib/invoice-view';
import { useMbgStore } from '../lib/mbg-store';
import { formatKg, formatRp, INVOICE_LABEL } from '../lib/ui-format';

export type PrintDocMode = { type: 'INVOICE'; invoiceId: string };

const th = 'border border-slate-300 px-2 py-1.5 text-xs';
const td = 'border border-slate-300 px-2 py-1.5 text-xs';

export function PrintableDocument({ doc }: { doc: PrintDocMode }) {
  const store = useMbgStore();
  const { invoices, kitchens, deliveries } = store;

  const inv = invoices.find((i) => i.id === doc.invoiceId);
  if (!inv) return null;
  const kitchen = kitchens.find((k) => k.id === inv.kitchen_id);
  const deliv = deliveries.find((d) => d.id === inv.delivery_id);
  const lines = buildInvoiceLines(store, inv);
  const account = resolvePaymentAccount(store, inv);

  return (
    <div className="space-y-3.5 text-xs text-slate-900">
      <div className="flex justify-between gap-2 border-b-2 border-slate-900 pb-3">
        <div className="min-w-0">
          <h1 className="text-sm font-extrabold uppercase sm:text-base">Invoice Tagihan Dapur MBG</h1>
          <p className="text-[11px] text-slate-600">Tagihan bahan baku sesuai berat diterima (BAST)</p>
        </div>
        <div className="shrink-0 text-right font-mono text-[11px]">
          <div className="font-bold">{inv.invoice_number}</div>
          <div>Tanggal: {inv.invoice_date}</div>
          <div>Status: {INVOICE_LABEL[inv.payment_status]}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <div className="font-bold uppercase text-slate-500">Ditagihkan Kepada</div>
          <div className="break-words text-sm font-bold">{kitchen?.name}</div>
          <div className="break-words">{kitchen?.address}</div>
          <div className="break-words">
            PIC: {kitchen?.pic_name} ({kitchen?.pic_phone})
          </div>
        </div>
        <div className="text-right">
          <div className="font-bold uppercase text-slate-500">No. Surat Jalan</div>
          <div className="break-all font-mono font-bold">{deliv?.delivery_number}</div>
        </div>
      </div>

      <table className="w-full table-fixed border-collapse border border-slate-300 text-xs">
        <thead>
          <tr className="bg-slate-100">
            <th className={`${th} w-[28%] text-left`}>Barang</th>
            <th className={`${th} w-[22%] text-right`}>Diterima</th>
            <th className={`${th} w-[23%] whitespace-nowrap text-right`}>Harga/kg</th>
            <th className={`${th} w-[27%] whitespace-nowrap text-right`}>Jumlah</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td className={`${td} break-words font-semibold`}>
                {l.item_name}
                {!l.weighed && <div className="text-[10px] font-normal text-slate-600">Estimasi (belum ditimbang)</div>}
              </td>
              <td className={`${td} whitespace-nowrap text-right font-mono font-bold`}>
                <div>{formatKg(l.qty_accepted_kg)}</div>
                {l.qty_ordered_kg !== l.qty_accepted_kg && (
                  <div className="text-[10px] font-normal text-slate-500">Order {formatKg(l.qty_ordered_kg)}</div>
                )}
              </td>
              <td className={`${td} whitespace-nowrap text-right font-mono`}>{formatRp(l.unit_price)}</td>
              <td className={`${td} whitespace-nowrap text-right font-mono font-bold`}>{formatRp(l.line_total)}</td>
            </tr>
          ))}
          <tr className="bg-slate-100 font-bold">
            <td className={td} colSpan={3}>
              Total Tagihan Dapur
            </td>
            <td className={`${td} whitespace-nowrap text-right font-mono`}>{formatRp(inv.total_invoice_amount)}</td>
          </tr>
        </tbody>
      </table>

      <div className="rounded-lg border-2 border-slate-900 bg-slate-50 px-3 py-2.5">
        <div className="text-[10px] font-extrabold uppercase tracking-wide text-slate-600">
          TRANSFER PEMBAYARAN KE REKENING:
        </div>
        <div className="mt-0.5 font-mono text-sm font-extrabold text-slate-900">
          {account.payment_bank_name} • {account.payment_account_number}
        </div>
        <div className="text-xs font-semibold text-slate-700">a.n. {account.payment_account_holder}</div>
      </div>

      <div className="flex justify-between pt-3 text-[11px]">
        <div>
          <div className="font-bold">PIC Dapur</div>
          <div className="mt-8 border-t border-slate-400 pt-1">{kitchen?.pic_name}</div>
        </div>
        <div className="text-right">
          <div className="font-bold">Bagian Keuangan</div>
          <div className="mt-8 border-t border-slate-400 pt-1">&nbsp;</div>
        </div>
      </div>
    </div>
  );
}

