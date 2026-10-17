'use client';

import React, { useState } from 'react';
import {
  type ItemMasterInput,
  type KitchenMasterInput,
  type MasterSaveResult,
  type SupplierMasterInput,
  useMbgStore,
} from '../lib/mbg-store';
import { BottomSheet, SegmentedControl, Toast, type ToastState } from './ui';

type MasterTab = 'kitchens' | 'suppliers' | 'items';

type FieldDef<T> = {
  key: keyof T & string;
  label: string;
  placeholder?: string;
  required?: boolean;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
};

const KITCHEN_FIELDS: FieldDef<KitchenMasterInput>[] = [
  { key: 'name', label: 'Nama Dapur / SPPG', placeholder: 'mis. SPPG Bekasi Utara 01', required: true },
  { key: 'pic_name', label: 'Nama PIC', required: true },
  { key: 'pic_phone', label: 'No. WA PIC', placeholder: '0812-xxxx-xxxx', required: true, inputMode: 'tel' },
  { key: 'address', label: 'Alamat' },
];

const SUPPLIER_FIELDS: FieldDef<SupplierMasterInput>[] = [
  { key: 'name', label: 'Nama Supplier', required: true },
  { key: 'contact_person', label: 'Kontak (Nama)' },
  { key: 'phone', label: 'No. HP / WA', inputMode: 'tel' },
  { key: 'bank_name', label: 'Bank' },
  { key: 'bank_account_number', label: 'No. Rekening', inputMode: 'numeric' },
  { key: 'bank_account_holder', label: 'Atas Nama Rekening' },
];

const ITEM_FIELDS: FieldDef<ItemMasterInput>[] = [
  { key: 'name', label: 'Nama Bahan Baku', required: true },
  { key: 'category', label: 'Kategori', placeholder: 'mis. Protein Hewani' },
];

const EMPTY_KITCHEN: KitchenMasterInput = { name: '', address: '', pic_name: '', pic_phone: '' };
const EMPTY_SUPPLIER: SupplierMasterInput = {
  name: '',
  contact_person: '',
  phone: '',
  bank_name: '',
  bank_account_number: '',
  bank_account_holder: '',
};
const EMPTY_ITEM: ItemMasterInput = { name: '', category: '' };

function MasterForm<T extends { id?: string }>({
  idPrefix,
  fields,
  initial,
  onSave,
  onCancel,
  extra,
}: {
  idPrefix: string;
  fields: FieldDef<T>[];
  initial: T;
  onSave: (value: T) => MasterSaveResult;
  onCancel: () => void;
  extra?: React.ReactNode;
}) {
  const [value, setValue] = useState<T>(initial);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const res = onSave(value);
    if (!res.ok) setError(res.error);
  };

  return (
    <form onSubmit={submit} className="space-y-2.5 rounded-lg bg-slate-50 p-3 ring-1 ring-inset ring-slate-200">
      {fields.map((f) => {
        const id = `${idPrefix}-${f.key}`;
        const raw = value[f.key];
        return (
          <div key={f.key}>
            <label htmlFor={id} className="mb-1 block text-xs font-semibold text-slate-700">
              {f.label}
              {f.required && <span className="text-rose-600"> *</span>}
            </label>
            <input
              id={id}
              type="text"
              inputMode={f.inputMode}
              placeholder={f.placeholder}
              value={typeof raw === 'string' ? raw : ''}
              onChange={(e) => setValue((p) => ({ ...p, [f.key]: e.target.value }))}
              className="field-input"
            />
          </div>
        );
      })}
      {extra}
      {error && (
        <p role="alert" className="text-sm font-medium text-rose-700">
          {error}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={onCancel} className="btn-secondary min-h-[44px]">
          Batal
        </button>
        <button type="submit" className="btn-primary min-h-[44px]">
          Simpan
        </button>
      </div>
    </form>
  );
}

export function MasterDataSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { activeRole, kitchens, suppliers, items, saveKitchen, saveSupplier, saveItem } =
    useMbgStore();
  const [tab, setTab] = useState<MasterTab>('kitchens');
  // `null` = no form open, `'new'` = create form, otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);

  // Master data is Admin-only (Invariant 5).
  if (activeRole !== 'OWNER_ADMIN') return null;

  const switchTab = (t: MasterTab) => {
    setTab(t);
    setEditing(null);
  };

  const done = (res: MasterSaveResult, text: string): MasterSaveResult => {
    if (res.ok) {
      setEditing(null);
      setToast({ kind: 'ok', text });
    }
    return res;
  };

  const addLabel: Record<MasterTab, string> = {
    kitchens: '+ Tambah Dapur',
    suppliers: '+ Tambah Supplier',
    items: '+ Tambah Bahan Baku',
  };

  const rowBtn =
    'min-h-[36px] shrink-0 rounded-md border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-100';

  return (
    <BottomSheet
      open={open}
      title="⚙️ Data Master"
      onClose={() => {
        setEditing(null);
        onClose();
      }}
    >
      <div className="space-y-3">
        <SegmentedControl<MasterTab>
          label="Jenis data master"
          value={tab}
          onChange={switchTab}
          options={[
            { value: 'kitchens', label: `Dapur (${kitchens.length})` },
            { value: 'suppliers', label: `Supplier (${suppliers.length})` },
            { value: 'items', label: `Barang (${items.length})` },
          ]}
        />

        <Toast toast={toast} onClose={() => setToast(null)} />

        {editing === 'new' ? (
          tab === 'kitchens' ? (
            <MasterForm<KitchenMasterInput>
              idPrefix="md-k-new"
              fields={KITCHEN_FIELDS}
              initial={EMPTY_KITCHEN}
              onCancel={() => setEditing(null)}
              onSave={(v) => done(saveKitchen(v), `Dapur "${v.name.trim()}" ditambahkan.`)}
            />
          ) : tab === 'suppliers' ? (
            <MasterForm<SupplierMasterInput>
              idPrefix="md-s-new"
              fields={SUPPLIER_FIELDS}
              initial={EMPTY_SUPPLIER}
              onCancel={() => setEditing(null)}
              onSave={(v) => done(saveSupplier(v), `Supplier "${v.name.trim()}" ditambahkan.`)}
            />
          ) : (
            <MasterForm<ItemMasterInput>
              idPrefix="md-i-new"
              fields={ITEM_FIELDS}
              initial={EMPTY_ITEM}
              onCancel={() => setEditing(null)}
              onSave={(v) => done(saveItem(v), `Bahan baku "${v.name.trim()}" ditambahkan.`)}
              extra={<UnitLockedField id="md-i-new-unit" />}
            />
          )
        ) : (
          <button type="button" onClick={() => setEditing('new')} className="btn-primary w-full">
            {addLabel[tab]}
          </button>
        )}

        <ul className="divide-y divide-slate-100 rounded-lg ring-1 ring-inset ring-slate-200">
          {tab === 'kitchens' &&
            kitchens.map((k) =>
              editing === k.id ? (
                <li key={k.id} className="p-2">
                  <MasterForm<KitchenMasterInput>
                    idPrefix={`md-k-${k.id}`}
                    fields={KITCHEN_FIELDS}
                    initial={{
                      id: k.id,
                      name: k.name,
                      address: k.address,
                      pic_name: k.pic_name,
                      pic_phone: k.pic_phone,
                    }}
                    onCancel={() => setEditing(null)}
                    onSave={(v) => done(saveKitchen(v), `Dapur ${k.kitchen_code} diperbarui.`)}
                  />
                </li>
              ) : (
                <li key={k.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <div className="break-words text-sm font-semibold leading-snug text-slate-900">
                      {k.name}
                    </div>
                    <div className="break-words text-xs text-slate-500">
                      {k.kitchen_code} • PIC {k.pic_name} • {k.pic_phone}
                    </div>
                  </div>
                  <button type="button" onClick={() => setEditing(k.id)} className={rowBtn}>
                    Ubah
                  </button>
                </li>
              )
            )}

          {tab === 'suppliers' &&
            suppliers.map((s) =>
              editing === s.id ? (
                <li key={s.id} className="p-2">
                  <MasterForm<SupplierMasterInput>
                    idPrefix={`md-s-${s.id}`}
                    fields={SUPPLIER_FIELDS}
                    initial={{
                      id: s.id,
                      name: s.name,
                      contact_person: s.contact_person ?? '',
                      phone: s.phone ?? '',
                      bank_name: s.bank_name ?? '',
                      bank_account_number: s.bank_account_number ?? '',
                      bank_account_holder: s.bank_account_holder ?? '',
                    }}
                    onCancel={() => setEditing(null)}
                    onSave={(v) => done(saveSupplier(v), `Supplier ${s.supplier_code} diperbarui.`)}
                  />
                </li>
              ) : (
                <li key={s.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <div className="break-words text-sm font-semibold leading-snug text-slate-900">
                      {s.name}
                    </div>
                    <div className="break-words text-xs text-slate-500">
                      {s.supplier_code}
                      {s.phone ? ` • ${s.phone}` : ''}
                    </div>
                    {(s.bank_name || s.bank_account_number) && (
                      <div className="break-words text-xs text-slate-500">
                        {[s.bank_name, s.bank_account_number, s.bank_account_holder]
                          .filter(Boolean)
                          .join(' • ')}
                      </div>
                    )}
                  </div>
                  <button type="button" onClick={() => setEditing(s.id)} className={rowBtn}>
                    Ubah
                  </button>
                </li>
              )
            )}

          {tab === 'items' &&
            items.map((it) =>
              editing === it.id ? (
                <li key={it.id} className="p-2">
                  <MasterForm<ItemMasterInput>
                    idPrefix={`md-i-${it.id}`}
                    fields={ITEM_FIELDS}
                    initial={{ id: it.id, name: it.name, category: it.category }}
                    onCancel={() => setEditing(null)}
                    onSave={(v) => done(saveItem(v), `Bahan baku ${it.sku} diperbarui.`)}
                    extra={<UnitLockedField id={`md-i-${it.id}-unit`} />}
                  />
                </li>
              ) : (
                <li key={it.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <div className="break-words text-sm font-semibold leading-snug text-slate-900">
                      {it.name}
                    </div>
                    <div className="break-words text-xs text-slate-500">
                      {it.category} • satuan {it.base_unit}
                    </div>
                  </div>
                  <button type="button" onClick={() => setEditing(it.id)} className={rowBtn}>
                    Ubah
                  </button>
                </li>
              )
            )}
        </ul>
      </div>
    </BottomSheet>
  );
}

/** Unit is fixed to kg for every commodity (Invariant 1) — shown, never editable. */
function UnitLockedField({ id }: { id: string }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-semibold text-slate-700">
        Satuan
      </label>
      <input id={id} type="text" value="kg (terkunci)" readOnly disabled className="field-input bg-slate-100 text-slate-600" />
    </div>
  );
}
