'use client';

import React from 'react';
import { describeShrinkReason, groupCourierStops, type KitchenStop, stopWeighedSummary } from '../lib/courier-view';
import { buildInvoiceLines } from '../lib/invoice-view';
import { buildSafeCourierItems, formatIdr, useMbgStore } from '../lib/mbg-store';
import { formatKgNum, formatShrinkKgNum, INVOICE_LABEL } from '../lib/ui-format';

export type PrintDocMode = { type: 'INVOICE'; invoiceId: string } | { type: 'BAST'; deliveryId: string };

const th = 'border border-slate-300 p-2';
const td = 'border border-slate-300 p-2';

/**
 * Surat Jalan / BAST per Order Dapur (semua barang dalam 1 dokumen). Rendered
 * purely from the price-free courier projection, so it is safe for FIELD_TEAM
 * (Invariant 5). Lines not yet weighed leave "Diterima" blank for handwriting.
 */
export function KitchenBastDocument({ stop }: { stop: KitchenStop }) {
  const summary = stopWeighedSummary(stop);
  return (
    <div className="space-y-4 text-xs text-slate-900">
      <div className="flex justify-between border-b-2 border-slate-900 pb-3">
        <div>
          <h1 className="text-base font-extrabold uppercase">Surat Jalan &amp; BAST</h1>
          <p className="text-[11px] text-slate-600">Serah terima &amp; timbang bahan baku di dapur</p>
        </div>
        <div className="text-right font-mono">
          <div className="font-bold">{stop.delivery_number}</div>
          <div>Tanggal: {stop.delivery_date}</div>
        </div>
      </div>

      <div>
        <div className="font-bold">
          Dapur Tujuan: {stop.kitchen_code} • {stop.kitchen_name}
        </div>
        <div>
          PIC Penerima: {stop.pic_name} ({stop.pic_phone})
        </div>
      </div>

      <table className="w-full border-collapse border border-slate-300 text-xs">
        <thead>
          <tr className="bg-slate-100">
            <th className={`${th} text-left`}>Barang</th>
            <th className={`${th} text-right`}>Order / Kirim (kg)</th>
            <th className={`${th} text-right`}>Diterima (kg)</th>
            <th className={`${th} text-right`}>Selisih (kg)</th>
          </tr>
        </thead>
        <tbody>
          {stop.items.map((it) => {
            const why = describeShrinkReason(it.rejection_reason);
            return (
              <tr key={it.delivery_item_id}>
                <td className={td}>
                  <div className="font-semibold">{it.item_name}</div>
                  {it.is_weighed && it.qty_shrinkage_kg > 0 && why && (
                    <div className="text-[10px] text-slate-700">Alasan selisih: {why}</div>
                  )}
                </td>
                <td className={`${td} text-right font-mono`}>{formatKgNum(it.qty_dispatched_kg)}</td>
                <td className={`${td} text-right font-mono font-bold`}>
                  {it.is_weighed ? formatKgNum(it.qty_accepted_kg) : ''}
                </td>
                <td className={`${td} text-right font-mono`}>
                  {it.is_weighed ? formatShrinkKgNum(it.qty_shrinkage_kg) : ''}
                </td>
              </tr>
            );
          })}
          <tr className="bg-slate-100 font-bold">
            <td className={td}>Total</td>
            <td className={`${td} text-right font-mono`}>{formatKgNum(stop.total_dispatched_kg)}</td>
            <td className={`${td} text-right font-mono`}>{stop.done ? formatKgNum(summary.weighed_accepted_kg) : ''}</td>
            <td className={`${td} text-right font-mono`}>{stop.done ? formatShrinkKgNum(stop.total_shrinkage_kg) : ''}</td>
          </tr>
        </tbody>
      </table>

      <p className="text-[11px] text-slate-600">
        Dapur hanya ditagih sesuai berat yang diterima pada BAST ini.
      </p>

      <div className="flex justify-between pt-4 text-[11px]">
        <div>
          <div className="font-bold">Kurir / Petugas Pengiriman</div>
          <div className="mt-8 border-t border-slate-400 pt-1">&nbsp;</div>
        </div>
        <div className="text-right">
          <div className="font-bold">Penerima Dapur</div>
          <div className="mt-8 border-t border-slate-400 pt-1">{stop.pic_name}</div>
        </div>
      </div>
    </div>
  );
}

export function PrintableDocument({ doc }: { doc: PrintDocMode }) {
  const store = useMbgStore();
  const { invoices, kitchens, deliveries } = store;

  if (doc.type === 'BAST') {
    const stop = groupCourierStops(buildSafeCourierItems(store)).find((s) => s.delivery_id === doc.deliveryId);
    return stop ? <KitchenBastDocument stop={stop} /> : null;
  }

  const inv = invoices.find((i) => i.id === doc.invoiceId);
  if (!inv) return null;
  const kitchen = kitchens.find((k) => k.id === inv.kitchen_id);
  const deliv = deliveries.find((d) => d.id === inv.delivery_id);
  const lines = buildInvoiceLines(store, inv);

  return (
    <div className="space-y-4 text-xs text-slate-900">
      <div className="flex justify-between border-b-2 border-slate-900 pb-3">
        <div>
          <h1 className="text-base font-extrabold uppercase">Invoice Tagihan Dapur MBG</h1>
          <p className="text-[11px] text-slate-600">Tagihan bahan baku sesuai berat diterima (BAST)</p>
        </div>
        <div className="text-right font-mono">
          <div className="font-bold">{inv.invoice_number}</div>
          <div>Tanggal: {inv.invoice_date}</div>
          <div>Status: {INVOICE_LABEL[inv.payment_status]}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="font-bold uppercase text-slate-500">Ditagihkan Kepada</div>
          <div className="text-sm font-bold">{kitchen?.name}</div>
          <div>{kitchen?.address}</div>
          <div>
            PIC: {kitchen?.pic_name} ({kitchen?.pic_phone})
          </div>
        </div>
        <div className="text-right">
          <div className="font-bold uppercase text-slate-500">No. Surat Jalan</div>
          <div className="font-mono font-bold">{deliv?.delivery_number}</div>
          <div>Jatuh Tempo: {inv.due_date}</div>
        </div>
      </div>

      <table className="w-full border-collapse border border-slate-300 text-xs">
        <thead>
          <tr className="bg-slate-100">
            <th className={`${th} text-left`}>Barang</th>
            <th className={`${th} text-right`}>Order</th>
            <th className={`${th} text-right`}>Diterima</th>
            <th className={`${th} text-right`}>Harga / kg</th>
            <th className={`${th} text-right`}>Jumlah</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td className={`${td} font-semibold`}>
                {l.item_name}
                {!l.weighed && <div className="text-[10px] font-normal text-slate-600">Estimasi (belum ditimbang)</div>}
              </td>
              <td className={`${td} text-right font-mono`}>{formatKgNum(l.qty_ordered_kg)} kg</td>
              <td className={`${td} text-right font-mono font-bold`}>{formatKgNum(l.qty_accepted_kg)} kg</td>
              <td className={`${td} text-right font-mono`}>{formatIdr(l.unit_price)}</td>
              <td className={`${td} text-right font-mono font-bold`}>{formatIdr(l.line_total)}</td>
            </tr>
          ))}
          <tr className="bg-slate-100 font-bold">
            <td className={td} colSpan={4}>
              Total Tagihan Dapur
            </td>
            <td className={`${td} text-right font-mono`}>{formatIdr(inv.total_invoice_amount)}</td>
          </tr>
        </tbody>
      </table>

      <div className="flex justify-between pt-4 text-[11px]">
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
