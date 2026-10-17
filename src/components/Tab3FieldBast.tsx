'use client';

import React, { useState } from 'react';
import {
  buildAcceptPendingLines,
  buildKitchenBastWaText,
  composeShrinkReason,
  courierProgress,
  formatWeighedSummary,
  groupCourierStops,
  isDeliveryDone,
  type KitchenStop,
  parseShrinkReason,
  SHRINK_REASONS,
  type ShrinkReason,
  stopTitle,
  stopWeighedSummary,
  summarizeVehicleLoad,
} from '../lib/courier-view';
import { kgToGrams } from '../lib/financial-engine';
import { type UpdateBastInput, useMbgStore } from '../lib/mbg-store';
import { shareToWhatsApp } from '../lib/share';
import { formatKgNum, shortKitchenName } from '../lib/ui-format';
import type { SafeCourierBastItem } from '../types/mbg';
import { KitchenBastDocument } from './PrintDocuments';
import { Badge, Card, SegmentedControl, Toast, type ToastState } from './ui';

type Filter = 'pending' | 'done';

interface LineDraft {
  weightStr: string;
  /** Typed value is a valid whole kg (≥ 0). `null` = empty or invalid. */
  parsedKg: number | null;
  reason: ShrinkReason | null;
  note: string;
  /** Live shrinkage grams (dispatched − typed accepted). Negative = over dispatched. */
  liveShrinkGrams: bigint;
}

/** Whole-kg input only (Stage 7 Invariant 1): "49" ok, "49.5" / "-1" / "" → null. */
function parseWholeKgInput(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}

/**
 * Kitchen-centric courier view (Stage 6/7): 1 kartu = 1 dapur dengan semua barangnya.
 * Reads ONLY the price-free courier projection (Invariant 5) — no rupiah on screen.
 * Weighed lines are locked into a compact row; pending lines start with an EMPTY input.
 */
export function Tab3FieldBast() {
  const { activeRole, getSafeCourierItems, saveKitchenBast } = useMbgStore();

  const safeItems = getSafeCourierItems();
  const canEdit = activeRole !== 'COOPERATIVE_VIEWER';

  const [filter, setFilter] = useState<Filter>(canEdit ? 'pending' : 'done');
  const [query, setQuery] = useState('');
  const [draftWeights, setDraftWeights] = useState<Record<string, string>>({});
  const [draftReasons, setDraftReasons] = useState<Record<string, ShrinkReason | null>>({});
  const [draftNotes, setDraftNotes] = useState<Record<string, string>>({});
  /** Weighed lines the courier re-opened with "Ubah". */
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<ToastState>(null);
  const [printKitchenId, setPrintKitchenId] = useState<string | null>(null);

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

  const printStop = printKitchenId ? stops.find((s) => s.kitchen_id === printKitchenId) ?? null : null;

  // ---------- Draft helpers ----------

  const getDraft = (it: SafeCourierBastItem): LineDraft => {
    const id = it.delivery_item_id;
    const lineDone = isDeliveryDone(it.delivery_status);
    const stored = parseShrinkReason(it.rejection_reason);
    // Pending lines start EMPTY (never pre-filled with the dispatched weight).
    const weightStr = draftWeights[id] ?? (lineDone ? formatKgNum(it.qty_accepted_kg) : '');
    const parsedKg = parseWholeKgInput(weightStr);
    const dispatchedGrams = kgToGrams(it.qty_dispatched_kg);
    const liveShrinkGrams =
      parsedKg !== null
        ? dispatchedGrams - kgToGrams(parsedKg)
        : lineDone
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
      if (isDeliveryDone(it.delivery_status)) return !!editing[id];
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

  /** Anti-timpa: only lines still "Perlu Ditimbang" without a typed value are accepted as dispatched. */
  const acceptPending = (stop: KitchenStop) => {
    if (!canEdit) return;
    const typedIds = new Set(typedLines(stop).map((it) => it.delivery_item_id));
    const lines = buildAcceptPendingLines(stop).filter((l) => !typedIds.has(l.delivery_item_id));
    if (lines.length === 0) {
      setToast({ kind: 'error', text: `${stopTitle(stop)}: tidak ada barang yang belum ditimbang.` });
      return;
    }
    saveKitchenBast(lines);
    clearDrafts(lines.map((l) => l.delivery_item_id));
    setToast({
      kind: 'ok',
      text: `${stopTitle(stop)}: ${lines.length} barang diterima sesuai kirim. Barang yang sudah ditimbang tidak diubah.`,
    });
  };

  const saveStop = (stop: KitchenStop) => {
    if (!canEdit) return;
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
        setToast({ kind: 'error', text: `${it.item_name}: isi berat diterima dengan angka bulat (kg).` });
        return;
      }
      const dispatchedKg = Number(formatKgNum(it.qty_dispatched_kg));
      if (d.parsedKg > dispatchedKg) {
        setToast({ kind: 'error', text: `${it.item_name}: berat diterima melebihi berat kirim.` });
        return;
      }
      const shrinkKg = dispatchedKg - d.parsedKg;
      acceptedTotal += d.parsedKg;
      shrinkTotal += shrinkKg;
      lines.push({
        delivery_item_id: it.delivery_item_id,
        qty_accepted_kg: d.parsedKg,
        rejection_reason: shrinkKg > 0 ? composeShrinkReason(d.reason ?? 'Susut', d.note) : null,
      });
    }

    saveKitchenBast(lines);
    clearDrafts(lines.map((l) => l.delivery_item_id));
    setToast({
      kind: 'ok',
      text:
        `${stopTitle(stop)}: ${lines.length} barang tersimpan, diterima ${acceptedTotal} kg` +
        (shrinkTotal > 0 ? `, susut -${shrinkTotal} kg.` : ' (utuh).'),
    });
  };

  const openBast = (stop: KitchenStop) => {
    setPrintKitchenId(stop.kitchen_id);
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
    <section aria-label={canEdit ? 'Kirim Dapur' : 'Rekap Timbang Dapur'} className="space-y-3">
      <div className="no-print space-y-3">
        {/* 1. Total Muatan Hari Ini */}
        <Card as="section" className="space-y-2.5 p-3">
          <h2 className="text-sm font-extrabold text-slate-900">
            <span aria-hidden="true">📦</span> Total Muatan Hari Ini
          </h2>
          {load.length === 0 ? (
            <p className="text-xs text-slate-600">Belum ada muatan.</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg bg-slate-50 px-2.5 ring-1 ring-inset ring-slate-200">
              {load.map((l) => (
                <li key={l.item_id} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                  <span className="min-w-0 truncate font-medium text-slate-700">{l.item_name}</span>
                  <span className="shrink-0 font-bold tabular-nums text-slate-900">
                    {formatKgNum(l.qty_dispatched_kg)} kg
                  </span>
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
                Total susut fisik: -{formatKgNum(progress.total_shrinkage_kg)} kg (potong tagihan supplier)
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

        {/* 3. 1 kartu = 1 dapur lengkap */}
        <div className="space-y-3">
          {visibleStops.map((stop) => (
            <Card as="article" key={stop.kitchen_id} className="overflow-hidden">
              <header className="flex items-start justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2.5">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-extrabold text-slate-900">
                    {stop.kitchen_code} • {shortKitchenName(stop.kitchen_name)}
                  </h3>
                  <p className="truncate text-xs text-slate-600">
                    PIC: {stop.pic_name} • {stop.items.length} barang
                  </p>
                </div>
                <Badge tone={stop.done ? 'green' : 'amber'}>{stop.done ? 'Selesai' : 'Belum Selesai'}</Badge>
              </header>

              <ul className="space-y-2 px-3 py-2.5">
                {stop.items.map((it) => {
                  const id = it.delivery_item_id;
                  const d = getDraft(it);
                  const lineDone = isDeliveryDone(it.delivery_status);
                  const inputOpen = canEdit && (!lineDone || !!editing[id]);
                  const over = d.liveShrinkGrams < 0n;
                  const shrinkKgText = formatKgNum(Number(d.liveShrinkGrams) / 1000);
                  const weightId = `bast-w-${id}`;
                  const noteId = `bast-n-${id}`;
                  const dispatchedText = formatKgNum(it.qty_dispatched_kg);

                  // ✓ Tertimbang → 1 baris ringkas terkunci (tanpa input / tombol 100%).
                  if (lineDone && !inputOpen) {
                    const storedShrink = kgToGrams(it.qty_shrinkage_kg);
                    return (
                      <li
                        key={id}
                        className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2"
                      >
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-semibold text-slate-900">{it.item_name}</span>
                          {storedShrink > 0n ? (
                            <Badge tone="red">Susut -{formatKgNum(it.qty_shrinkage_kg)} kg</Badge>
                          ) : (
                            <Badge tone="green">✓ Tertimbang</Badge>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="text-sm font-bold tabular-nums text-slate-900">
                            {formatKgNum(it.qty_accepted_kg)} / {dispatchedText} kg
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
                      </li>
                    );
                  }

                  // Perlu Ditimbang (viewer tanpa hak ubah): hanya info kirim.
                  if (!inputOpen) {
                    return (
                      <li
                        key={id}
                        className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2"
                      >
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-semibold text-slate-900">{it.item_name}</span>
                          <Badge tone="amber">Perlu Ditimbang</Badge>
                        </div>
                        <span className="shrink-0 text-sm font-bold tabular-nums text-slate-900">
                          Kirim {dispatchedText} kg
                        </span>
                      </li>
                    );
                  }

                  // Input terbuka: barang PENDING (input kosong) atau barang tertimbang yang di-Ubah.
                  return (
                    <li
                      key={id}
                      className={`space-y-2 rounded-lg px-3 py-2.5 ring-1 ring-inset ${
                        lineDone ? 'bg-white ring-slate-300' : 'bg-amber-50/60 ring-amber-200'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-semibold text-slate-900">{it.item_name}</span>
                          {lineDone ? (
                            <Badge tone="slate">Ubah Timbangan</Badge>
                          ) : (
                            <Badge tone="amber">Perlu Ditimbang</Badge>
                          )}
                        </div>
                        {lineDone && (
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
                          <div className="text-[11px] font-medium text-slate-600">Kirim</div>
                          <div className="text-base font-bold tabular-nums text-slate-900">
                            {dispatchedText} <span className="text-xs font-semibold">kg</span>
                          </div>
                        </div>
                        <div>
                          <label htmlFor={weightId} className="block text-[11px] font-medium text-slate-600">
                            Diterima (kg)
                          </label>
                          <div className="mt-0.5 flex gap-1.5">
                            <input
                              id={weightId}
                              type="number"
                              inputMode="numeric"
                              step="1"
                              min="0"
                              max={dispatchedText}
                              placeholder="0"
                              value={d.weightStr}
                              onChange={(e) => setDraftWeights((p) => ({ ...p, [id]: e.target.value }))}
                              className={`h-11 w-full min-w-0 rounded-lg border-2 bg-white px-2.5 text-right text-base font-bold tabular-nums text-slate-900 focus:border-emerald-600 ${
                                over ? 'border-rose-500' : 'border-slate-300'
                              }`}
                            />
                            <button
                              type="button"
                              onClick={() => setDraftWeights((p) => ({ ...p, [id]: dispatchedText }))}
                              aria-label={`Isi sesuai kirim ${dispatchedText} kg untuk ${it.item_name}`}
                              className="h-11 shrink-0 whitespace-nowrap rounded-lg border border-emerald-600 bg-white px-2 text-xs font-bold text-emerald-700 transition hover:bg-emerald-50"
                            >
                              ✓ Pas ({dispatchedText} kg)
                            </button>
                          </div>
                        </div>
                      </div>

                      {over && (
                        <p role="alert" className="text-xs font-semibold text-rose-700">
                          Melebihi berat kirim.
                        </p>
                      )}

                      {d.liveShrinkGrams > 0n && (
                        <div className="space-y-1.5">
                          <div className="rounded-md bg-rose-50 px-2.5 py-1.5 text-xs font-bold tabular-nums text-rose-700 ring-1 ring-inset ring-rose-200">
                            Susut -{shrinkKgText} kg (Potong Tagihan Supplier)
                          </div>
                          <div role="group" aria-label={`Alasan susut ${it.item_name}`} className="flex flex-wrap gap-1.5">
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
                            Catatan susut {it.item_name}
                          </label>
                          <input
                            id={noteId}
                            type="text"
                            placeholder="Catatan singkat (mis. memar, susut air)"
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

              {(() => {
                const summary = stopWeighedSummary(stop);
                const hasTyped = canEdit && typedLines(stop).length > 0;
                const hasPending = canEdit && stop.pending_count > 0;
                return (
                  <footer className="space-y-2 border-t border-slate-200 bg-white px-3 py-2.5">
                    <p className="text-xs font-semibold tabular-nums text-slate-700">
                      {formatWeighedSummary(summary)}
                    </p>

                    {(hasPending || hasTyped) && (
                      <div className="grid grid-cols-1 gap-2">
                        {hasTyped && (
                          <button
                            type="button"
                            onClick={() => saveStop(stop)}
                            className="btn-primary min-h-[48px] w-full"
                          >
                            💾 Simpan Timbangan Dapur
                          </button>
                        )}
                        {hasPending && (
                          <button
                            type="button"
                            onClick={() => acceptPending(stop)}
                            className={`${hasTyped ? 'btn-secondary' : 'btn-primary'} min-h-[48px] w-full text-center leading-tight`}
                          >
                            ✓ Terima Sesuai Kirim (Barang Belum Timbang)
                          </button>
                        )}
                      </div>
                    )}

                    {stop.done && (
                      <div className={`grid gap-2 ${canEdit ? 'grid-cols-2' : 'grid-cols-1'}`}>
                        <button
                          type="button"
                          onClick={() => openBast(stop)}
                          className="btn-secondary min-h-[44px] px-1 text-xs"
                        >
                          📄 Bukti BAST
                        </button>
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => shareBast(stop)}
                            className="btn-secondary min-h-[44px] px-1 text-xs"
                          >
                            💬 WA BAST ke PIC
                          </button>
                        )}
                      </div>
                    )}
                  </footer>
                );
              })()}
            </Card>
          ))}
        </div>
      </div>

      {/* Bukti BAST preview (kg only, no prices) */}
      {printStop && (
        <div className="no-print fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Pratinjau Bukti BAST"
            className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl"
          >
            <div className="mb-3 flex items-center justify-between gap-2 border-b border-slate-200 pb-2">
              <span className="text-sm font-bold text-slate-900">Bukti BAST</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => window.print()} className="btn-primary min-h-[36px] text-xs">
                  🖨️ Cetak / PDF
                </button>
                <button
                  type="button"
                  onClick={() => setPrintKitchenId(null)}
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
