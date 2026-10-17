# 03 — Spesifikasi Layar Mobile & UX Operasi Batch (20–30 Dapur MBG)

> [!IMPORTANT]
> **Stage 8 — Order-Driven Flow (Fase 1).** Layar matriks alokasi batch, setup batch supplier, dan settlement supplier di dokumen ini **sudah tidak berlaku**. Aplikasi kini memiliki 4 tab:
> 1. **Order Dapur** (Admin/Keuangan) — form multi-barang per dapur (berat kg bulat, Harga Dapur/kg, Margin Kita/kg) + daftar order hari ini (`Menunggu Kurir` / `Sebagian Tertimbang` / `Selesai BAST`).
> 2. **Timbang** (Kurir & Admin; Koperasi read-only) — total barang yang dibawa kurir, 1 kartu per dapur, `✓ Terima Sesuai Order (Semua Barang)`, `💾 Simpan Timbangan Dapur`, Surat Jalan/BAST & WA BAST tanpa harga. Role Lapangan langsung masuk layar ini tanpa navigasi bawah.
> 3. **Invoice Dapur** — rekap `Belum Dibayar Dapur` / `Sudah Lunas`, kartu invoice gabungan multi-barang, `✓ Tandai Lunas`, PDF, WA tagihan, Surat Jalan.
> 4. **Bagi Hasil** — `Siap Dicairkan` vs `Menunggu Dapur Bayar`, pencairan Hak Tim / Hak Koperasi, rincian per invoice.

Dokumen ini mendefinisikan rancangan antarmuka pengguna (*Mobile & Tablet UX Specifications*) berbasis **Next.js (App Router) + TypeScript (`strict: true`) + Tailwind CSS (Mobile-First PWA) + Supabase (PostgreSQL)** yang dioptimalkan untuk kecepatan operasional tinggi: mengelola **20–30 Dapur MBG** setiap hari tanpa perlu membuka-tutup ratusan form satu per satu.

---

## Peta Navigasi Berdasarkan Role (Invariant 5 RBAC)

| Layar / Modul Utama | `FIELD_TEAM` (Gudang/Kurir) | `COOPERATIVE_VIEWER` (Koperasi) | `FINANCE` & `OWNER_ADMIN` |
| :--- | :---: | :---: | :---: |
| **A. Matrix Order & Allocation Screen (Grid 20–30 Dapur)** | Hanya Kuantitas (`kg`) | Read-Only (`kg`) | Penuh (`kg` + Batch Cost + Markup) |
| **B. Supplier Batch & Pricing Setup Screen** | **HIDDEN / BLOCKED** | **HIDDEN / BLOCKED** | Akses Penuh |
| **C. Fast BAST & Shrinkage Input Screen (Lapangan)** | Input `qty_accepted_kg` + Foto | Read-Only (`kg`) | Akses Penuh / Koreksi |
| **D. Kitchen Invoicing & Supplier Settlement Screen** | **HIDDEN / BLOCKED** | Lihat Status `UNPAID`/`PAID` | Akses Penuh (Verifikasi `PAID`) |
| **E. Profit-Sharing Ledger & Payout Screen** | **HIDDEN / BLOCKED** | Lihat Porsi Koperasi | Akses Penuh (Eksekusi Payout) |

---

## Layar A: Matrix Order & Allocation Screen (Grid Cepat 20–30 Dapur)

### Tujuan Ergonomis
Menggantikan form input tradisional per dapur dengan **Sticky 2D Matrix Grid** (Baris = 20–30 Dapur MBG, Kolom = Item Bahan Baku & Alokasi Batch Supplier) sehingga admin/gudang dapat mengalokasikan puluhan dapur dalam hitungan menit.

### Tata Letak (Wireframe Konseptual)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ [Tanggal: 16 Okt 2026 ▼]   [Filter Komoditas: Ayam & Daging ▼]  [Simpan]  │
├────────────────────────────────────────────────────────────────────────────┤
│ Sisa Stok Batch Aktif:                                                     │
│ • [BATCH-SUP-A: 150.000 kg @ Rp36.000*]  • [BATCH-SUP-B: 100.000 kg*]      │
│   (*Harga Rp/kg disembunyikan otomatis jika login sebagai FIELD_TEAM)      │
├──────────────────┬────────────────────┬────────────────────┬───────────────┤
│ Dapur MBG (25)   │ Ayam Fillet (kg)   │ Daging Sapi (kg)   │ Telur (kg)    │
│ [Sticky Column]  │ [Pilih Batch ▼]    │ [Pilih Batch ▼]    │ [Pilih Batch] │
├──────────────────┼────────────────────┼────────────────────┼───────────────┤
│ 01. Dapur Tebet  │ [50.000] (SUP-A)   │ [25.500] (SUP-C)   │ [40.000]      │
│ 02. Dapur Cawang │ [50.000] (SUP-A)   │ [30.000] (SUP-C)   │ [35.250]      │
│ 03. Dapur Kalibata│ [50.000] (SUP-A)  │ [20.000] (SUP-C)   │ [42.000]      │
│ 04. Dapur PasarM │ [50.000] (SUP-B)   │ [28.750] (SUP-D)   │ [38.500]      │
│ 05. Dapur Pancor │ [50.000] (SUP-B)   │ [22.000] (SUP-D)   │ [30.000]      │
│ ... (s/d 30)     │ ...                │ ...                │ ...           │
├──────────────────┼────────────────────┼────────────────────┼───────────────┤
│ TOTAL ALOKASI    │ 250.000 / 250.000  │ 126.250 / 130.000  │ 185.750 kg    │
└──────────────────┴────────────────────┴────────────────────┴───────────────┘
```

### Fitur Interaksi Cepat
1. **Custom Decimal Numpad (`kg` dengan Presisi 3 Desimal):**
   - Tombol pintas `+10 kg`, `+5 kg`, `+0.500 kg`, `+0.250 kg`, dan tombol **Next Row (`⏎`)** untuk langsung berpindah ke baris dapur berikutnya tanpa menutup keyboard.
2. **Auto-Fill & Multi-Kitchen Batch Assignment:**
   - Fitur *"Alokasikan Batch SUP-A ke Dapur #01–#15"* dalam satu ketukan.
   - Indikator progres bar *real-time* yang memperingatkan jika total alokasi ke dapur melebihi `qty_procured_kg` pada `supplier_procurement_batches`.
3. **Bulk Action Bar:**
   - Tombol **"Terbitkan 25 Surat Jalan Sekaligus"** yang langsung mengubah status pengiriman menjadi `IN_TRANSIT` dan menyiapkan daftar tugas kurir.

---

## Layar B: Supplier Batch Procurement & Markup Pricing Screen (`OWNER_ADMIN` / `FINANCE`)

### Komponen Utama
1. **Kartu Input Batch Supplier (`supplier_procurement_batches`):**
   - Pilih Supplier, Item Komoditas, input `qty_procured_kg` (`NUMERIC(10,3)`), dan `supplier_actual_cost_per_kg` (`NUMERIC(15,2)`).
2. **Kalkulator & Pengunci Markup Dapur:**
   - Pilihan mode: **Nominal (`+ Rp X / kg`)** atau **Persentase (`+ Y %`)** di atas harga aktual batch supplier.
   - Preview langsung:
     - `Harga Beli Batch Supplier`: `Rp 36.000,00 / kg`
     - `Harga Jual ke Dapur MBG`: `Rp 40.000,00 / kg`
     - `Markup Kotor / kg`: `Rp 4.000,00 / kg` (`Tim 60%: Rp 2.400,00` | `Koperasi 40%: Rp 1.600,00`).
   - Tombol **"Kunci Snapshot Harga & Alokasikan"** (menegakkan **Invariant 3**).

---

## Layar C: Field BAST & Shrinkage Reconciliation Screen (`FIELD_TEAM`)

### Tujuan Ergonomis
Digunakan oleh kurir/petugas lapangan saat serah terima barang di pintu Dapur MBG. **Tanpa satu pun informasi harga/uang (Invariant 5)**, fokus 100% pada akurasi timbangan dan bukti fisik.

### Alur & Komponen Layar
1. **Daftar Dapur Rute Hari Ini:**
   - Menampilkan kartu 20–30 dapur dengan badge status: `BELUM TIBA`, `SEDANG TIMBANG`, atau `BAST SELESAI`.
2. **Mode "1-Tap Terima Utuh" vs "Input Selisih Timbangan":**
   - Untuk item yang diterima utuh tanpa susut, kurir cukup menekan tombol **`[✓ Terima Sesuai Surat Jalan (50.000 kg)]`**.
   - Jika ada susut atau barang rusak/reject di dapur, kurir memasukkan angka timbangan aktual dapur pada kolom **`Bobot Diterima Dapur (qty_accepted_kg)`**, misal `48.750 kg`.
3. **Kalkulasi Susut Otomatis di Layar:**
   - Sistem langsung menampilkan badge peringatan:
     > **Susut / Reject Terdeteksi: `1.250 kg`** (Otomatis masuk ke Nota Klaim Potongan Supplier asal Batch).
   - Wajib memilih alasan susut (`Susut Air/Perjalanan`, `Kemasan Rusak`, `Kualitas Reject Dapur`) dan mengambil **Foto Bukti BAST + Timbangan** (tersimpan secara *offline-first* di antrean lokal jika sinyal di dapur lemah).

---

## Layar D: Batch Invoicing, Rekonsiliasi `PAID`, & Potongan Supplier (`FINANCE` / `OWNER_ADMIN`)

### Tab 1: Tagihan ke 20–30 Dapur (`kitchen_invoices`)
- Daftar invoice harian yang otomatis dihitung dari `qty_accepted_kg × kitchen_unit_price_snapshot`.
- Filter cepat berdasarkan status: `UNPAID`, `PARTIALLY_PAID`, `PAID`.
- **Aksi Pelunasan (`Mark as PAID`):**
  - Saat Finance mengunggah bukti transfer dapur dan menekan **"Verifikasi Lunas (`PAID`)"**, layar menampilkan konfirmasi:
    > *"Mengubah status Invoice `INV-20261016-DPR02` (Rp 1.950.000,00) menjadi `PAID` akan otomatis membuka kunci (`AVAILABLE_FOR_PAYOUT`) saldo bagi hasil Tim (Rp 117.000,00) dan Koperasi (Rp 78.000,00)."*

### Tab 2: Rekonsiliasi Tagihan Bersih Supplier (`supplier_settlements`)
- Menampilkan ringkasan per Batch Supplier:
  - **Bobot Kirim Awal (`total_dispatched_kg`):** `150.000 kg` (`Rp 5.400.000,00`)
  - **Potongan Susut/Reject Dapur (`total_shrinkage_claim_kg`):** `- 1.250 kg` (`- Rp 45.000,00`)
  - **Total Bersih Wajib Dibayar ke Supplier (`net_payable_amount`):** **`148.750 kg` (`Rp 5.355.000,00`)**
- Tombol **"Unduh PDF Nota Retur/Potongan Susut Supplier"** untuk dikirimkan ke WhatsApp Supplier bersama bukti BAST dapur.

---

## Layar E: Profit-Sharing Ledger & Payout Settlement Screen

### Tujuan Transparansi (Invariant 4 & 5)
Memberikan visibilitas *real-time* yang memisahkan dengan tegas antara **keuntungan di atas kertas (piutang dapur belum dibayar)** dan **keuntungan tunai yang siap dicairkan**.

### Struktur Header Ringkasan Kas Bagi Hasil
1. **Kartu 1 — Terkunci / Menunggu Dapur Bayar (`LOCKED_UNPAID`):**
   - Warna: Kuning/Amber dengan ikon gembok.
   - Menampilkan rincian invoice dapur mana saja yang masih `UNPAID` atau `PARTIALLY_PAID`.
   - **Tombol Cairkan: NONAKTIF (Disabled).**
2. **Kartu 2 — Siap Dicairkan (`AVAILABLE_FOR_PAYOUT`):**
   - Warna: Hijau Emerald.
   - Hanya menjumlahkan bagi hasil dari invoice dapur yang sudah berstatus **`PAID`**.
   - Memisahkan nominal **Hak Tim (`TEAM`)** dan **Hak Koperasi (`COOPERATIVE`)**.
3. **Kartu 3 — Riwayat Telah Dicairkan (`PAID_OUT`):**
   - Menampilkan histori `profit_payout_batches` beserta bukti transfer bank dan rincian item pengiriman yang termasuk di dalam setiap batch pencairan.

### Alur Eksekusi Pencairan (`OWNER_ADMIN` / `FINANCE`)
1. Pilih penerima (`TEAM` atau `COOPERATIVE`).
2. Sistem memilih seluruh baris `profit_ledger_entries` yang berstatus `AVAILABLE_FOR_PAYOUT`.
3. Unggah bukti transfer pencairan (`transfer_proof_url`) dan klik **"Selesaikan Pencairan (`PAID_OUT`)"**.
4. Seluruh baris ledger terkait dikunci permanen dengan status `PAID_OUT` dan terhubung ke `payout_batch_id`.
