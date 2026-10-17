Lakukan perombakan total (complete UI/UX overhaul) pada seluruh komponen di `src/app/` dan `src/components/`.
PENTING: JANGAN mengubah rumus dan fungsi di `src/lib/financial-engine.ts` maupun `src/lib/mbg-store.ts` (kecuali menambahkan helper UI jika diperlukan), sehingga seluruh 5 Invariant bisnis tetap berjalan di balik layar TANPA menampilkan teks penjelasannya di layar pengguna.

Terapkan 6 Prinsip Desain Operasional Lapangan berikut secara ketat:

### 1. Hapus 100% Teks Jargon & Banner Penjelasan (Zero-Fluff UI)
- HAPUS SEMUA kotak banner penjelasan `INVARIANT 1 & 3`, `INVARIANT 2 & 5`, `INVARIANT 4`, kalimat penjelasan panjang di bawah judul, serta istilah kode seperti `v_safe_delivery_items_bast`, `qty_dispatched_kg`, `LOCKED_UNPAID`, atau `AVAILABLE_FOR_PAYOUT` dari tampilan layar.
- Ganti dengan label bahasa Indonesia operasional yang singkat, padat, dan jelas (maksimal 2-3 kata per label):
  * `LOCKED_UNPAID` -> **"Menunggu Dapur Bayar"**
  * `AVAILABLE_FOR_PAYOUT` -> **"Siap Cair"**
  * `OWNER_ADMIN` -> **"Admin"**
  * `FIELD_TEAM` -> **"Tim Lapangan"**
  * `COOPERATIVE_VIEWER` -> **"Koperasi"**

### 2. Tema High-Contrast Clean Light/Slate (Mudah Dibaca di Bawah Sinar Matahari)
- Ubah tema dari dark-neon menjadi **Clean Enterprise Light Mode** (`bg-slate-50`, kartu `bg-white` dengan border tegas `border-slate-200`, teks utama `text-slate-900`, aksen tombol utama `bg-emerald-600 text-white`).
- Header atas harus sangat ringkas (1 baris sticky header tinggi maksimal `56px`): Kiri judul singkat **"MBG Ledger"**, Tengah pill **Role Switcher (`Admin | Lapangan | Koperasi`)**, Kanan ikon kecil **Reset**.

### 3. Desain Ulang Tab 1: "Stok & HPP" (`Tab1SupplierBatches.tsx`)
- Gunakan **Collapsible Form / Modal Bottom Sheet**: Secara default tampilkan langsung daftar **Stok Batch Aktif** dalam bentuk tabel/baris kompak (1 baris = Nama Barang, Supplier, HPP/kg, Sisa Kg, dan tombol `Alokasikan`).
- Buat 1 tombol menonjol **"+ Tambah Barang Masuk (Supplier)"** di bagian atas untuk membuka form input 4 kolom sederhana: `Supplier`, `Bahan Baku`, `Berat Masuk (kg)`, dan `Harga Beli/kg (Rp)`.

### 4. Desain Ulang Tab 2: "Bagi ke Dapur" (`Tab2KitchenMatrix.tsx`) — Compact Spreadsheet Row
- Bagian atas: Dropdown pilih **Batch Barang** + Input **Markup/kg (Rp)** + info ringkas `HPP -> Harga Dapur (Sisa Stok: X kg)` dalam 1 kartu tipis.
- Tombol cepat 1 baris: `[Bagi Rata]` | `[Isi 20 kg Semua]` | `[Reset]`.
- **Daftar 25 Dapur Wajib Berbentuk Baris Tabel Kompak (Tinggi maksimal 48px per dapur)** agar 8–10 dapur langsung terlihat dalam 1 layar HP tanpa scroll panjang:
  * Kolom Kiri: Kode & Nama Dapur (`DPR-01 • Tebet`)
  * Kolom Tengah: Tombol cepat `+10` / `+50`
  * Kolom Kanan: Input angka `kg` yang jelas.
- Tombol aksi melayang (Sticky Bottom Button) di atas navigasi bawah: **"Simpan & Buat Surat Jalan (X Dapur • Total Y kg)"**.

### 5. Desain Ulang Tab 3: "Timbang BAST" (`Tab3FieldBast.tsx`) — Fast 1-Tap Field Mode
- Filter cepat di bagian atas: Pill `[Belum Timbang (X)]` vs `[Selesai (Y)]` + kotak pencarian nama dapur.
- Setiap kartu pengiriman dapur dibuat ringkas:
  * Baris 1: Nama Dapur + Nama Bahan Baku + Badge Status.
  * Baris 2 (Grid 2 kolom sejajar): **Kirim: `50.000 kg`** | Input **Diterima (kg): `[ 50.000 ]`**.
  * Baris 3 (Tombol 1-Tap): Tombol hijau besar **"✓ Sesuai Kirim (100%)"** di sebelah tombol **"Simpan"**.
  * Jika angka diterima < angka kirim, tampilkan 1 baris badge merah singkat: **"Susut -1.250 kg (Potong Tagihan Supplier)"** + input catatan singkat 1 baris.

### 6. Desain Ulang Tab 4 ("Tagihan") & Tab 5 ("Bagi Hasil") — Bebas Teks Bertabrakan
- **Tab 4 (Tagihan Dapur & Supplier):**
  * Sub-tab toggle: `Tagihan Dapur` | `Bayar Supplier`.
  * Setiap kartu Invoice Dapur hanya menampilkan informasi inti: Nama Dapur, Komoditas & Berat Terima (`kg`), **Total Tagihan (Rp)** ukuran besar, badge `Lunas` / `Belum Bayar`, tombol **"✓ Tandai Lunas"**, serta baris tombol ikon ringkas: `[🖨️ PDF Invoice]` `[💬 WA]` `[📄 Surat Jalan]`.
  * Pada sub-tab `Bayar Supplier`, tampilkan hitungan 3 baris bersih: `Kirim Awal` - `Potongan Susut Dapur` = **`Total Bersih Dibayar ke Supplier`** + tombol `[🖨️ Nota Potongan]` & `[Verifikasi Bayar]`.
- **Tab 5 (Bagi Hasil Tim & Koperasi):**
  * Hanya tampilkan 2 Kartu Angka Besar di atas:
    1. **Siap Dicairkan (Invoice Lunas):** Total Rp + rincian `Tim (60%): Rp ...` & `Koperasi (40%): Rp ...` + tombol **"Cairkan Sekarang"**.
    2. **Menunggu Dapur Bayar (Tertahan):** Total Rp + rincian `Tim` & `Koperasi`.
  * Pengaturan persentase bagi hasil (`60% : 40%`) ditaruh dalam accordion/baris lipat kecil agar tidak memakan layar.
  * Pada daftar rincian per dapur di bawah, gunakan layout `grid-cols-3 gap-2 text-xs` dengan `truncate` / pemisahan baris yang rapi sehingga angka `Markup`, `Hak Tim`, dan `Hak Koperasi` TIDAK PERNAH saling bertabrakan di layar sempit.

Setelah seluruh komponen diperbarui:
1. Jalankan `npm test`, `npm run typecheck`, dan `npm run build` untuk memastikan tidak ada error.
2. Lakukan `git add . && git commit -m "style(ux): redesign into clean, high-density operational UI without jargon" && git push origin main`.
