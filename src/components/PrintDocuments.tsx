'use client';

import React from 'react';
import { formatIdr, formatKg, useMbgStore } from '../lib/mbg-store';
import { INVOICE_LABEL } from '../lib/ui-format';

export type PrintDocMode =
  | { type: 'INVOICE'; invoiceId: string }
  | { type: 'BAST'; deliveryId: string }
  | { type: 'SUPPLIER_CLAIM'; settlementId: string };

const th = 'border border-slate-300 p-2';
const td = 'border border-slate-300 p-2';

export function PrintableDocument({ doc }: { doc: PrintDocMode }) {
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
    const inv = invoices.find((i) => i.id === doc.invoiceId);
    if (!inv) return null;
    const kitchen = kitchens.find((k) => k.id === inv.kitchen_id);
    const deliv = deliveries.find((d) => d.id === inv.delivery_id);
    const ditem = deliveryItems.find((di) => di.delivery_id === inv.delivery_id);
    const item = items.find((i) => i.id === ditem?.item_id);

    return (
      <div className="space-y-4 text-xs text-slate-900">
        <div className="flex justify-between border-b-2 border-slate-900 pb-3">
          <div>
            <h1 className="text-base font-extrabold uppercase">Invoice Bahan Baku Dapur MBG</h1>
            <p className="text-[11px] text-slate-600">Tagihan penyediaan bahan baku</p>
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
              <th className={`${th} text-right`}>Kirim</th>
              <th className={`${th} text-right`}>Diterima</th>
              <th className={`${th} text-right`}>Harga / kg</th>
              <th className={`${th} text-right`}>Total</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={`${td} font-semibold`}>{item?.name}</td>
              <td className={`${td} text-right font-mono`}>{formatKg(ditem?.qty_dispatched_kg ?? 0)}</td>
              <td className={`${td} text-right font-mono font-bold`}>
                {formatKg(ditem?.qty_accepted_kg ?? 0)}
              </td>
              <td className={`${td} text-right font-mono`}>
                {formatIdr(ditem?.kitchen_unit_price_snapshot ?? 0)}
              </td>
              <td className={`${td} text-right font-mono font-bold`}>
                {formatIdr(inv.total_invoice_amount)}
              </td>
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

  if (doc.type === 'BAST') {
    const deliv = deliveries.find((d) => d.id === doc.deliveryId);
    if (!deliv) return null;
    const kitchen = kitchens.find((k) => k.id === deliv.kitchen_id);
    const ditem = deliveryItems.find((di) => di.delivery_id === deliv.id);
    const item = items.find((i) => i.id === ditem?.item_id);

    // Surat Jalan / BAST never shows prices.
    return (
      <div className="space-y-4 text-xs text-slate-900">
        <div className="flex justify-between border-b-2 border-slate-900 pb-3">
          <div>
            <h1 className="text-base font-extrabold uppercase">Surat Jalan &amp; Serah Terima</h1>
            <p className="text-[11px] text-slate-600">Bukti timbang terima di dapur</p>
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
              <th className={`${th} text-left`}>Barang</th>
              <th className={`${th} text-right`}>Kirim (kg)</th>
              <th className={`${th} text-right`}>Diterima (kg)</th>
              <th className={`${th} text-right`}>Susut (kg)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={`${td} font-semibold`}>{item?.name}</td>
              <td className={`${td} text-right font-mono`}>{formatKg(ditem?.qty_dispatched_kg ?? 0)}</td>
              <td className={`${td} text-right font-mono font-bold`}>
                {formatKg(ditem?.qty_accepted_kg ?? 0)}
              </td>
              <td className={`${td} text-right font-mono`}>{formatKg(ditem?.qty_shrinkage_kg ?? 0)}</td>
            </tr>
          </tbody>
        </table>

        {ditem?.rejection_reason && (
          <div className="rounded border border-slate-400 p-2 text-[11px]">
            <strong>Catatan susut:</strong> {ditem.rejection_reason}
          </div>
        )}

        <div className="flex justify-between pt-4 text-[11px]">
          <div>
            <div className="font-bold">Petugas Pengiriman</div>
            <div className="mt-8 border-t border-slate-400 pt-1">&nbsp;</div>
          </div>
          <div className="text-right">
            <div className="font-bold">Penerima Dapur</div>
            <div className="mt-8 border-t border-slate-400 pt-1">{kitchen?.pic_name}</div>
          </div>
        </div>
      </div>
    );
  }

  const stl = supplierSettlements.find((s) => s.id === doc.settlementId);
  if (!stl) return null;
  const supplier = suppliers.find((s) => s.id === stl.supplier_id);
  const batch = batches.find((b) => b.id === stl.supplier_batch_id);
  const item = items.find((i) => i.id === batch?.item_id);

  return (
    <div className="space-y-4 text-xs text-slate-900">
      <div className="flex justify-between border-b-2 border-slate-900 pb-3">
        <div>
          <h1 className="text-base font-extrabold uppercase">Nota Potongan Susut Supplier</h1>
          <p className="text-[11px] text-slate-600">Rekap berat diterima dapur &amp; potongan tagihan</p>
        </div>
        <div className="text-right font-mono">
          <div className="font-bold">{stl.settlement_number}</div>
          <div>{batch?.batch_code}</div>
        </div>
      </div>

      <div>
        <div className="font-bold">Kepada: {supplier?.name}</div>
        <div>
          Rekening: {supplier?.bank_name} — {supplier?.bank_account_number} a.n.{' '}
          {supplier?.bank_account_holder}
        </div>
        <div>Barang: {item?.name}</div>
      </div>

      <table className="w-full border-collapse border border-slate-300 text-xs">
        <thead>
          <tr className="bg-slate-100">
            <th className={`${th} text-left`}>Rincian</th>
            <th className={`${th} text-right`}>Berat (kg)</th>
            <th className={`${th} text-right`}>Harga / kg</th>
            <th className={`${th} text-right`}>Nominal</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className={td}>Kirim Awal</td>
            <td className={`${td} text-right font-mono`}>{formatKg(stl.total_dispatched_kg)}</td>
            <td className={`${td} text-right font-mono`}>{formatIdr(stl.supplier_actual_cost_per_kg)}</td>
            <td className={`${td} text-right font-mono`}>{formatIdr(stl.gross_payable_amount)}</td>
          </tr>
          <tr>
            <td className={`${td} font-semibold`}>Potongan Susut Dapur</td>
            <td className={`${td} text-right font-mono`}>-{formatKg(stl.total_shrinkage_claim_kg)}</td>
            <td className={`${td} text-right font-mono`}>{formatIdr(stl.supplier_actual_cost_per_kg)}</td>
            <td className={`${td} text-right font-mono`}>
              -{formatIdr(stl.shrinkage_claim_deduction_amount)}
            </td>
          </tr>
          <tr className="bg-slate-100 font-bold">
            <td className={td}>Total Bersih Dibayar</td>
            <td className={`${td} text-right font-mono`}>{formatKg(stl.total_accepted_by_kitchens_kg)}</td>
            <td className={`${td} text-right font-mono`}>{formatIdr(stl.supplier_actual_cost_per_kg)}</td>
            <td className={`${td} text-right font-mono`}>{formatIdr(stl.net_payable_amount)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
