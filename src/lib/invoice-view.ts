/**
 * Invoice Dapur Gabungan view helpers (Stage 8). Read-only projections of
 * store-computed values: every rupiah shown here is the snapshot / generated
 * amount already stored on the order line (Invariant 3) — nothing is
 * re-priced. Tagihan per baris = qty_accepted_kg × Harga Dapur / kg (Invariant 2).
 */
import type { KitchenInvoice, LedgerPayoutStatus, PaymentAccountInfo, ProfitSplitConfig } from '../types/mbg';
import { gramsToKg, idrToSen, kgToGrams, senToIdr } from './financial-engine';
import { describeShrinkReason } from './courier-view';
import { linesForDelivery, type MbgData, orderProgress } from './order-engine';
import { formatKgNum, formatRp, INVOICE_LABEL, shortKitchenName } from './ui-format';

export interface InvoiceLineView {
  id: string;
  item_name: string;
  qty_ordered_kg: number;
  qty_accepted_kg: number;
  qty_shrinkage_kg: number;
  unit_price: number;
  line_total: number;
  margin_per_kg: number;
  line_margin: number;
  weighed: boolean;
  reason: string;
}

export function buildInvoiceLines(
  data: Pick<MbgData, 'deliveryItems' | 'items'>,
  invoice: Pick<KitchenInvoice, 'delivery_id'>
): InvoiceLineView[] {
  return linesForDelivery(data, invoice.delivery_id).map((di) => ({
    id: di.id,
    item_name: data.items.find((i) => i.id === di.item_id)?.name ?? 'Barang',
    qty_ordered_kg: di.qty_dispatched_kg,
    qty_accepted_kg: di.qty_accepted_kg,
    qty_shrinkage_kg: di.qty_shrinkage_kg,
    unit_price: di.kitchen_unit_price_snapshot,
    line_total: di.line_invoice_amount,
    margin_per_kg: di.margin_per_kg_snapshot,
    line_margin: di.line_margin_amount,
    weighed: di.weighed_at !== null,
    reason: describeShrinkReason(di.rejection_reason),
  }));
}

/** "Wortel: 35 kg × Rp 14.000 = Rp 490.000" */
export function formatInvoiceLine(l: Pick<InvoiceLineView, 'item_name' | 'qty_accepted_kg' | 'unit_price' | 'line_total'>): string {
  return `${l.item_name}: ${formatKgNum(l.qty_accepted_kg)} kg × ${formatRp(l.unit_price)} = ${formatRp(l.line_total)}`;
}

export interface InvoiceSummary {
  fully_weighed: boolean;
  line_count: number;
  total_accepted_kg: number;
  total_margin: number;
}

export function summarizeInvoice(lines: InvoiceLineView[]): InvoiceSummary {
  let grams = 0n;
  let marginSen = 0n;
  for (const l of lines) {
    grams += kgToGrams(l.qty_accepted_kg);
    marginSen += idrToSen(l.line_margin);
  }
  return {
    fully_weighed: orderProgress(lines.map((l) => ({ weighed_at: l.weighed ? 'x' : null }))) === 'BAST_DONE',
    line_count: lines.length,
    total_accepted_kg: gramsToKg(grams),
    total_margin: senToIdr(marginSen),
  };
}

export function resolvePaymentAccount(
  data: { splitConfig?: ProfitSplitConfig },
  invoice?: Partial<KitchenInvoice>
): PaymentAccountInfo {
  const isPaid = invoice?.payment_status === 'PAID';
  const cfg = data.splitConfig;
  return {
    supplier_name:
      (isPaid ? invoice?.supplier_name : cfg?.supplier_name || invoice?.supplier_name) ||
      cfg?.supplier_name ||
      invoice?.supplier_name ||
      'Supplier MBG',
    payment_bank_name:
      (isPaid ? invoice?.payment_bank_name : cfg?.payment_bank_name || invoice?.payment_bank_name) ||
      cfg?.payment_bank_name ||
      invoice?.payment_bank_name ||
      'BRI',
    payment_account_number:
      (isPaid ? invoice?.payment_account_number : cfg?.payment_account_number || invoice?.payment_account_number) ||
      cfg?.payment_account_number ||
      invoice?.payment_account_number ||
      '0000-0000-0000-000',
    payment_account_holder:
      (isPaid ? invoice?.payment_account_holder : cfg?.payment_account_holder || invoice?.payment_account_holder) ||
      cfg?.payment_account_holder ||
      invoice?.payment_account_holder ||
      'Bendahara Supplier MBG',
  };
}

export function buildInvoiceWaText(
  data: Pick<MbgData, 'deliveryItems' | 'items' | 'kitchens'> & { splitConfig?: ProfitSplitConfig },
  invoice: KitchenInvoice
): string {
  const kitchen = data.kitchens.find((k) => k.id === invoice.kitchen_id);
  const lines = buildInvoiceLines(data, invoice);
  const account = resolvePaymentAccount(data, invoice);
  const out = [
    `Invoice Tagihan Dapur ${invoice.invoice_number}`,
    `Supplier: ${account.supplier_name ?? 'Supplier MBG'}`,
    kitchen ? `${kitchen.kitchen_code} • ${shortKitchenName(kitchen.name)}` : '-',
    `Tanggal: ${invoice.invoice_date}`,
    '',
  ];
  lines.forEach((l, idx) => {
    let text = `${idx + 1}. ${formatInvoiceLine(l)}`;
    if (l.weighed && kgToGrams(l.qty_shrinkage_kg) > 0n) {
      text += ` (order ${formatKgNum(l.qty_ordered_kg)} kg, selisih -${formatKgNum(l.qty_shrinkage_kg)} kg tidak ditagih)`;
    }
    if (!l.weighed) text += ' (estimasi, belum ditimbang)';
    out.push(text);
  });
  out.push('');
  out.push(`Total Tagihan: ${formatRp(invoice.total_invoice_amount)}`);
  out.push(`Status: ${INVOICE_LABEL[invoice.payment_status]}`);
  out.push('');
  out.push('TRANSFER PEMBAYARAN KE REKENING:');
  out.push(`${account.payment_bank_name} • ${account.payment_account_number}`);
  out.push(`a.n. ${account.payment_account_holder}`);
  return out.join('\n');
}

export interface InvoiceProfitView {
  invoice_id: string;
  total_margin: number;
  team_amount: number;
  coop_amount: number;
  total_accepted_kg: number;
  team_status: LedgerPayoutStatus;
  coop_status: LedgerPayoutStatus;
}

function combinedStatus(statuses: LedgerPayoutStatus[]): LedgerPayoutStatus {
  if (statuses.length === 0) return 'LOCKED_UNPAID';
  if (statuses.some((s) => s === 'LOCKED_UNPAID')) return 'LOCKED_UNPAID';
  if (statuses.some((s) => s === 'AVAILABLE_FOR_PAYOUT')) return 'AVAILABLE_FOR_PAYOUT';
  return 'PAID_OUT';
}

/** Bagi hasil per Invoice Dapur: Σ ledger rows of all its lines, Tim vs Koperasi. */
export function buildInvoiceProfit(
  data: Pick<MbgData, 'ledgerEntries'>,
  invoiceId: string
): InvoiceProfitView {
  const entries = data.ledgerEntries.filter((le) => le.invoice_id === invoiceId);
  const team = entries.filter((e) => e.beneficiary_type === 'TEAM');
  const coop = entries.filter((e) => e.beneficiary_type === 'COOPERATIVE');
  let teamSen = 0n;
  let coopSen = 0n;
  let grams = 0n;
  for (const e of team) {
    teamSen += idrToSen(e.profit_amount);
    grams += kgToGrams(e.qty_accepted_kg);
  }
  for (const e of coop) coopSen += idrToSen(e.profit_amount);
  return {
    invoice_id: invoiceId,
    total_margin: senToIdr(teamSen + coopSen),
    team_amount: senToIdr(teamSen),
    coop_amount: senToIdr(coopSen),
    total_accepted_kg: gramsToKg(grams),
    team_status: combinedStatus(team.map((e) => e.payout_status)),
    coop_status: combinedStatus(coop.map((e) => e.payout_status)),
  };
}
