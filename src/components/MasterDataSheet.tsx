'use client';

import React, { useState } from 'react';
import { type ItemMasterInput, type KitchenMasterInput, type MasterSaveResult, useMbgStore } from '../lib/mbg-store';
import { formatRp, formatThousands } from '../lib/ui-format';
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
    <form onSubmit={submit} className="space-y-2.5 rounded-[6px] border border-[#e6e6e6] bg-[#f8f9fa] p-3">
      {fields.map((f) => {
        const id = `${idPrefix}-${f.key}`;
        const raw = value[f.key];
        return (
          <div key={f.key}>
            <label htmlFor={id} className="mb-1 block text-[12px] font-medium text-[#6b6b6b]">
              {f.label}
              {f.required && <span className="text-[#c4242a]"> *</span>}
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
        <p role="alert" className="text-[13px] font-medium text-[#c4242a]">
          {error}
        </p>
      )}
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
    setToast({ kind: 'ok', text: 'Identitas supplier & rekening invoice berhasil dikunci ke Supabase.' });
  };

  const addLabel: Record<MasterTab, string> = {
    kitchens: '+ Tambah Dapur',
    items: '+ Tambah Barang',
  };

  const rowBtn =
    'min-h-[34px] shrink-0 rounded-[6px] border border-[#d4d4d4] bg-white px-2.5 text-[12px] font-medium text-[#3d3d3d] hover:bg-[#f8f8f8]';
  const delBtn =
    'min-h-[34px] shrink-0 rounded-[6px] border border-[#f5c2c0] bg-white px-2.5 text-[12px] font-medium text-[#c4242a] hover:bg-[#ffedea]';

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

        {/* Identitas Supplier & Rekening Pembayaran Invoice Dapur */}
        <form
          onSubmit={submitBankAccount}
          className="space-y-2.5 rounded-[6px] border border-[#e6e6e6] bg-[#f8f9fa] p-3"
        >
          <div className="text-[13px] font-medium text-[#0a0a0a]">
            Identitas Supplier &amp; Rekening Pembayaran Invoice
          </div>
          <div>
            <label htmlFor="md-supplier-name" className="mb-1 block text-[12px] font-medium text-[#6b6b6b]">
              Nama Supplier / Perusahaan Kita <span className="text-[#c4242a]">*</span>
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
              <label htmlFor="md-bank-name" className="mb-1 block text-[12px] font-medium text-[#6b6b6b]">
                Nama Bank <span className="text-[#c4242a]">*</span>
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
              <label htmlFor="md-bank-number" className="mb-1 block text-[12px] font-medium text-[#6b6b6b]">
                Nomor Rekening <span className="text-[#c4242a]">*</span>
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
            <label htmlFor="md-bank-holder" className="mb-1 block text-[12px] font-medium text-[#6b6b6b]">
              Atas Nama Penerima <span className="text-[#c4242a]">*</span>
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
          {bankError && (
            <p role="alert" className="text-[12px] font-medium text-[#c4242a]">
              {bankError}
            </p>
          )}
          <button type="submit" className="btn-primary min-h-[38px] w-full text-[13px]">
            Simpan Identitas &amp; Rekening Invoice
          </button>
        </form>

        <SegmentedControl<MasterTab>
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

        <ul className="divide-y divide-[#f0f0f0] rounded-[6px] border border-[#e6e6e6] bg-white">
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
                    <div className="break-words text-[14px] font-medium leading-snug text-[#0a0a0a]">
                      {k.name}
                    </div>
                    <div className="break-words text-[12px] text-[#6b6b6b]">
                      <span className="font-mono">{k.kitchen_code}</span> · PIC {k.pic_name} · {k.pic_phone}
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
                        setToast(
                          res.ok
                            ? { kind: 'ok', text: `Dapur ${k.kitchen_code} dihapus dari Supabase.` }
                            : { kind: 'error', text: res.error }
                        );
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
                    <div className="break-words text-[14px] font-medium leading-snug text-[#0a0a0a]">
                      {it.name}
                    </div>
                    <div className="break-words text-[12px] text-[#6b6b6b] tabular-nums">
                      {it.category} · {formatRp(it.default_kitchen_price_per_kg)}/kg · margin{' '}
                      {formatRp(it.default_margin_per_kg)}/kg
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
                        setToast(
                          res.ok
                            ? { kind: 'ok', text: `Barang ${it.name} dihapus dari Supabase.` }
                            : { kind: 'error', text: res.error }
                        );
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
      <label htmlFor={id} className="mb-1 block text-[12px] font-medium text-[#6b6b6b]">
        Satuan
      </label>
      <input id={id} type="text" value="kg (terkunci)" readOnly disabled className="field-input bg-[#eeeeee] text-[#6b6b6b]" />
    </div>
  );
}
