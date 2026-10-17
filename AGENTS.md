# MBG B2B Supply Chain, Invoicing & Profit-Sharing Ledger — Single Source of Truth

Dokumen ini adalah panduan arsitektur utama (**Single Source of Truth**) bagi seluruh AI Agent dan engineer pada proyek **B2B Supply Chain, Invoicing, dan Profit-Sharing Ledger** untuk penyediaan bahan baku ke **20–30 Dapur Makan Bergizi Gratis (MBG / SPPG)**.

## 1. Ringkasan Proyek

Aplikasi mobile dan backend ini mengelola siklus harian pengadaan bahan baku dari berbagai **Supplier**, alokasi & distribusi ke **20–30 Dapur MBG**, penerbitan **Invoice Dapur**, pemotongan tagihan ke Supplier akibat penyusutan/barang rusak (**Shrinkage/Reject**), serta pembagian keuntungan (**Profit-Sharing Ledger**) antara **Tim** dan **Koperasi**.

- **Operasi Batch Harian:** Melayani 20–30 dapur setiap hari dalam satuan dasar **kilogram bulat** (`kg`, bilangan bulat tanpa desimal/koma — contoh: `50 kg`, `-3 kg`).
- **Batch-Traced Costing:** Harga modal menggunakan harga beli aktual per batch pengadaan supplier (`Actual Cost per Batch`), bukan harga rata-rata (*average cost*).
- **Zero-Shrinkage Risk bagi Tim & Koperasi:** Seluruh susut bobot atau reject saat BAST di dapur otomatis memotong kewajiban bayar ke Supplier asal batch.
- **Cash-Basis Profit Distribution:** Bagi hasil Tim dan Koperasi dihitung saat Invoice diterbitkan, namun dikunci (`LOCKED_UNPAID`) dan baru siap dicairkan (`AVAILABLE_FOR_PAYOUT`) setelah Invoice Dapur berstatus lunas (`PAID`).

## 2. Arsitektur Aplikasi & Tech Stack

- **Mobile & Tablet Client:** Next.js (App Router) + TypeScript (`strict: true`) + Tailwind CSS (Mobile-First PWA) dengan *Matrix Grid UI* untuk input cepat 20–30 dapur dan *Offline-First Queue* untuk input BAST timbangan di lapangan.
- **Backend & Database:** Supabase (PostgreSQL 15+) dengan **Row-Level Security (RLS)**, **Security-Barrier Views**, **PL/pgSQL ACID Triggers**, dan **Immutable Price Snapshots**.
- **Autentikasi & RBAC:** Supabase Auth dengan 4 role utama: `FIELD_TEAM`, `COOPERATIVE_VIEWER`, `FINANCE`, dan `OWNER_ADMIN`.
- **Dokumen Otomatis:** Generator PDF untuk Surat Jalan/BAST (tanpa harga), Nota Klaim Potongan Susut Supplier, dan Invoice Dapur MBG.

## 3. Lima Invariant Bisnis Utama (Wajib Dipatuhi)

Seluruh kode backend, query SQL, state management, dan UI wajib mematuhi 5 Invariant Bisnis Utama berikut (detail di `.agents/rules/business-and-financial-invariants.md`):

1. **Invariant 1 (Presisi Angka & Satuan — Kilogram Bulat):** Dilarang menggunakan `FLOAT` atau `DOUBLE` untuk uang dan berat. Wajib gunakan `NUMERIC(15,2)` untuk mata uang (IDR). Seluruh kuantitas berat bahan baku menggunakan satuan **Kilogram bulat (`INTEGER` / bilangan bulat tanpa desimal atau koma)**, misalnya `50 kg`, `75 kg`, `-3 kg` (kolom DB tetap bertipe eksak `NUMERIC(10,3)` dengan `CHECK` nilai bulat). Di Indonesia, penulisan `50.000 kg` terbaca sebagai "lima puluh ribu kg" — karena itu **DILARANG** menampilkan `.000` atau desimal pada angka kilogram di bagian mana pun (UI, Input, dokumen Print PDF, maupun pesan WhatsApp).
2. **Invariant 2 (Zero-Shrinkage Risk / Beban Susut di Supplier):** Segala bentuk penyusutan bobot (*shrinkage*) atau barang rusak/reject saat diterima oleh dapur adalah 100% tanggung jawab Supplier, BUKAN tanggung jawab Tim maupun Koperasi:
   - `Kitchen Invoice` = `qty_accepted_by_kitchen_kg × kitchen_unit_price_snapshot`
   - `Supplier Payable` = `qty_accepted_by_kitchen_kg × supplier_actual_cost_snapshot` (bukan berdasarkan bobot kirim awal). Selisih antara bobot kirim supplier dan total bobot diterima dapur otomatis dicatat sebagai `qty_supplier_claim_or_return_kg` (Potongan Tagihan/Nota Retur Supplier).
3. **Invariant 3 (Actual Supplier Batch Costing & Price Immutability):** Metode HPP/harga beli wajib menggunakan **harga beli aktual dari supplier (`Actual Cost per Batch`)**, bukan rata-rata (*average*). Setiap item pada Invoice Dapur wajib terhubung ke `supplier_batch_id` asal barang dan menyimpan snapshot harga (`supplier_actual_cost_snapshot` dan `kitchen_unit_price_snapshot`) saat transaksi dibuat agar perubahan harga di masa depan tidak mengubah histori invoice dan bagi hasil.
4. **Invariant 4 (Cash-Basis Profit Sharing):** Selisih markup (`Total Markup = qty_accepted_by_kitchen_kg × (kitchen_unit_price_snapshot - supplier_actual_cost_snapshot)`) dibagi antara **Tim** dan **Koperasi** berbasis kas masuk (**Cash Basis**):
   - Saat Invoice Dapur berstatus `ISSUED` / `UNPAID` / `PARTIALLY_PAID`, saldo bagi hasil Tim dan Koperasi berstatus `LOCKED_UNPAID` (belum bisa dicairkan).
   - Saldo bagi hasil otomatis berubah menjadi `AVAILABLE_FOR_PAYOUT` (siap dicairkan) HANYA SETELAH Invoice Dapur berstatus `PAID` (Lunas).
5. **Invariant 5 (Strict Role-Based Access Control / Proteksi Harga Modal):**
   - Role `FIELD_TEAM` (Tim Lapangan/Kurir/Gudang): Hanya bisa melihat kuantitas (`kg`), daftar dapur, surat jalan, dan input BAST timbangan terima dapur. DILARANG melihat `supplier_actual_cost`, nominal `markup`, maupun laporan bagi hasil.
   - Role `COOPERATIVE_VIEWER` (Pihak Koperasi): Bisa melihat rekap kuantitas diterima dapur, status pembayaran invoice dapur (`UNPAID` vs `PAID`), dan perhitungan hak bagi hasil Koperasi.
   - Role `OWNER_ADMIN` / `FINANCE`: Akses penuh ke seluruh harga supplier, pengaturan markup per dapur/item, verifikasi pelunasan invoice, dan eksekusi pencairan bagi hasil (`Payout Settlement`).

## 4. Referensi Dokumentasi Arsitektur (`docs/`)

- @[Alur Kerja Operasional, Rumus, & Simulasi Bagi Hasil](docs/01-domain-workflows-and-formulas.md)
- @[Skema Database PostgreSQL, Trigger Ledger, & RLS](docs/02-database-schema-and-rls.md)
- @[Spesifikasi Layar Mobile & UX Operasi Batch 20–30 Dapur](docs/03-mobile-ux-and-batch-screens.md)
