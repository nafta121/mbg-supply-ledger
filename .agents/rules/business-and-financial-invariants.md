---
trigger: always_on
description: >-
  Aturan bisnis, akuntansi, dan keamanan data mutlak (5 Business & Financial Invariants)
  untuk aplikasi B2B Kitchen Order, Invoicing, dan Profit-Sharing Ledger Dapur MBG (Stage 8 Order-Driven).
---

# Business and Financial Invariants (Aturan Mutlak)

Aturan di dalam dokumen ini bersifat **MUTLAK (NON-NEGOTIABLE)** dan **TIDAK BOLEH DILANGGAR** di bagian kode mana pun—baik pada skema database SQL, fungsi backend/RPC, model data TypeScript, maupun komponen UI.

> **Stage 8 — Order-Driven Workflow (Fase 1):** Order Dapur → Timbang BAST Kurir → Invoice Dapur Gabungan → Bagi Hasil (Tim & Koperasi).
> Stok batch supplier, HPP per batch, matriks alokasi, dan settlement/bayar supplier **tidak ada** pada fase ini. Jangan menambahkan kembali pencatatan hutang/pembayaran supplier tanpa keputusan bisnis baru.

---

## Invariant 1: Presisi Angka & Satuan (`NUMERIC` & Kilogram Bulat)

1. **Larangan Floating-Point Biner:**
   - **DILARANG KERAS** menggunakan tipe data `FLOAT`, `FLOAT4`, `FLOAT8`, `REAL`, atau `DOUBLE PRECISION` di PostgreSQL untuk menyimpan nominal uang, harga per kg, margin, persentase bagi hasil, maupun kuantitas berat.
   - Di lapisan aplikasi (TypeScript), hindari aritmatika `number` langsung untuk kalkulasi buku besar/keuangan; gunakan helper fixed-point di `financial-engine.ts` (gram & sen `BigInt`) atau `sumIdr` / `sumKg`.
2. **Standar Tipe Data Database:**
   - **Mata Uang (IDR):** `NUMERIC(15,2)` — `kitchen_unit_price_snapshot`, `margin_per_kg_snapshot`, `line_invoice_amount`, `line_margin_amount`, `total_invoice_amount`, `profit_amount`.
   - **Kuantitas Berat (`kg`):** Kilogram **bulat** (`35 kg`, `25 kg`, `-2 kg`). Kolom tetap `NUMERIC(10,3)` dengan `CHECK (kolom = TRUNC(kolom))`.
   - Input berat di semua layar memakai `inputMode="numeric"`, `step="1"`, dan placeholder `"0"`; nilai yang masuk ke store/RPC dibulatkan ke kilogram bulat. Input rupiah memakai `inputMode="numeric"` dengan pemisah ribuan (`14.000`).
3. **Larangan Tampilan Desimal Kilogram:**
   - **DILARANG** menampilkan `.000` atau desimal pada angka kilogram di UI, input, PDF, maupun pesan WhatsApp.
   - Benar: `35 kg`, `33 / 35 kg`, `-2 kg`. Salah: `35.000 kg`, `35,000 kg`, `33.500 kg`.
4. **Pembulatan Terstandar:** Seluruh `qty_kg × harga` dibulatkan `ROUND(val, 2)` (half-up) agar tidak pernah ada selisih Rp 0,01 antara invoice dan ledger bagi hasil.

---

## Invariant 2: Invoice Dapur Berbasis Bobot Terima (`qty_accepted_kg`)

1. **Satu Order = Satu Invoice Gabungan:** Setiap Order Dapur (multi-barang) menghasilkan tepat 1 kartu pengiriman kurir dan 1 Invoice Tagihan Dapur Gabungan (`kitchen_invoices.delivery_id` UNIQUE).
2. **Rumus Tagihan per Baris:**
   $$\text{line\_invoice\_amount} = \text{ROUND}(\text{qty\_accepted\_kg} \times \text{kitchen\_unit\_price\_snapshot}, 2)$$
   $$\text{total\_invoice\_amount} = \sum \text{line\_invoice\_amount}$$
3. **Selisih/Reject Tidak Ditagih:**
   $$\text{qty\_shrinkage\_kg} = \text{qty\_dispatched\_kg} - \text{qty\_accepted\_kg}$$
   - Contoh: order/kirim Wortel `35 kg`, diterima dapur `33 kg` → invoice menagih `33 kg` saja; UI menampilkan `Selisih/Reject -2 kg (Hanya ditagih 33 kg ke Dapur)`.
   - `qty_accepted_kg` tidak boleh negatif dan tidak boleh melebihi `qty_dispatched_kg`.
4. **Tagihan Final:** Sebelum semua barang ditimbang, invoice berupa estimasi (bobot order). Invoice **hanya boleh** ditandai `PAID` setelah seluruh baris order memiliki `weighed_at`.

---

## Invariant 3: Snapshot Harga Dapur & Margin (Immutable)

1. Saat baris order dibuat, sistem **WAJIB** menyalin dan mengunci:
   - `kitchen_unit_price_snapshot` — Harga Dapur / kg (harga jual ke dapur, sudah termasuk markup), `> 0`.
   - `margin_per_kg_snapshot` — Margin / Bagian Kita per kg, `0 ≤ margin ≤ harga dapur`.
2. Harga default di master barang hanya untuk auto-isi form; perubahan master **TIDAK BOLEH** mengubah histori order, invoice, maupun bagi hasil.
3. Order yang invoicenya sudah `PAID` terkunci: baris tidak boleh ditambah/dihapus/ditimbang ulang dan order tidak boleh dihapus.

---

## Invariant 4: Cash-Basis Profit Sharing (`LOCKED_UNPAID` → `AVAILABLE_FOR_PAYOUT`)

1. **Rumus Bagi Hasil per Baris:**
   $$\text{Total Bagi Hasil} = \text{ROUND}(\text{qty\_accepted\_kg} \times \text{margin\_per\_kg\_snapshot}, 2)$$
   $$\text{Hak Koperasi} = \text{ROUND}(\text{Total} \times \text{share\_coop\_pct} / 100, 2), \quad \text{Hak Tim} = \text{Total} - \text{Hak Koperasi}$$
2. **Prinsip Kas Masuk (*Strict Cash Basis*):**
   - Selama Invoice Dapur `ISSUED` / `UNPAID` / `PARTIALLY_PAID`, ledger berstatus **`LOCKED_UNPAID`** (label UI: **Menunggu Dapur Bayar**) dan **DILARANG** dicairkan.
   - Ledger berubah menjadi **`AVAILABLE_FOR_PAYOUT`** (label UI: **Siap Dicairkan**) **HANYA SETELAH** Invoice Dapur terkait berstatus **`PAID`** (Lunas), secara atomik.
   - Apabila status `PAID` dikoreksi (selama belum `PAID_OUT`), ledger wajib kembali `LOCKED_UNPAID`.
   - Baris `PAID_OUT` tidak pernah dihitung ulang; bila salah satu porsi (Tim/Koperasi) sebuah baris sudah `PAID_OUT`, kedua porsi baris tersebut dibekukan sehingga Tim + Koperasi selalu = total margin baris.

---

## Invariant 5: Strict Role-Based Access Control (Proteksi Harga)

1. **Role `FIELD_TEAM` (Lapangan / Kurir):**
   - **Diizinkan:** Melihat daftar dapur, nama PIC, daftar barang & kilogram bulat (`Wortel 35 kg`), total muatan per jenis barang, mencetak/WA Surat Jalan/BAST (tanpa harga), dan menginput bobot diterima + alasan selisih.
   - **DILARANG KERAS:** Melihat atau meng-query `kitchen_unit_price_snapshot`, `margin_per_kg_snapshot`, nominal invoice, maupun laporan bagi hasil. Query wajib melalui *Security-Barrier View* `v_safe_delivery_items_bast` / proyeksi `buildSafeCourierItems` yang tidak menyertakan kolom harga.
   - Saat role ini aktif, aplikasi langsung membuka tab **Timbang** dan menyembunyikan navigasi bawah.
2. **Role `COOPERATIVE_VIEWER` (Pihak Koperasi):**
   - **Diizinkan:** Melihat rekap timbang (read-only), status pembayaran Invoice Dapur (`Belum Bayar` / `Lunas`), serta rincian hak bagi hasil.
   - **Tidak Diizinkan:** Membuat/mengubah order, harga/margin, menandai lunas, atau mencairkan dana.
3. **Role `OWNER_ADMIN` / `FINANCE`:**
   - **Diizinkan:** Akses penuh — tab Order Dapur (harga & margin), master data dapur & barang, penerbitan & verifikasi pelunasan Invoice Dapur, serta eksekusi pencairan bagi hasil (`profit_payout_batches`).
