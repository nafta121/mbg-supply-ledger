'use client';

import React, { useState } from 'react';
import {
  buildAcceptPendingLines,
  buildKitchenBastWaText,
  composeShrinkReason,
  courierProgress,
  formatShortfallNote,
  formatWeighedSummary,
  groupCourierStops,
  type KitchenStop,
  parseShrinkReason,
  SHRINK_REASONS,
  type ShrinkReason,
  stopTitle,
  stopWeighedSummary,
  summarizeVehicleLoad,
} from '../lib/courier-view';
import { kgToGrams, roundKg } from '../lib/financial-engine';
import { type UpdateBastInput, useMbgStore } from '../lib/mbg-store';
import { shareToWhatsApp } from '../lib/share';
import { formatKg, formatKgNum, parseAcceptedKgInput, shortKitchenName } from '../lib/ui-format';
import type { SafeCourierBastItem } from '../types/mbg';
import { KitchenBastDocument } from './PrintDocuments';
import { Badge, Card, SegmentedControl, Toast, type ToastState } from './ui';

type Filter = 'pending' | 'done';

interface LineDraft {
  weightStr: string;
  /** Typed value is a valid kg (≥ 0, supports decimals e.g. 12.5 or 0.2). `null` = empty or invalid. */
  parsedKg: number | null;
  reason: ShrinkReason | null;
  note: string;
  /** Live shortfall grams (ordered − typed accepted). Negative = over the order. */
  liveShrinkGrams: bigint;
}

function stopStatus(stop: KitchenStop): { label: string; tone: 'green' | 'amber' | 'slate' } {
  if (stop.locked) return { label: 'Lunas • Terkunci', tone: 'green' };
  if (stop.done) return { label: 'Selesai BAST', tone: 'green' };
  if (stop.pending_count < stop.items.length) return { label: 'Sebagian Tertimbang', tone: 'amber' };
  return { label: 'Menunggu Kurir', tone: 'slate' };
}

/**
 * Tab 2 — "Timbang" (Kurir `Lapangan` & Admin): 1 kartu = 1 Order Dapur dengan semua barangnya.
 * Reads ONLY the price-free courier projection (Invariant 5) — no rupiah on screen.
 * Weighed lines are locked into a compact row; pending lines start with an EMPTY input.
 */
export function Tab2CourierWeighing() {
  const { activeRole, getSafeCourierItems, saveKitchenBast } = useMbgStore();

  const safeItems = getSafeCourierItems();
  const canEditRole = activeRole !== 'COOPERATIVE_VIEWER';

  const [filter, setFilter] = useState<Filter>(canEditRole ? 'pending' : 'done');
  const [query, setQuery] = useState('');
  const [draftWeights, setDraftWeights] = useState<Record<string, string>>({});
  const [draftReasons, setDraftReasons] = useState<Record<string, ShrinkReason | null>>({});
  const [draftNotes, setDraftNotes] = useState<Record<string, string>>({});
  /** Weighed lines the courier re-opened with "Ubah". */
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<ToastState>(null);
  const [printDeliveryId, setPrintDeliveryId] = useState<string | null>(null);

  const stops = groupCourierStops(safeItems);
  const load = summarizeVehicleLoad(safeItems);
  const progress = courierProgress(stops);
  const pendingStops = stops.filter((s) => !s.done).length;
  const doneStops = stops.length - pendingStops;
  const progressPct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  const q = query.trim().toLowerCase();
  const visibleStops = stops.filter((s) => {
    if ((filter === 'done') !== s.done) return false;
    if (!q) return true;
    return (
      s.kitchen_name.toLowerCase().includes(q) ||
      s.kitchen_code.toLowerCase().includes(q) ||
      s.items.some((i) => i.item_name.toLowerCase().includes(q))
    );
  });

  const printStop = printDeliveryId ? stops.find((s) => s.delivery_id === printDeliveryId) ?? null : null;

  // ---------- Draft helpers ----------

  const getDraft = (it: SafeCourierBastItem): LineDraft => {
    const id = it.delivery_item_id;
    const stored = parseShrinkReason(it.rejection_reason);
    // Pending lines start EMPTY (never pre-filled with the ordered weight).
    const weightStr = draftWeights[id] ?? (it.is_weighed ? formatKgNum(it.qty_accepted_kg) : '');
    const parsedKg = parseAcceptedKgInput(weightStr);
    const orderedGrams = kgToGrams(it.qty_dispatched_kg);
    const liveShrinkGrams =
      parsedKg !== null
        ? orderedGrams - kgToGrams(parsedKg)
        : it.is_weighed
          ? kgToGrams(it.qty_shrinkage_kg)
          : 0n;
    return {
      weightStr,
      parsedKg,
      reason: id in draftReasons ? draftReasons[id] ?? null : stored.reason,
      note: draftNotes[id] ?? stored.note,
      liveShrinkGrams,
    };
  };

  /** Lines whose typed weight should be saved by "💾 Simpan Timbangan Dapur". */
  const typedLines = (stop: KitchenStop) =>
    stop.items.filter((it) => {
      const id = it.delivery_item_id;
      if (it.is_weighed) return !!editing[id];
      return (draftWeights[id] ?? '').trim() !== '';
    });

  const clearDrafts = (ids: string[]) => {
    const drop = <T,>(rec: Record<string, T>) => {
      const next = { ...rec };
      for (const id of ids) delete next[id];
      return next;
    };
    setDraftWeights(drop);
    setDraftReasons(drop);
    setDraftNotes(drop);
    setEditing(drop);
  };

  // ---------- Actions ----------

  /** Anti-timpa: only lines still "Perlu Ditimbang" without a typed value are accepted as ordered. */
  const acceptPending = (stop: KitchenStop) => {
    if (!canEditRole || stop.locked) return;
    const typedIds = new Set(typedLines(stop).map((it) => it.delivery_item_id));
    const lines = buildAcceptPendingLines(stop).filter((l) => !typedIds.has(l.delivery_item_id));
    if (lines.length === 0) {
      setToast({ kind: 'error', text: `${stopTitle(stop)}: tidak ada barang yang belum ditimbang.` });
      return;
    }
    const res = saveKitchenBast(lines);
    if (!res.ok) {
      setToast({ kind: 'error', text: res.error });
      return;
    }
    clearDrafts(lines.map((l) => l.delivery_item_id));
    setToast({
      kind: 'ok',
      text: `${stopTitle(stop)}: ${lines.length} barang diterima sesuai order. Barang yang sudah ditimbang tidak diubah.`,
    });
  };

  const saveStop = (stop: KitchenStop) => {
    if (!canEditRole || stop.locked) return;
    const targets = typedLines(stop);
    if (targets.length === 0) {
      setToast({ kind: 'error', text: `${stopTitle(stop)}: isi berat diterima dulu, atau ketuk ✓ Pas.` });
      return;
    }

    const lines: UpdateBastInput[] = [];
    let acceptedTotal = 0;
    let shrinkTotal = 0;

    for (const it of targets) {
      const d = getDraft(it);
      if (d.parsedKg === null) {
        setToast({ kind: 'error', text: `${it.item_name}: isi berat diterima (contoh: 12,5 atau 0,2 kg).` });
        return;
      }
      const orderedKg = roundKg(it.qty_dispatched_kg);
      if (d.parsedKg > orderedKg) {
        setToast({ kind: 'error', text: `${it.item_name}: berat diterima melebihi berat order.` });
        return;
      }
      const shrinkKg = Math.round((orderedKg - d.parsedKg) * 1000) / 1000;
      acceptedTotal = Math.round((acceptedTotal + d.parsedKg) * 1000) / 1000;
      shrinkTotal = Math.round((shrinkTotal + shrinkKg) * 1000) / 1000;
      lines.push({
        delivery_item_id: it.delivery_item_id,
        qty_accepted_kg: d.parsedKg,
        rejection_reason: shrinkKg > 0 ? composeShrinkReason(d.reason ?? 'Susut', d.note) : null,
      });
    }

    const res = saveKitchenBast(lines);
    if (!res.ok) {
      setToast({ kind: 'error', text: res.error });
      return;
    }
    clearDrafts(lines.map((l) => l.delivery_item_id));
    setToast({
      kind: 'ok',
      text:
        `${stopTitle(stop)}: ${lines.length} barang tersimpan, diterima ${formatKg(acceptedTotal)}` +
        (shrinkTotal > 0 ? `, selisih -${formatKg(shrinkTotal)} (tidak ditagih).` : ' (sesuai order).'),
    });
  };

  const shareBast = (stop: KitchenStop) => {
    void shareToWhatsApp(stop.pic_phone, buildKitchenBastWaText(stop)).then((ok) =>
      setToast(
        ok
          ? { kind: 'ok', text: 'Rekap BAST disalin & WhatsApp dibuka.' }
          : { kind: 'error', text: 'Gagal menyalin otomatis. WhatsApp tetap dibuka.' }
      )
    );
  };

  // ---------- Render ----------

  return (
    <section aria-label={canEditRole ? 'Timbang Kurir' : 'Rekap Timbang Dapur'} className="space-y-3">
      <div className="no-print space-y-3">
        {/* 1. Total barang yang harus dibawa kurir */}
        <Card as="section" className="space-y-2.5 p-3">
          <h2 className="text-sm font-extrabold text-slate-900">
            <span aria-hidden="true">📦</span> Total Barang yang Harus Dibawa Kurir
          </h2>
          {load.length === 0 ? (
            <p className="text-xs text-slate-600">Belum ada order dapur.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {load.map((l) => (
                <li
                  key={l.item_id}
                  className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs ring-1 ring-inset ring-slate-200"
                >
                  <span className="font-medium text-slate-700">{l.item_name}:</span>{' '}
                  <span className="font-bold tabular-nums text-slate-900">{formatKgNum(l.qty_dispatched_kg)} kg</span>
                </li>
              ))}
            </ul>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-bold text-slate-900">
                Progres Kurir: {progress.done} dari {progress.total} Dapur Selesai
              </span>
              <span className="tabular-nums text-slate-600">{progressPct}%</span>
            </div>
            <div
              role="progressbar"
              aria-label="Progres kunjungan dapur"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
              className="h-2 overflow-hidden rounded-full bg-slate-200"
            >
              <div className="h-full rounded-full bg-emerald-600 transition-all" style={{ width: `${progressPct}%` }} />
            </div>
            {kgToGrams(progress.total_shrinkage_kg) > 0n && (
              <p className="text-xs font-semibold tabular-nums text-rose-700">
                Total selisih/reject: -{formatKgNum(progress.total_shrinkage_kg)} kg (tidak ditagih ke dapur)
              </p>
            )}
          </div>
        </Card>

        <SegmentedControl<Filter>
          label="Filter dapur"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'pending', label: `Belum Selesai (${pendingStops})` },
            { value: 'done', label: `Selesai (${doneStops})` },
          ]}
        />

        <div>
          <label htmlFor="bast-search" className="sr-only">
            Cari dapur atau barang
          </label>
          <input
            id="bast-search"
            type="search"
            placeholder="Cari dapur atau barang…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="field-input"
          />
        </div>

        <Toast toast={toast} onClose={() => setToast(null)} />

        {visibleStops.length === 0 && (
          <Card className="p-6 text-center text-sm font-medium text-slate-600">
            {filter === 'pending' ? 'Semua dapur sudah selesai.' : 'Belum ada dapur yang selesai.'}
          </Card>
        )}

        {/* 2. 1 kartu = 1 dapur beserta seluruh barang orderannya */}
        <div className="space-y-3">
          {visibleStops.map((stop) => {
            const canEdit = canEditRole && !stop.locked;
            const status = stopStatus(stop);
            return (
              <Card as="article" key={stop.delivery_id} className="overflow-hidden">
                <header className="flex items-start justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2.5">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-extrabold text-slate-900">
                      {stop.kitchen_code} • {shortKitchenName(stop.kitchen_name)}
                    </h3>
                    <p className="truncate text-xs text-slate-600">
                      PIC: {stop.pic_name} • {stop.items.length} barang
                    </p>
                  </div>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </header>

                <ul className="space-y-2 px-3 py-2.5">
                  {stop.items.map((it) => {
                    const id = it.delivery_item_id;
                    const d = getDraft(it);
                    const inputOpen = canEdit && (!it.is_weighed || !!editing[id]);
                    const over = d.liveShrinkGrams < 0n;
                    const weightId = `bast-w-${id}`;
                    const noteId = `bast-n-${id}`;
                    const orderedText = formatKgNum(it.qty_dispatched_kg);

                    // ✓ Tertimbang → 1 baris ringkas terkunci.
                    if (it.is_weighed && !inputOpen) {
                      const storedShrink = kgToGrams(it.qty_shrinkage_kg);
                      return (
                        <li key={id} className="space-y-1 rounded-lg bg-slate-50 px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate text-sm font-semibold text-slate-900">{it.item_name}</span>
                            <div className="flex shrink-0 items-center gap-2">
                              <span className="text-sm font-bold tabular-nums text-emerald-700">
                                ✓ Tertimbang: {formatKgNum(it.qty_accepted_kg)} / {orderedText} kg
                              </span>
                              {canEdit && (
                                <button
                                  type="button"
                                  onClick={() => setEditing((p) => ({ ...p, [id]: true }))}
                                  aria-label={`Ubah timbangan ${it.item_name}`}
                                  className="min-h-[32px] rounded-md px-1.5 text-xs font-semibold text-emerald-700 underline-offset-2 hover:underline"
                                >
                                  Ubah
                                </button>
                              )}
                            </div>
                          </div>
                          {storedShrink > 0n && (
                            <Badge tone="red">{formatShortfallNote(it.qty_dispatched_kg, it.qty_accepted_kg)}</Badge>
                          )}
                        </li>
                      );
                    }

                    // Perlu Ditimbang (viewer tanpa hak ubah): hanya info order.
                    if (!inputOpen) {
                      return (
                        <li key={id} className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2">
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm font-semibold text-slate-900">{it.item_name}</span>
                            <Badge tone="amber">Perlu Ditimbang</Badge>
                          </div>
                          <span className="shrink-0 text-sm font-bold tabular-nums text-slate-900">
                            Order/Kirim {orderedText} kg
                          </span>
                        </li>
                      );
                    }

                    // Input terbuka: barang PENDING (input kosong) atau barang tertimbang yang di-Ubah.
                    return (
                      <li
                        key={id}
                        className={`space-y-2 rounded-lg px-3 py-2.5 ring-1 ring-inset ${
                          it.is_weighed ? 'bg-white ring-slate-300' : 'bg-amber-50/60 ring-amber-200'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm font-semibold text-slate-900">{it.item_name}</span>
                            {it.is_weighed ? (
                              <Badge tone="slate">Ubah Timbangan</Badge>
                            ) : (
                              <Badge tone="amber">Perlu Ditimbang</Badge>
                            )}
                          </div>
                          {it.is_weighed && (
                            <button
                              type="button"
                              onClick={() => clearDrafts([id])}
                              className="min-h-[32px] shrink-0 rounded-md px-1.5 text-xs font-semibold text-slate-600 underline-offset-2 hover:underline"
                            >
                              Batal
                            </button>
                          )}
                        </div>

                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.8fr)] items-end gap-2">
                          <div className="rounded-lg bg-white px-2.5 py-1.5 ring-1 ring-inset ring-slate-200">
                            <div className="text-[11px] font-medium text-slate-600">Order/Kirim</div>
                            <div className="text-base font-bold tabular-nums text-slate-900">
                              {orderedText} <span className="text-xs font-semibold">kg</span>
                            </div>
                          </div>
                          <div>
                            <label htmlFor={weightId} className="block text-[11px] font-medium text-slate-600">
                              Diterima (kg)
                            </label>
                            <div className="mt-0.5 flex gap-1.5">
                              <input
                                id={weightId}
                                type="text"
                                inputMode="decimal"
                                step="any"
                                placeholder="Contoh: 12,5 atau 0,2"
                                value={d.weightStr}
                                onChange={(e) => setDraftWeights((p) => ({ ...p, [id]: e.target.value }))}
                                className={`h-11 w-full min-w-0 rounded-lg border-2 bg-white px-2.5 text-right text-base font-bold tabular-nums text-slate-900 focus:border-emerald-600 ${
                                  over ? 'border-rose-500' : 'border-slate-300'
                                }`}
                              />
                              <button
                                type="button"
                                onClick={() => setDraftWeights((p) => ({ ...p, [id]: orderedText }))}
                                aria-label={`Isi sesuai order ${orderedText} kg untuk ${it.item_name}`}
                                className="h-11 shrink-0 whitespace-nowrap rounded-lg border border-emerald-600 bg-white px-2 text-xs font-bold text-emerald-700 transition hover:bg-emerald-50"
                              >
                                ✓ Pas ({orderedText} kg)
                              </button>
                            </div>
                          </div>
                        </div>

                        {over && (
                          <p role="alert" className="text-xs font-semibold text-rose-700">
                            Melebihi berat order.
                          </p>
                        )}

                        {d.liveShrinkGrams > 0n && d.parsedKg !== null && (
                          <div className="space-y-1.5">
                            <div className="rounded-md bg-rose-50 px-2.5 py-1.5 text-xs font-bold tabular-nums text-rose-700 ring-1 ring-inset ring-rose-200">
                              {formatShortfallNote(it.qty_dispatched_kg, d.parsedKg)}
                            </div>
                            <div role="group" aria-label={`Alasan selisih ${it.item_name}`} className="flex flex-wrap gap-1.5">
                              {SHRINK_REASONS.map((r) => {
                                const active = (d.reason ?? 'Susut') === r;
                                return (
                                  <button
                                    key={r}
                                    type="button"
                                    aria-pressed={active}
                                    onClick={() => setDraftReasons((p) => ({ ...p, [id]: r }))}
                                    className={`min-h-[32px] rounded-full px-2.5 text-[11px] font-semibold transition ${
                                      active
                                        ? 'bg-rose-600 text-white'
                                        : 'border border-rose-300 bg-white text-rose-700 hover:bg-rose-50'
                                    }`}
                                  >
                                    {r}
                                  </button>
                                );
                              })}
                            </div>
                            <label htmlFor={noteId} className="sr-only">
                              Catatan selisih {it.item_name}
                            </label>
                            <input
                              id={noteId}
                              type="text"
                              placeholder="Catatan singkat (mis. busuk, memar, susut air)"
                              value={d.note}
                              onChange={(e) => setDraftNotes((p) => ({ ...p, [id]: e.target.value }))}
                              className="field-input min-h-[40px]"
                            />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>

                <footer className="space-y-2 border-t border-slate-200 bg-white px-3 py-2.5">
                  <p className="text-xs font-semibold tabular-nums text-slate-700">
                    {formatWeighedSummary(stopWeighedSummary(stop))}
                  </p>

                  {canEdit && (stop.pending_count > 0 || typedLines(stop).length > 0) && (
                    <div className="grid grid-cols-1 gap-2">
                      {stop.pending_count > 0 && (
                        <button
                          type="button"
                          onClick={() => acceptPending(stop)}
                          className={`${typedLines(stop).length > 0 ? 'btn-secondary' : 'btn-primary'} min-h-[48px] w-full text-center leading-tight`}
                        >
                          ✓ Terima Sesuai Order (Semua Barang)
                        </button>
                      )}
                      {typedLines(stop).length > 0 && (
                        <button type="button" onClick={() => saveStop(stop)} className="btn-primary min-h-[48px] w-full">
                          💾 Simpan Timbangan Dapur
                        </button>
                      )}
                    </div>
                  )}

                  <div className={`grid gap-2 ${canEditRole ? 'grid-cols-2' : 'grid-cols-1'}`}>
                    <button
                      type="button"
                      onClick={() => setPrintDeliveryId(stop.delivery_id)}
                      className="btn-secondary min-h-[44px] px-1 text-xs"
                    >
                      📄 Cetak Surat Jalan / BAST
                    </button>
                    {canEditRole && (
                      <button
                        type="button"
                        onClick={() => shareBast(stop)}
                        className="btn-secondary min-h-[44px] px-1 text-xs"
                      >
                        💬 WA BAST
                      </button>
                    )}
                  </div>
                </footer>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Surat Jalan / BAST preview (kg only, no prices) */}
      {printStop && (
        <div className="no-print fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Pratinjau Surat Jalan / BAST"
            className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl"
          >
            <div className="mb-3 flex items-center justify-between gap-2 border-b border-slate-200 pb-2">
              <span className="text-sm font-bold text-slate-900">Surat Jalan / BAST</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => window.print()} className="btn-primary min-h-[36px] text-xs">
                  🖨️ Cetak / PDF
                </button>
                <button
                  type="button"
                  onClick={() => setPrintDeliveryId(null)}
                  className="btn-secondary min-h-[36px] text-xs"
                >
                  Tutup
                </button>
              </div>
            </div>
            <KitchenBastDocument stop={printStop} />
          </div>
        </div>
      )}

      <div className="print-only p-6">{printStop && <KitchenBastDocument stop={printStop} />}</div>
    </section>
  );
}
