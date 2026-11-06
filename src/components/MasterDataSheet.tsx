'use client';

import React, { useState } from 'react';
import { type ItemMasterInput, type KitchenMasterInput, type MasterSaveResult, useMbgStore } from '../lib/mbg-store';
import { formatRp, formatThousands } from '../lib/ui-format';
import { ChevronDownIcon } from './Icons';
import { BottomSheet, SegmentedControl, Toast, type ToastState } from './ui';

type MasterTab = 'kitchens' | 'items';

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

const ITEM_FIELDS: FieldDef<ItemMasterInput>[] = [
  { key: 'name', label: 'Nama Barang', required: true },
  { key: 'category', label: 'Kategori', placeholder: 'mis. Sayuran Segar' },
  { key: 'default_kitchen_price_per_kg', label: 'Harga Dapur Default / kg (Rp)', placeholder: '0', inputMode: 'numeric' },
  { key: 'default_margin_per_kg', label: 'Margin Kita Default / kg (Rp)', placeholder: '0', inputMode: 'numeric' },
];

const EMPTY_KITCHEN: KitchenMasterInput = { name: '', address: '', pic_name: '', pic_phone: '' };
const EMPTY_ITEM: ItemMasterInput = {
  name: '',
  category: '',
  default_kitchen_price_per_kg: '',
  default_margin_per_kg: '',
};

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
  onSave: (value: T) => Promise<MasterSaveResult>;
  onCancel: () => void;
  extra?: React.ReactNode;
}) {
  const [value, setValue] = useState<T>(initial);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await onSave(value);
    if (!res.ok) setError(res.error);
  };

  return (
    <form onSubmit={submit} className="space-y-2.5 rounded-[6px] border border-rule bg-paper-2 p-3">
      {fields.map((f) => {
        const id = `${idPrefix}-${f.key}`;
        const raw = value[f.key];
        return (
          <div key={f.key}>
            <label htmlFor={id} className="mb-1 block text-[12px] font-medium text-muted">
              {f.label}
              {f.required && <span className="text-error"> *</span>}
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
      <div className="min-h-[1lh]">
        {error && (
          <p role="alert" className="text-[13px] font-medium text-error">
            {error}
          </p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={onCancel} className="btn-secondary min-h-[40px]">
          Batal
        </button>
        <button type="submit" className="btn-primary min-h-[40px]">
          Simpan
        </button>
      </div>
    </form>
  );
}

export function MasterDataSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { activeRole, kitchens, items, splitConfig, saveKitchen, saveItem, savePaymentAccount, deleteKitchen, deleteItem } =
    useMbgStore();
  const [tab, setTab] = useState<MasterTab>('kitchens');
  const [editing, setEditing] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);

  const [supplierName, setSupplierName] = useState<string>(splitConfig.supplier_name ?? 'Supplier MBG');
  const [bankName, setBankName] = useState<string>(splitConfig.payment_bank_name ?? 'BRI');
  const [accountNumber, setAccountNumber] = useState<string>(
    splitConfig.payment_account_number ?? '0000-0000-0000-000'
  );
  const [accountHolder, setAccountHolder] = useState<string>(
    splitConfig.payment_account_holder ?? 'Bendahara Supplier MBG'
  );
  const [bankError, setBankError] = useState<string | null>(null);

  React.useEffect(() => {
    setSupplierName(splitConfig.supplier_name ?? 'Supplier MBG');
    setBankName(splitConfig.payment_bank_name ?? 'BRI');
    setAccountNumber(splitConfig.payment_account_number ?? '0000-0000-0000-000');
    setAccountHolder(splitConfig.payment_account_holder ?? 'Bendahara Supplier MBG');
  }, [
    open,
    splitConfig.supplier_name,
    splitConfig.payment_bank_name,
    splitConfig.payment_account_number,
    splitConfig.payment_account_holder,
  ]);

  if (activeRole !== 'OWNER_ADMIN') return null;

  const switchTab = (t: MasterTab) => {
    setTab(t);
    setEditing(null);
  };

  const done = async (resPromise: Promise<MasterSaveResult>, text: string): Promise<MasterSaveResult> => {
    const res = await resPromise;
    if (res.ok) {
      setEditing(null);
      setToast({ kind: 'ok', text });
    }
    return res;
  };

  const submitBankAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setBankError(null);
    if (!supplierName.trim()) {
      setBankError('Nama Supplier / Perusahaan wajib diisi.');
      return;
    }
    const res = await savePaymentAccount({
      supplier_name: supplierName,
      payment_bank_name: bankName,
      payment_account_number: accountNumber,
      payment_account_holder: accountHolder,
    });
    if (!res.ok) {
      setBankError(res.error);
      return;
    }
    setToast({ kind: 'ok', text: 'Identitas supplier & rekening pembayaran berhasil disimpan.' });
  };

  const addLabel: Record<MasterTab, string> = {
    kitchens: '+ Tambah Dapur',
    items: '+ Tambah Barang',
  };

  const rowBtn =
    'min-h-[34px] shrink-0 rounded-[6px] border border-control bg-white px-2.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-paper-2 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50';
  const delBtn =
    'min-h-[34px] shrink-0 rounded-[6px] border border-error-border bg-white px-2.5 text-[12px] font-medium text-error transition-colors hover:bg-error-bg active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <BottomSheet
      open={open}
      title="Pengaturan & Data Master"
      onClose={() => {
        setEditing(null);
        onClose();
      }}
    >
      <div className="space-y-3">
        <Toast toast={toast} onClose={() => setToast(null)} />

        {/* Identitas Supplier & Rekening Pembayaran Invoice Dapur (Collapsible) */}
        <details className="group overflow-hidden rounded-[6px] border border-rule bg-paper-2">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-paper-3">
            <span>Identitas Supplier &amp; Rekening Invoice</span>
            <span className="flex items-center gap-1.5 text-[11px] font-mono text-muted">
              <span className="max-w-[140px] truncate">{bankName} {accountNumber}</span>
              <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted transition-transform motion-reduce:transition-none group-open:rotate-180" />
            </span>
          </summary>
          <form
            onSubmit={submitBankAccount}
            className="space-y-2.5 border-t border-rule p-3"
          >
            <div>
              <label htmlFor="md-supplier-name" className="mb-1 block text-[12px] font-medium text-muted">
                Nama Supplier / Perusahaan Kita <span className="text-error">*</span>
              </label>
              <input
                id="md-supplier-name"
                type="text"
                placeholder="Contoh: CV Pangan Nusantara / Supplier MBG"
                value={supplierName}
                onChange={(e) => setSupplierName(e.target.value)}
                className="field-input"
              />
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label htmlFor="md-bank-name" className="mb-1 block text-[12px] font-medium text-muted">
                  Nama Bank <span className="text-error">*</span>
                </label>
                <input
                  id="md-bank-name"
                  type="text"
                  placeholder="Contoh: BRI / BCA / Mandiri"
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  className="field-input"
                />
              </div>
              <div>
                <label htmlFor="md-bank-number" className="mb-1 block text-[12px] font-medium text-muted">
                  Nomor Rekening <span className="text-error">*</span>
                </label>
                <input
                  id="md-bank-number"
                  type="text"
                  placeholder="Contoh: 0000-0000-0000-000"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  className="field-input font-mono"
                />
              </div>
            </div>
            <div>
              <label htmlFor="md-bank-holder" className="mb-1 block text-[12px] font-medium text-muted">
                Atas Nama Penerima <span className="text-error">*</span>
              </label>
              <input
                id="md-bank-holder"
                type="text"
                placeholder="Contoh: Bendahara Supplier MBG"
                value={accountHolder}
                onChange={(e) => setAccountHolder(e.target.value)}
                className="field-input"
              />
            </div>
            <div className="min-h-[1lh]">
              {bankError && (
                <p role="alert" className="text-[12px] font-medium text-error">
                  {bankError}
                </p>
              )}
            </div>
            <button type="submit" className="btn-secondary min-h-[38px] w-full text-[13px]">
              Simpan Rekening Invoice
            </button>
          </form>
        </details>

        <SegmentedControl
          label="Jenis data master"
          value={tab}
          onChange={switchTab}
          options={[
            { value: 'kitchens', label: `Dapur (${kitchens.length})` },
            { value: 'items', label: `Barang (${items.length})` },
          ]}
        />

        {editing === 'new' ? (
          tab === 'kitchens' ? (
            <MasterForm<KitchenMasterInput>
              idPrefix="md-k-new"
              fields={KITCHEN_FIELDS}
              initial={EMPTY_KITCHEN}
              onCancel={() => setEditing(null)}
              onSave={(v) => done(saveKitchen(v), `Dapur "${v.name.trim()}" disimpan ke Supabase.`)}
            />
          ) : (
            <MasterForm<ItemMasterInput>
              idPrefix="md-i-new"
              fields={ITEM_FIELDS}
              initial={EMPTY_ITEM}
              onCancel={() => setEditing(null)}
              onSave={(v) => done(saveItem(v), `Barang "${v.name.trim()}" disimpan ke Supabase.`)}
              extra={<UnitLockedField id="md-i-new-unit" />}
            />
          )
        ) : (
          <button type="button" onClick={() => setEditing('new')} className="btn-primary w-full">
            {addLabel[tab]}
          </button>
        )}

        <ul className="divide-y divide-rule-2 rounded-[6px] border border-rule bg-white">
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
                    onSave={(v) => done(saveKitchen(v), `Dapur ${k.kitchen_code} diperbarui di Supabase.`)}
                  />
                </li>
              ) : (
                <li key={k.id} className="flex items-center justify-between gap-2 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="break-words text-[14px] font-medium leading-snug text-ink">
                      {k.name}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 break-words text-[12px] text-muted">
                      <span className="font-mono">{k.kitchen_code}</span>
                      <span>PIC {k.pic_name}</span>
                      <span className="tabular-nums">{k.pic_phone}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button type="button" onClick={() => setEditing(k.id)} className={rowBtn}>
                      Ubah
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        if (typeof window !== 'undefined' && !window.confirm(`Hapus dapur ${k.name}?`)) return;
                        const res = await deleteKitchen(k.id);
                        if (!res.ok) {
                          setToast({ kind: 'error', text: res.error });
                        }
                      }}
                      className={delBtn}
                    >
                      Hapus
                    </button>
                  </div>
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
                    initial={{
                      id: it.id,
                      name: it.name,
                      category: it.category,
                      default_kitchen_price_per_kg: formatThousands(it.default_kitchen_price_per_kg),
                      default_margin_per_kg: formatThousands(it.default_margin_per_kg),
                    }}
                    onCancel={() => setEditing(null)}
                    onSave={(v) => done(saveItem(v), `Barang ${it.name} diperbarui di Supabase.`)}
                    extra={<UnitLockedField id={`md-i-${it.id}-unit`} />}
                  />
                </li>
              ) : (
                <li key={it.id} className="flex items-center justify-between gap-2 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="break-words text-[14px] font-medium leading-snug text-ink">
                      {it.name}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 break-words text-[12px] text-muted tabular-nums">
                      <span>{it.category}</span>
                      <span>{formatRp(it.default_kitchen_price_per_kg)}/kg</span>
                      <span>margin {formatRp(it.default_margin_per_kg)}/kg</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button type="button" onClick={() => setEditing(it.id)} className={rowBtn}>
                      Ubah
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        if (typeof window !== 'undefined' && !window.confirm(`Hapus barang ${it.name}?`)) return;
                        const res = await deleteItem(it.id);
                        if (!res.ok) {
                          setToast({ kind: 'error', text: res.error });
                        }
                      }}
                      className={delBtn}
                    >
                      Hapus
                    </button>
                  </div>
                </li>
              )
            )}
        </ul>
      </div>
    </BottomSheet>
  );
}

function UnitLockedField({ id }: { id: string }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[12px] font-medium text-muted">
        Satuan
      </label>
      <input id={id} type="text" value="kg (terkunci)" readOnly disabled className="field-input bg-paper-3 text-muted" />
    </div>
  );
}
