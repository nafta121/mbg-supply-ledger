# MBG B2B Kitchen Order, Invoicing & Profit-Sharing Ledger — Single Source of Truth

Dokumen ini adalah panduan arsitektur utama (**Single Source of Truth**) bagi seluruh AI Agent dan engineer pada proyek **B2B Kitchen Order, Invoicing, dan Profit-Sharing Ledger** untuk penyediaan bahan baku ke **20–30 Dapur Makan Bergizi Gratis (MBG / SPPG)**.

> [!IMPORTANT]
> **Stage 8 — Order-Driven Workflow (Fase 1).** Aplikasi berjalan **By Order dari Dapur**:
> **Order Dapur → Pengiriman & Timbang BAST Kurir → Invoice Tagihan ke Dapur → Bagi Hasil (Tim & Koperasi)**.
> Fitur **Stok Batch Supplier, HPP per batch, Matriks Alokasi, dan Settlement/Bayar Supplier DIHAPUS TOTAL** pada fase ini — tidak ada pencatatan hutang/pembayaran ke supplier.

## 1. Ringkasan Proyek

Aplikasi mobile dan backend ini mengelola siklus harian **Order Dapur** dari **20–30 Dapur MBG**, pengiriman & timbang terima (**BAST**) oleh kurir, penerbitan **Invoice Dapur Gabungan (multi-barang)**, serta pembagian keuntungan (**Profit-Sharing Ledger**) antara **Tim** dan **Koperasi**.

- **Order per Dapur (Multi-Barang):** Admin menginput 1 Order Dapur berisi banyak barang (contoh `DPR-01 • Dapur A`: `Wortel 35 kg`, `Kubis 25 kg`) lengkap dengan **`Harga Dapur / kg (Rp)`** (harga jual ke dapur, sudah termasuk markup) dan **`Margin / Bagian Kita per kg (Rp)`** (dasar bagi hasil). Harga & margin default diambil dari master barang dan tetap bisa diedit per order.
- **1 Order = 1 Kartu Kurir = 1 Invoice:** Setiap Order Dapur menghasilkan 1 kartu pengiriman multi-barang di layar kurir dan 1 Invoice Tagihan Dapur Gabungan. Order tambahan untuk dapur yang sama di hari yang sama (selama invoice belum lunas) digabung ke order & invoice tersebut.
- **Satuan Kilogram Bulat:** Semua berat dalam **kilogram bulat** (`kg`, bilangan bulat tanpa desimal/koma — contoh: `35 kg`, `-2 kg`).
- **Invoice Berbasis Bobot Terima:** Dapur hanya ditagih sebesar `qty_accepted_kg` hasil timbang BAST. Selisih/reject (misal kirim `35 kg`, diterima `33 kg`) tidak ditagihkan.
- **Cash-Basis Profit Distribution:** Bagi hasil = `qty_accepted_kg × margin_per_kg`, dikunci (`LOCKED_UNPAID` — "Menunggu Dapur Bayar") dan baru siap dicairkan (`AVAILABLE_FOR_PAYOUT` — "Siap Dicairkan") setelah Invoice Dapur berstatus lunas (`PAID`).

## 2. Arsitektur Aplikasi & Tech Stack

- **Mobile & Tablet Client:** Next.js (App Router) + TypeScript (`strict: true`) + Tailwind CSS (Mobile-First PWA) dengan 4 tab: **Order Dapur**, **Timbang**, **Invoice Dapur**, **Bagi Hasil**.
- **Logika Bisnis Murni:** `src/lib/financial-engine.ts` (aritmetika presisi gram/sen) dan `src/lib/order-engine.ts` (seluruh transisi state: buat order, timbang BAST, lunas, pencairan). `src/lib/mbg-store.ts` hanya membungkus engine dengan React state.
- **Backend & Database:** Supabase (PostgreSQL 15+) dengan **Row-Level Security (RLS)**, **Security-Barrier Views**, **PL/pgSQL ACID Triggers**, dan **Immutable Price Snapshots** (lihat `supabase/migrations/0004_order_driven_flow.sql`).
- **Autentikasi & RBAC:** Supabase Auth dengan 4 role utama: `FIELD_TEAM`, `COOPERATIVE_VIEWER`, `FINANCE`, dan `OWNER_ADMIN`.
- **Dokumen Otomatis:** Surat Jalan/BAST multi-barang (tanpa harga), Invoice Dapur Gabungan (PDF), dan teks WhatsApp tagihan/BAST.

## 3. Lima Invariant Bisnis Utama (Wajib Dipatuhi)

Seluruh kode backend, query SQL, state management, dan UI wajib mematuhi 5 Invariant Bisnis Utama berikut (detail di `.agents/rules/business-and-financial-invariants.md`):

1. **Invariant 1 (Presisi Angka & Satuan — Kilogram Bulat):** Dilarang menggunakan `FLOAT` atau `DOUBLE` untuk uang dan berat. Wajib gunakan `NUMERIC(15,2)` untuk mata uang (IDR). Seluruh kuantitas berat menggunakan satuan **Kilogram bulat** (`35 kg`, `25 kg`, `-2 kg`; kolom DB tetap `NUMERIC(10,3)` dengan `CHECK` nilai bulat). Di Indonesia, `35.000 kg` terbaca "tiga puluh lima ribu kg" — karena itu **DILARANG** menampilkan `.000` atau desimal pada angka kilogram di UI, input, PDF, maupun pesan WhatsApp.
2. **Invariant 2 (Tagihan Dapur Berbasis Bobot Terima):**
   - `Tagihan per baris Invoice Dapur` = `qty_accepted_kg × kitchen_unit_price_snapshot`.
   - Selisih `qty_dispatched_kg − qty_accepted_kg` (susut/reject) **tidak pernah ditagihkan** ke dapur dan ditampilkan sebagai `Selisih/Reject -2 kg (Hanya ditagih 33 kg ke Dapur)`.
   - Invoice baru boleh ditandai `PAID` setelah **semua barang** pada order tersebut ditimbang kurir (tagihan final).
3. **Invariant 3 (Snapshot Harga & Margin Immutable):** Setiap baris order menyimpan `kitchen_unit_price_snapshot` dan `margin_per_kg_snapshot` saat order dibuat (`0 ≤ margin ≤ harga dapur`, harga dapur `> 0`). Perubahan harga default di master barang **TIDAK BOLEH** mengubah histori order, invoice, maupun bagi hasil. Order yang invoicenya sudah `PAID` terkunci (tidak bisa diubah/dihapus/ditimbang ulang).
4. **Invariant 4 (Cash-Basis Profit Sharing):** `Total Bagi Hasil per baris = qty_accepted_kg × margin_per_kg_snapshot`, dibagi **Tim** dan **Koperasi** sesuai persentase (misal 60% : 40%; porsi Koperasi dibulatkan, porsi Tim = total − Koperasi sehingga tidak ada selisih Rp 0,01):
   - Saat Invoice Dapur `ISSUED` / `UNPAID` / `PARTIALLY_PAID`: ledger `LOCKED_UNPAID` (**Menunggu Dapur Bayar**).
   - Otomatis menjadi `AVAILABLE_FOR_PAYOUT` (**Siap Dicairkan**) HANYA SETELAH Invoice Dapur berstatus `PAID` (**Lunas**).
   - Baris yang sudah `PAID_OUT` tidak pernah dihitung ulang.
5. **Invariant 5 (Strict Role-Based Access Control / Proteksi Harga):**
   - Role `FIELD_TEAM` (**Lapangan/Kurir**): Hanya melihat daftar dapur, nama PIC, dan daftar barang beserta kilogram bulat (`Wortel 35 kg`, `Kubis 25 kg`), lalu menginput bobot terima BAST. **DILARANG** melihat harga dapur, margin, nominal invoice, maupun laporan bagi hasil. Saat role ini dipilih, aplikasi langsung membuka layar **Timbang** tanpa navigasi bawah.
   - Role `COOPERATIVE_VIEWER` (Pihak Koperasi): Melihat rekap timbang (read-only), status pembayaran Invoice Dapur, dan perhitungan hak bagi hasil Koperasi.
   - Role `OWNER_ADMIN` / `FINANCE`: Akses penuh — input Order Dapur (harga & margin), master data, verifikasi pelunasan invoice, dan eksekusi pencairan bagi hasil (`Payout Settlement`).

## 4. Referensi Dokumentasi Arsitektur (`docs/`)

- @[Alur Kerja Operasional, Rumus, & Simulasi Bagi Hasil](docs/01-domain-workflows-and-formulas.md)
- @[Skema Database PostgreSQL, Trigger Ledger, & RLS](docs/02-database-schema-and-rls.md)
- @[Spesifikasi Layar Mobile & UX Operasi 20–30 Dapur](docs/03-mobile-ux-and-batch-screens.md)
