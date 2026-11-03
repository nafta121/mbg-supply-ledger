/**
 * Shortfall reason helpers (quick chips + short note) for BAST & invoice shrinkage lines.
 */

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
