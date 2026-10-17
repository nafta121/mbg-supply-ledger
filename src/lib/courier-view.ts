/**
 * Kitchen-centric courier view helpers (Stage 6 — 1 kurir tunggal).
 *
 * Pure functions over the price-free `SafeCourierBastItem` projection only.
 * They never read or emit supplier cost, kitchen price, invoice, or markup
 * values (Invariant 5) and aggregate weights in exact grams (Invariant 1).
 * Business formulas remain in `financial-engine.ts`.
 */
import type {
  DeliveryStatus,
  Kitchen,
  KitchenDelivery,
  KitchenDeliveryItem,
  SafeCourierBastItem,
} from '../types/mbg';
import { gramsToKg, kgToGrams } from './financial-engine';
import { formatKgNum, shortKitchenName } from './ui-format';

// ---------- Delivery / stop status ----------

export function isDeliveryDone(status: DeliveryStatus): boolean {
  return status === 'BAST_VERIFIED' || status === 'INVOICED';
}

export interface KitchenStop {
  kitchen_id: string;
  kitchen_code: string;
  kitchen_name: string;
  pic_name: string;
  pic_phone: string;
  delivery_date: string;
  items: SafeCourierBastItem[];
  done: boolean;
  pending_count: number;
  total_dispatched_kg: number;
  total_accepted_kg: number;
  total_shrinkage_kg: number;
}

/** Groups delivery lines into 1 stop per kitchen (all items of that kitchen together). */
export function groupCourierStops(items: SafeCourierBastItem[]): KitchenStop[] {
  const byKitchen = new Map<string, SafeCourierBastItem[]>();
  for (const it of items) {
    const list = byKitchen.get(it.kitchen_id);
    if (list) list.push(it);
    else byKitchen.set(it.kitchen_id, [it]);
  }

  const stops: KitchenStop[] = [];
  for (const [kitchenId, lines] of byKitchen) {
    const first = lines[0]!;
    const sorted = [...lines].sort((a, b) => a.item_name.localeCompare(b.item_name, 'id'));
    let dispatched = 0n;
    let accepted = 0n;
    let shrink = 0n;
    let pending = 0;
    for (const l of sorted) {
      dispatched += kgToGrams(l.qty_dispatched_kg);
      accepted += kgToGrams(l.qty_accepted_kg);
      shrink += kgToGrams(l.qty_shrinkage_kg);
      if (!isDeliveryDone(l.delivery_status)) pending += 1;
    }
    stops.push({
      kitchen_id: kitchenId,
      kitchen_code: first.kitchen_code,
      kitchen_name: first.kitchen_name,
      pic_name: first.kitchen_pic_name,
      pic_phone: first.kitchen_pic_phone,
      delivery_date: first.delivery_date,
      items: sorted,
      done: pending === 0,
      pending_count: pending,
      total_dispatched_kg: gramsToKg(dispatched),
      total_accepted_kg: gramsToKg(accepted),
      total_shrinkage_kg: gramsToKg(shrink),
    });
  }
  return stops.sort((a, b) => a.kitchen_code.localeCompare(b.kitchen_code, 'id'));
}

export interface VehicleLoadLine {
  item_id: string;
  item_name: string;
  qty_dispatched_kg: number;
}

/** "Total Muatan Hari Ini": Σ qty_dispatched_kg per bahan baku across all stops. */
export function summarizeVehicleLoad(items: SafeCourierBastItem[]): VehicleLoadLine[] {
  const grams = new Map<string, { name: string; g: bigint }>();
  for (const it of items) {
    const cur = grams.get(it.item_id);
    const add = kgToGrams(it.qty_dispatched_kg);
    if (cur) cur.g += add;
    else grams.set(it.item_id, { name: it.item_name, g: add });
  }
  return [...grams.entries()]
    .map(([item_id, v]) => ({ item_id, item_name: v.name, qty_dispatched_kg: gramsToKg(v.g) }))
    .sort((a, b) => a.item_name.localeCompare(b.item_name, 'id'));
}

export interface CourierProgress {
  done: number;
  total: number;
  total_shrinkage_kg: number;
}

export function courierProgress(stops: KitchenStop[]): CourierProgress {
  let shrink = 0n;
  for (const s of stops) shrink += kgToGrams(s.total_shrinkage_kg);
  return {
    done: stops.filter((s) => s.done).length,
    total: stops.length,
    total_shrinkage_kg: gramsToKg(shrink),
  };
}

// ---------- Shrinkage reason (quick chips + short note) ----------

export const SHRINK_REASONS = ['Susut', 'Barang Rusak/Reject', 'Selisih Timbang'] as const;
export type ShrinkReason = (typeof SHRINK_REASONS)[number];

const REASON_SEPARATOR = ' — ';

/** Stored in `rejection_reason`: "Barang Rusak/Reject — ayam memar". */
export function composeShrinkReason(reason: ShrinkReason | null, note: string): string | null {
  const n = note.trim();
  if (reason && n) return `${reason}${REASON_SEPARATOR}${n}`;
  if (reason) return reason;
  return n || null;
}

export function parseShrinkReason(text: string | null | undefined): {
  reason: ShrinkReason | null;
  note: string;
} {
  const t = (text ?? '').trim();
  for (const r of SHRINK_REASONS) {
    if (t === r) return { reason: r, note: '' };
    if (t.startsWith(`${r}${REASON_SEPARATOR}`)) {
      return { reason: r, note: t.slice(r.length + REASON_SEPARATOR.length).trim() };
    }
  }
  return { reason: null, note: t };
}

// ---------- BAST recap (kg only, NO prices) ----------

export function stopTitle(stop: Pick<KitchenStop, 'kitchen_code' | 'kitchen_name'>): string {
  return `${stop.kitchen_code} • ${shortKitchenName(stop.kitchen_name)}`;
}

export function buildKitchenBastWaText(stop: KitchenStop): string {
  const lines = [
    `BAST Serah Terima Bahan Baku`,
    `${stopTitle(stop)}`,
    `Tanggal: ${stop.delivery_date}`,
    `PIC Dapur: ${stop.pic_name}`,
    '',
  ];
  stop.items.forEach((it, idx) => {
    const shrinkG = kgToGrams(it.qty_shrinkage_kg);
    let line = `${idx + 1}. ${it.item_name}: kirim ${formatKgNum(it.qty_dispatched_kg)} kg, diterima ${formatKgNum(it.qty_accepted_kg)} kg`;
    if (shrinkG > 0n) {
      const { reason, note } = parseShrinkReason(it.rejection_reason);
      const why = [reason, note].filter(Boolean).join(' — ');
      line += ` (susut ${formatKgNum(gramsToKg(shrinkG))} kg${why ? ` — ${why}` : ''})`;
    }
    lines.push(line);
  });
  lines.push('');
  lines.push(`Total diterima: ${formatKgNum(stop.total_accepted_kg)} kg`);
  if (kgToGrams(stop.total_shrinkage_kg) > 0n) {
    lines.push(`Total susut (dipotong dari tagihan supplier): ${formatKgNum(stop.total_shrinkage_kg)} kg`);
  }
  return lines.join('\n');
}

// ---------- Supplier-side shrink breakdown (Admin "Bayar Supplier" / Nota Potongan) ----------

export interface SupplierShrinkLine {
  id: string;
  kitchen_code: string;
  kitchen_name: string;
  kg: number;
  reason: ShrinkReason | null;
  note: string;
  /** "Barang Rusak/Reject — ayam memar" or fallback text. */
  why: string;
}

/**
 * Lists every kitchen line of a supplier batch that had shrinkage, with the
 * courier's reason. Weights only — the deduction amount itself stays the
 * store-computed `shrinkage_claim_deduction_amount` (Invariant 2).
 */
export function supplierShrinkBreakdown(
  supplierBatchId: string,
  deliveryItems: KitchenDeliveryItem[],
  deliveries: KitchenDelivery[],
  kitchens: Kitchen[]
): SupplierShrinkLine[] {
  const lines: SupplierShrinkLine[] = [];
  for (const di of deliveryItems) {
    if (di.supplier_batch_id !== supplierBatchId) continue;
    if (kgToGrams(di.qty_shrinkage_kg) <= 0n) continue;
    const del = deliveries.find((d) => d.id === di.delivery_id);
    const kitchen = kitchens.find((k) => k.id === del?.kitchen_id);
    const { reason, note } = parseShrinkReason(di.rejection_reason);
    lines.push({
      id: di.id,
      kitchen_code: kitchen?.kitchen_code ?? '-',
      kitchen_name: kitchen?.name ?? 'Dapur MBG',
      kg: gramsToKg(kgToGrams(di.qty_shrinkage_kg)),
      reason,
      note,
      why: [reason, note].filter(Boolean).join(' — ') || 'Tidak ada keterangan',
    });
  }
  return lines.sort((a, b) => a.kitchen_code.localeCompare(b.kitchen_code, 'id'));
}
