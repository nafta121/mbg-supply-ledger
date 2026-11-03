'use client';

import React from 'react';
import { buildInvoiceLines, resolvePaymentAccount } from '../lib/invoice-view';
import { useMbgStore } from '../lib/mbg-store';
import { formatKg, formatRp, INVOICE_LABEL } from '../lib/ui-format';

export type PrintDocMode = { type: 'INVOICE'; invoiceId: string };

const th = 'border border-control px-2 py-1.5 text-xs';
const td = 'border border-control px-2 py-1.5 text-xs';

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
    <div className="space-y-3.5 text-xs text-ink">
      <div className="flex justify-between gap-2 border-b-2 border-ink pb-3">
        <div className="min-w-0">
          <h1 className="text-sm font-extrabold sm:text-base">
            Invoice Tagihan Dapur MBG · {account.supplier_name ?? 'Supplier MBG'}
          </h1>
          <p className="text-[11px] text-muted">Tagihan bahan baku sesuai berat diterima (BAST)</p>
        </div>
        <div className="shrink-0 text-right text-[11px] tabular-nums">
          <div className="font-mono font-bold">{inv.invoice_number}</div>
          <div>Tanggal: {inv.invoice_date}</div>
          <div>Status: {INVOICE_LABEL[inv.payment_status]}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <div className="font-bold text-muted">Ditagihkan kepada</div>
          <div className="break-words text-sm font-bold">{kitchen?.name}</div>
          <div className="break-words">{kitchen?.address}</div>
          <div className="break-words">
            PIC: {kitchen?.pic_name} ({kitchen?.pic_phone})
          </div>
        </div>
        <div className="text-right">
          <div className="font-bold text-muted">Dari supplier</div>
          <div className="break-words text-sm font-bold">{account.supplier_name ?? 'Supplier MBG'}</div>
          <div className="mt-1.5 font-bold text-muted">No. surat jalan</div>
          <div className="break-all font-mono font-bold">{deliv?.delivery_number}</div>
        </div>
      </div>

      <table className="w-full table-fixed border-collapse border border-control text-xs">
        <thead>
          <tr className="bg-paper-2">
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
                {!l.weighed && <div className="text-[11px] font-normal text-muted">Estimasi (belum ditimbang)</div>}
              </td>
              <td className={`${td} whitespace-nowrap text-right font-bold tabular-nums`}>
                <div className="font-mono">{formatKg(l.qty_accepted_kg)}</div>
                {l.qty_ordered_kg !== l.qty_accepted_kg && (
                  <div className="text-[11px] font-normal text-muted">Order {formatKg(l.qty_ordered_kg)}</div>
                )}
              </td>
              <td className={`${td} whitespace-nowrap text-right font-mono`}>{formatRp(l.unit_price)}</td>
              <td className={`${td} whitespace-nowrap text-right font-mono font-bold`}>{formatRp(l.line_total)}</td>
            </tr>
          ))}
          <tr className="bg-paper-2 font-bold">
            <td className={td} colSpan={3}>
              Total Tagihan Dapur
            </td>
            <td className={`${td} whitespace-nowrap text-right font-mono`}>{formatRp(inv.total_invoice_amount)}</td>
          </tr>
        </tbody>
      </table>

      <div className="rounded-lg border-2 border-ink bg-paper-2 px-3 py-2.5">
        <div className="text-[11px] font-bold text-muted">
          Transfer pembayaran ke rekening:
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-sm font-extrabold text-ink">
          <span>{account.payment_bank_name}</span>
          <span>{account.payment_account_number}</span>
        </div>
        <div className="text-xs font-semibold text-ink-2">a.n. {account.payment_account_holder}</div>
      </div>

      <div className="flex justify-between pt-3 text-[11px]">
        <div>
          <div className="font-bold">PIC Dapur</div>
          <div className="mt-8 border-t border-control pt-1">{kitchen?.pic_name}</div>
        </div>
        <div className="text-right">
          <div className="font-bold">{account.supplier_name ?? 'Supplier MBG'}</div>
          <div className="mt-8 border-t border-control pt-1">{account.payment_account_holder}</div>
        </div>
      </div>
    </div>
  );
}
