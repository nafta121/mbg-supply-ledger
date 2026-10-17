'use client';

import React, { useState } from 'react';
import {
  buildKitchenBastWaText,
  composeShrinkReason,
  courierProgress,
  groupCourierStops,
  isDeliveryDone,
  type KitchenStop,
  parseShrinkReason,
  SHRINK_REASONS,
  type ShrinkReason,
  stopTitle,
  summarizeVehicleLoad,
} from '../lib/courier-view';
import { gramsToKg, kgToGrams } from '../lib/financial-engine';
import { type UpdateBastInput, useMbgStore } from '../lib/mbg-store';
import { shareToWhatsApp } from '../lib/share';
import { formatKgNum, shortKitchenName } from '../lib/ui-format';
import type { SafeCourierBastItem } from '../types/mbg';
import { KitchenBastDocument } from './PrintDocuments';
import { Badge, Card, SegmentedControl, Toast, type ToastState } from './ui';

type Filter = 'pending' | 'done';

interface LineDraft {
  weightStr: string;
  reason: ShrinkReason | null;
  note: string;
  /** Live accepted grams for display (falls back to stored value while typing). */
  liveAcceptedGrams: bigint;
  /** Live shrinkage grams (dispatched − accepted). Negative = over dispatched. */
  liveShrinkGrams: bigint;
}

/**
 * Kitchen-centric courier view (Stage 6): 1 kartu = 1 dapur dengan semua barangnya.
 * Reads ONLY the price-free courier projection (Invariant 5) — no rupiah on screen.
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
    const stored = parseShrinkReason(it.rejection_reason);
    const weightStr = draftWeights[id] ?? formatKgNum(it.qty_accepted_kg);
    const parsed = Number(weightStr);
    const liveAcceptedGrams =
      weightStr.trim() !== '' && Number.isFinite(parsed) && parsed >= 0
        ? kgToGrams(parsed)
        : kgToGrams(it.qty_accepted_kg);
    return {
      weightStr,
      reason: id in draftReasons ? draftReasons[id] ?? null : stored.reason,
      note: draftNotes[id] ?? stored.note,
      liveAcceptedGrams,
      liveShrinkGrams: kgToGrams(it.qty_dispatched_kg) - liveAcceptedGrams,
    };
  };

  const clearDrafts = (ids: string[]) => {
    const drop = <T,>(rec: Record<string, T>) => {
      const next = { ...rec };
      for (const id of ids) delete next[id];
      return next;
    };
    setDraftWeights(drop);
    setDraftReasons(drop);
    setDraftNotes(drop);
  };

  // ---------- Actions ----------

  const acceptAll = (stop: KitchenStop) => {
    if (!canEdit) return;
    const targets = stop.items.filter((it) => !isDeliveryDone(it.delivery_status));
    const lines: UpdateBastInput[] = (targets.length > 0 ? targets : stop.items).map((it) => ({
      delivery_item_id: it.delivery_item_id,
      qty_accepted_kg: it.qty_dispatched_kg,
      rejection_reason: null,
    }));
    saveKitchenBast(lines);
    clearDrafts(lines.map((l) => l.delivery_item_id));
    setToast({
      kind: 'ok',
      text: `${stopTitle(stop)}: ${lines.length} barang diterima 100%. BAST tersimpan.`,
    });
  };

  const saveStop = (stop: KitchenStop) => {
    if (!canEdit) return;
    const lines: UpdateBastInput[] = [];
    let acceptedTotal = 0n;
    let shrinkTotal = 0n;

    for (const it of stop.items) {
      const d = getDraft(it);
      const val = Number(d.weightStr);
      if (d.weightStr.trim() === '' || !Number.isFinite(val) || val < 0) {
        setToast({ kind: 'error', text: `${it.item_name}: isi berat diterima dengan benar.` });
        return;
      }
      const acceptedGrams = kgToGrams(val);
      const dispatchedGrams = kgToGrams(it.qty_dispatched_kg);
      if (acceptedGrams > dispatchedGrams) {
        setToast({ kind: 'error', text: `${it.item_name}: berat diterima melebihi berat kirim.` });
        return;
      }
      const shrinkGrams = dispatchedGrams - acceptedGrams;
      const reasonText = shrinkGrams > 0n ? composeShrinkReason(d.reason ?? 'Susut', d.note) : null;
      acceptedTotal += acceptedGrams;
      shrinkTotal += shrinkGrams;

      const changed =
        !isDeliveryDone(it.delivery_status) ||
        acceptedGrams !== kgToGrams(it.qty_accepted_kg) ||
        (shrinkGrams > 0n && reasonText !== it.rejection_reason);
      if (changed) {
        lines.push({
          delivery_item_id: it.delivery_item_id,
          qty_accepted_kg: gramsToKg(acceptedGrams),
          rejection_reason: reasonText,
        });
      }
    }

    if (lines.length === 0) {
      setToast({ kind: 'ok', text: `${stopTitle(stop)}: tidak ada perubahan timbangan.` });
      return;
    }
    saveKitchenBast(lines);
    clearDrafts(lines.map((l) => l.delivery_item_id));
    setToast({
      kind: 'ok',
      text:
        `${stopTitle(stop)}: diterima ${formatKgNum(gramsToKg(acceptedTotal))} kg` +
        (shrinkTotal > 0n ? `, susut ${formatKgNum(gramsToKg(shrinkTotal))} kg.` : ' (utuh).'),
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

              <ul className="divide-y divide-slate-100 px-3">
                {stop.items.map((it) => {
                  const id = it.delivery_item_id;
                  const d = getDraft(it);
                  const lineDone = isDeliveryDone(it.delivery_status);
                  const over = d.liveShrinkGrams < 0n;
                  const shrinkGrams = canEdit ? d.liveShrinkGrams : kgToGrams(it.qty_shrinkage_kg);
                  const weightId = `bast-w-${id}`;
                  const noteId = `bast-n-${id}`;

                  return (
                    <li key={id} className="space-y-2 py-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-900">{it.item_name}</p>
                          <p className="truncate font-mono text-[11px] text-slate-500">{it.batch_code}</p>
                        </div>
                        {lineDone && (
                          <span className="shrink-0 text-[11px] font-semibold text-emerald-700">✓ Tertimbang</span>
                        )}
                      </div>

                      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] items-end gap-2">
                        <div className="rounded-lg bg-slate-100 px-2.5 py-1.5">
                          <div className="text-[11px] font-medium text-slate-600">Kirim</div>
                          <div className="text-base font-bold tabular-nums text-slate-900">
                            {formatKgNum(it.qty_dispatched_kg)} <span className="text-xs font-semibold">kg</span>
                          </div>
                        </div>
                        {canEdit ? (
                          <div>
                            <label htmlFor={weightId} className="block text-[11px] font-medium text-slate-600">
                              Diterima (kg)
                            </label>
                            <div className="mt-0.5 flex gap-1.5">
                              <input
                                id={weightId}
                                type="number"
                                inputMode="decimal"
                                step="0.001"
                                min="0"
                                max={it.qty_dispatched_kg}
                                value={d.weightStr}
                                onChange={(e) => setDraftWeights((p) => ({ ...p, [id]: e.target.value }))}
                                className={`h-11 w-full min-w-0 rounded-lg border-2 px-2.5 text-right text-base font-bold tabular-nums text-slate-900 focus:border-emerald-600 ${
                                  over ? 'border-rose-500' : 'border-slate-300'
                                }`}
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  setDraftWeights((p) => ({ ...p, [id]: formatKgNum(it.qty_dispatched_kg) }))
                                }
                                aria-label={`Isi 100% ${it.item_name}`}
                                className="h-11 shrink-0 rounded-lg border border-emerald-600 px-2 text-xs font-bold text-emerald-700 transition hover:bg-emerald-50"
                              >
                                100%
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="rounded-lg bg-slate-100 px-2.5 py-1.5">
                            <div className="text-[11px] font-medium text-slate-600">Diterima</div>
                            <div className="text-base font-bold tabular-nums text-slate-900">
                              {formatKgNum(it.qty_accepted_kg)} <span className="text-xs font-semibold">kg</span>
                            </div>
                          </div>
                        )}
                      </div>

                      {canEdit && over && (
                        <p role="alert" className="text-xs font-semibold text-rose-700">
                          Melebihi berat kirim.
                        </p>
                      )}

                      {shrinkGrams > 0n && (
                        <div className="space-y-1.5">
                          <div className="rounded-md bg-rose-50 px-2.5 py-1.5 text-xs font-bold tabular-nums text-rose-700 ring-1 ring-inset ring-rose-200">
                            Susut -{formatKgNum(gramsToKg(shrinkGrams))} kg (Potong Tagihan Supplier)
                          </div>
                          {canEdit ? (
                            <>
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
                            </>
                          ) : (
                            <p className="flex flex-wrap items-center gap-1 text-xs leading-snug text-slate-700">
                              <span className="font-semibold">Alasan:</span>
                              {d.reason && <Badge tone="red">{d.reason}</Badge>}
                              <span>{d.note || (d.reason ? '' : 'Tidak ada keterangan susut.')}</span>
                            </p>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>

              <footer className="space-y-2 border-t border-slate-200 bg-white px-3 py-2.5">
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>Total diterima</span>
                  <span className="font-bold tabular-nums text-slate-900">
                    {formatKgNum(stop.total_accepted_kg)} / {formatKgNum(stop.total_dispatched_kg)} kg
                  </span>
                </div>

                {canEdit && !stop.done && (
                  <div className="grid grid-cols-1 gap-2">
                    <button type="button" onClick={() => acceptAll(stop)} className="btn-primary min-h-[48px] w-full">
                      ✓ Terima 100% Semua Barang
                    </button>
                    <button type="button" onClick={() => saveStop(stop)} className="btn-secondary min-h-[44px] w-full">
                      Simpan Timbangan Dapur
                    </button>
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
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => saveStop(stop)}
                        className="col-span-2 min-h-[40px] rounded-lg text-xs font-semibold text-slate-600 underline-offset-2 hover:underline"
                      >
                        Simpan Koreksi Timbangan
                      </button>
                    )}
                  </div>
                )}
              </footer>
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
