/**
 * Kitchen-order courier view helpers (Stage 8 — 1 kartu = 1 Order Dapur multi-barang).
 *
 * Pure functions over the price-free `SafeCourierBastItem` projection only.
 * They never read or emit kitchen price, invoice, or margin values
 * (Invariant 5) and aggregate weights in exact grams (Invariant 1).
 * Business formulas remain in `financial-engine.ts` / `order-engine.ts`.
 */
import type { SafeCourierBastItem } from '../types/mbg';
import { gramsToKg, kgToGrams } from './financial-engine';
import { formatKgNum, shortKitchenName } from './ui-format';

// ---------- Stops (1 Order Dapur = 1 kartu) ----------

export interface KitchenStop {
  delivery_id: string;
  delivery_number: string;
  kitchen_id: string;
  kitchen_code: string;
  kitchen_name: string;
  pic_name: string;
  pic_phone: string;
  delivery_date: string;
  items: SafeCourierBastItem[];
  /** Every line weighed (Selesai BAST). */
  done: boolean;
  /** Invoice already Lunas — weights are frozen. */
  locked: boolean;
  pending_count: number;
  total_dispatched_kg: number;
  total_accepted_kg: number;
  total_shrinkage_kg: number;
}

/** Groups order lines into 1 card per Order Dapur (all items of that kitchen order together). */
export function groupCourierStops(items: SafeCourierBastItem[]): KitchenStop[] {
  const byOrder = new Map<string, SafeCourierBastItem[]>();
  for (const it of items) {
    const list = byOrder.get(it.delivery_id);
    if (list) list.push(it);
    else byOrder.set(it.delivery_id, [it]);
  }

  const stops: KitchenStop[] = [];
  for (const [deliveryId, lines] of byOrder) {
    const first = lines[0]!;
    let dispatched = 0n;
    let accepted = 0n;
    let shrink = 0n;
    let pending = 0;
    for (const l of lines) {
      dispatched += kgToGrams(l.qty_dispatched_kg);
      if (l.is_weighed) {
        accepted += kgToGrams(l.qty_accepted_kg);
        shrink += kgToGrams(l.qty_shrinkage_kg);
      } else {
        pending += 1;
      }
    }
    stops.push({
      delivery_id: deliveryId,
      delivery_number: first.delivery_number,
      kitchen_id: first.kitchen_id,
      kitchen_code: first.kitchen_code,
      kitchen_name: first.kitchen_name,
      pic_name: first.kitchen_pic_name,
      pic_phone: first.kitchen_pic_phone,
      delivery_date: first.delivery_date,
      items: lines,
      done: pending === 0,
      locked: lines.some((l) => l.is_locked),
      pending_count: pending,
      total_dispatched_kg: gramsToKg(dispatched),
      total_accepted_kg: gramsToKg(accepted),
      total_shrinkage_kg: gramsToKg(shrink),
    });
  }
  return stops.sort(
    (a, b) =>
      a.kitchen_code.localeCompare(b.kitchen_code, 'id') ||
      a.delivery_number.localeCompare(b.delivery_number, 'id')
  );
}

export interface VehicleLoadLine {
  item_id: string;
  item_name: string;
  qty_dispatched_kg: number;
}

/** "📦 Total Barang yang Harus Dibawa Kurir": Σ berat order per jenis barang (all orders). */
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

/** "Wortel: 105 kg • Kubis: 75 kg" */
export function formatVehicleLoad(load: VehicleLoadLine[]): string {
  return load.map((l) => `${l.item_name}: ${formatKgNum(l.qty_dispatched_kg)} kg`).join(' • ');
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

// ---------- Honest weighed progress & anti-overwrite accept ----------

export interface StopWeighedSummary {
  weighed_count: number;
  total_count: number;
  /** Σ accepted kg of lines already weighed (pending lines are NOT counted). */
  weighed_accepted_kg: number;
  /** Σ ordered kg of all lines on the card. */
  total_dispatched_kg: number;
}

/** "Tertimbang: 1/2 barang (35 / 60 kg)" — never sums not-yet-weighed lines. */
export function stopWeighedSummary(stop: Pick<KitchenStop, 'items'>): StopWeighedSummary {
  let accepted = 0n;
  let dispatched = 0n;
  let weighed = 0;
  for (const it of stop.items) {
    dispatched += kgToGrams(it.qty_dispatched_kg);
    if (it.is_weighed) {
      weighed += 1;
      accepted += kgToGrams(it.qty_accepted_kg);
    }
  }
  return {
    weighed_count: weighed,
    total_count: stop.items.length,
    weighed_accepted_kg: gramsToKg(accepted),
    total_dispatched_kg: gramsToKg(dispatched),
  };
}

export function formatWeighedSummary(s: StopWeighedSummary): string {
  return `Tertimbang: ${s.weighed_count}/${s.total_count} barang (${formatKgNum(s.weighed_accepted_kg)} / ${formatKgNum(s.total_dispatched_kg)} kg)`;
}

export interface AcceptAsOrderedLine {
  delivery_item_id: string;
  qty_accepted_kg: number;
  rejection_reason: null;
}

/**
 * "✓ Terima Sesuai Order (Semua Barang)": only lines still PENDING
 * (not yet weighed) are accepted at their ordered weight. Lines already
 * weighed (e.g. Wortel 33 kg / reject 2 kg) are NEVER overwritten.
 * Returns [] when nothing is pending or the order is locked (Lunas).
 */
export function buildAcceptPendingLines(stop: Pick<KitchenStop, 'items'>): AcceptAsOrderedLine[] {
  return stop.items
    .filter((it) => !it.is_weighed && !it.is_locked)
    .map((it) => ({
      delivery_item_id: it.delivery_item_id,
      qty_accepted_kg: it.qty_dispatched_kg,
      rejection_reason: null,
    }));
}

/** "Selisih/Reject -2 kg (Hanya ditagih 33 kg ke Dapur)" — kg only, no rupiah. */
export function formatShortfallNote(orderedKg: number, acceptedKg: number): string {
  const diff = gramsToKg(kgToGrams(orderedKg) - kgToGrams(acceptedKg));
  return `Selisih/Reject -${formatKgNum(diff)} kg (Hanya ditagih ${formatKgNum(acceptedKg)} kg ke Dapur)`;
}

// ---------- Shortfall reason (quick chips + short note) ----------

export const SHRINK_REASONS = ['Susut', 'Barang Rusak/Reject', 'Selisih Timbang'] as const;
export type ShrinkReason = (typeof SHRINK_REASONS)[number];

const REASON_SEPARATOR = ' — ';

/** Stored in `rejection_reason`: "Barang Rusak/Reject — wortel patah". */
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

export function describeShrinkReason(text: string | null | undefined): string {
  const { reason, note } = parseShrinkReason(text);
  return [reason, note].filter(Boolean).join(' — ');
}

// ---------- Surat Jalan / BAST recap (kg only, NO prices) ----------

export function stopTitle(stop: Pick<KitchenStop, 'kitchen_code' | 'kitchen_name'>): string {
  return `${stop.kitchen_code} • ${shortKitchenName(stop.kitchen_name)}`;
}

export function buildKitchenBastWaText(stop: KitchenStop): string {
  const lines = [
    `Surat Jalan / BAST Bahan Baku`,
    `${stopTitle(stop)}`,
    `No: ${stop.delivery_number}`,
    `Tanggal: ${stop.delivery_date}`,
    `PIC Dapur: ${stop.pic_name}`,
    '',
  ];
  stop.items.forEach((it, idx) => {
    let line = `${idx + 1}. ${it.item_name}: order ${formatKgNum(it.qty_dispatched_kg)} kg`;
    if (it.is_weighed) {
      line += `, diterima ${formatKgNum(it.qty_accepted_kg)} kg`;
      if (kgToGrams(it.qty_shrinkage_kg) > 0n) {
        const why = describeShrinkReason(it.rejection_reason);
        line += ` (selisih -${formatKgNum(it.qty_shrinkage_kg)} kg${why ? ` — ${why}` : ''})`;
      }
    } else {
      line += ', belum ditimbang';
    }
    lines.push(line);
  });
  lines.push('');
  const s = stopWeighedSummary(stop);
  lines.push(`Total order: ${formatKgNum(s.total_dispatched_kg)} kg`);
  lines.push(`Total diterima: ${formatKgNum(s.weighed_accepted_kg)} kg (${s.weighed_count}/${s.total_count} barang tertimbang)`);
  if (kgToGrams(stop.total_shrinkage_kg) > 0n) {
    lines.push(`Total selisih/reject: -${formatKgNum(stop.total_shrinkage_kg)} kg (tidak ditagihkan ke dapur)`);
  }
  return lines.join('\n');
}
