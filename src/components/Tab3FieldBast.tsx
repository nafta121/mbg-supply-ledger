'use client';

import React, { useMemo, useState } from 'react';
import { gramsToKg, kgToGrams } from '../lib/financial-engine';
import { useMbgStore } from '../lib/mbg-store';
import { formatKgNum, shortKitchenName } from '../lib/ui-format';
import { Badge, Card, SegmentedControl, Toast, type ToastState } from './ui';

type Filter = 'pending' | 'done';

export function Tab3FieldBast() {
  const {
    activeRole,
    deliveries,
    getSafeBastItemsForFieldTeam,
    updateBastAcceptance,
    acceptFullBast,
  } = useMbgStore();

  // Field team only ever reads the price-free security-barrier projection (Invariant 5).
  const safeItems = getSafeBastItemsForFieldTeam();
  const canEdit = activeRole !== 'COOPERATIVE_VIEWER';

  const [filter, setFilter] = useState<Filter>(canEdit ? 'pending' : 'done');
  const [query, setQuery] = useState('');
  const [draftWeights, setDraftWeights] = useState<Record<string, string>>({});
  const [draftNotes, setDraftNotes] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<ToastState>(null);

  const statusByDelivery = useMemo(
    () => new Map(deliveries.map((d) => [d.id, d.status])),
    [deliveries]
  );
  const isDone = (deliveryId: string) => {
    const s = statusByDelivery.get(deliveryId);
    return s === 'BAST_VERIFIED' || s === 'INVOICED';
  };

  const pendingCount = safeItems.filter((i) => !isDone(i.delivery_id)).length;
  const doneCount = safeItems.length - pendingCount;

  const q = query.trim().toLowerCase();
  const visible = safeItems.filter((i) => {
    if ((filter === 'done') !== isDone(i.delivery_id)) return false;
    if (!q) return true;
    return i.kitchen_name.toLowerCase().includes(q) || i.item_name.toLowerCase().includes(q);
  });

  const handleSave = (id: string, dispatchedKg: number, currentAcceptedKg: number, name: string) => {
    if (!canEdit) return;
    const raw = draftWeights[id] ?? formatKgNum(currentAcceptedKg);
    const val = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(val) || val < 0) {
      setToast({ kind: 'error', text: 'Isi berat diterima dengan benar.' });
      return;
    }
    const acceptedGrams = kgToGrams(val);
    const dispatchedGrams = kgToGrams(dispatchedKg);
    if (acceptedGrams > dispatchedGrams) {
      setToast({ kind: 'error', text: 'Berat diterima tidak boleh melebihi berat kirim.' });
      return;
    }
    const shrinkGrams = dispatchedGrams - acceptedGrams;
    updateBastAcceptance({
      delivery_item_id: id,
      qty_accepted_kg: gramsToKg(acceptedGrams),
      rejection_reason: shrinkGrams > 0n ? draftNotes[id]?.trim() || null : null,
    });
    setToast({
      kind: 'ok',
      text:
        shrinkGrams > 0n
          ? `${name}: diterima ${formatKgNum(gramsToKg(acceptedGrams))} kg, susut ${formatKgNum(gramsToKg(shrinkGrams))} kg.`
          : `${name}: diterima utuh ${formatKgNum(gramsToKg(acceptedGrams))} kg.`,
    });
  };

  return (
    <section aria-label="Timbang BAST" className="space-y-3">
      <SegmentedControl<Filter>
        label="Filter timbang"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'pending', label: `Belum Timbang (${pendingCount})` },
          { value: 'done', label: `Selesai (${doneCount})` },
        ]}
      />

      <div>
        <label htmlFor="bast-search" className="sr-only">
          Cari dapur
        </label>
        <input
          id="bast-search"
          type="search"
          placeholder="Cari nama dapur…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="field-input"
        />
      </div>

      <Toast toast={toast} onClose={() => setToast(null)} />

      {visible.length === 0 && (
        <Card className="p-6 text-center text-sm font-medium text-slate-600">
          {filter === 'pending' ? 'Semua pengiriman sudah ditimbang.' : 'Belum ada yang selesai.'}
        </Card>
      )}

      <div className="space-y-2">
        {visible.map((it) => {
          const id = it.delivery_item_id;
          const name = shortKitchenName(it.kitchen_name);
          const done = isDone(it.delivery_id);
          const inputStr = draftWeights[id] ?? formatKgNum(it.qty_accepted_kg);
          const parsed = Number(inputStr);
          const liveAcceptedGrams =
            inputStr.trim() !== '' && Number.isFinite(parsed) && parsed >= 0
              ? kgToGrams(parsed)
              : kgToGrams(it.qty_accepted_kg);
          const dispatchedGrams = kgToGrams(it.qty_dispatched_kg);
          const shrinkGrams = dispatchedGrams - liveAcceptedGrams;
          const overGrams = shrinkGrams < 0n;
          const weightId = `bast-w-${id}`;
          const noteId = `bast-n-${id}`;

          return (
            <Card as="article" key={id} className="space-y-2.5 p-3">
              {/* Row 1: kitchen + item + status */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-bold text-slate-900">{name}</h3>
                  <p className="truncate text-xs text-slate-600">{it.item_name}</p>
                </div>
                <Badge tone={done ? 'green' : 'amber'}>{done ? 'Selesai' : 'Belum Timbang'}</Badge>
              </div>

              {/* Row 2: dispatched vs accepted */}
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-slate-100 px-3 py-2">
                  <div className="text-xs font-medium text-slate-600">Kirim</div>
                  <div className="text-lg font-bold tabular-nums text-slate-900">
                    {formatKgNum(it.qty_dispatched_kg)} <span className="text-sm font-semibold">kg</span>
                  </div>
                </div>
                {canEdit ? (
                  <div>
                    <label htmlFor={weightId} className="block text-xs font-medium text-slate-600">
                      Diterima (kg)
                    </label>
                    <input
                      id={weightId}
                      type="number"
                      inputMode="decimal"
                      step="0.001"
                      min="0"
                      max={it.qty_dispatched_kg}
                      value={inputStr}
                      onChange={(e) => setDraftWeights((p) => ({ ...p, [id]: e.target.value }))}
                      className={`mt-0.5 h-11 w-full rounded-lg border-2 px-3 text-right text-lg font-bold tabular-nums text-slate-900 focus:border-emerald-600 ${
                        overGrams ? 'border-rose-500' : 'border-slate-300'
                      }`}
                    />
                  </div>
                ) : (
                  // Koperasi: read-only static value — must not look like an editable form.
                  <div className="rounded-lg bg-slate-100 px-3 py-2">
                    <div className="text-xs font-medium text-slate-600">Diterima</div>
                    <div className="text-lg font-bold tabular-nums text-slate-900">
                      {formatKgNum(it.qty_accepted_kg)} <span className="text-sm font-semibold">kg</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Shrinkage line */}
              {shrinkGrams > 0n && (
                <div className="space-y-1.5">
                  <div className="rounded-md bg-rose-50 px-2.5 py-1.5 text-xs font-bold text-rose-700 ring-1 ring-inset ring-rose-200 tabular-nums">
                    Susut -{formatKgNum(gramsToKg(shrinkGrams))} kg (Potong Tagihan Supplier)
                  </div>
                  {canEdit ? (
                    <>
                      <label htmlFor={noteId} className="sr-only">
                        Catatan susut {name}
                      </label>
                      <input
                        id={noteId}
                        type="text"
                        placeholder="Catatan singkat (mis. memar, susut air)"
                        value={draftNotes[id] ?? it.rejection_reason ?? ''}
                        onChange={(e) => setDraftNotes((p) => ({ ...p, [id]: e.target.value }))}
                        className="field-input min-h-[40px]"
                      />
                    </>
                  ) : (
                    <p className="text-xs leading-snug text-slate-700">
                      <span className="font-semibold">Catatan:</span>{' '}
                      {it.rejection_reason || 'Tidak ada keterangan susut.'}
                    </p>
                  )}
                </div>
              )}
              {canEdit && overGrams && (
                <p role="alert" className="text-xs font-semibold text-rose-700">
                  Melebihi berat kirim.
                </p>
              )}

              {/* Row 3: 1-tap actions */}
              {canEdit && (
                <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setDraftWeights((p) => ({ ...p, [id]: formatKgNum(it.qty_dispatched_kg) }));
                      acceptFullBast(id);
                      setToast({
                        kind: 'ok',
                        text: `${name}: diterima utuh ${formatKgNum(it.qty_dispatched_kg)} kg.`,
                      });
                    }}
                    className="btn-primary min-h-[48px] w-full"
                  >
                    ✓ Sesuai Kirim (100%)
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSave(id, it.qty_dispatched_kg, it.qty_accepted_kg, name)}
                    className="btn-secondary min-h-[48px] w-full"
                  >
                    Simpan
                  </button>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}
