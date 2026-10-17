Lakukan penyempurnaan presisi (UI/UX & Operational Polish) berdasarkan hasil audit visual di layar HP tanpa merusak `src/lib/financial-engine.ts`:

### 1. Perbaiki Keterbacaan Tabel "Stok & HPP" (`Tab1SupplierBatches.tsx`)
- Jangan memotong nama bahan baku menjadi hanya 1 kata (`Daging ...`). Berikan ruang baris yang cukup untuk menampilkan **Nama Bahan Baku utuh** di baris atas, lalu di bawahnya tampilkan `Nama Supplier • Kode/Urutan Batch (contoh: #B05)`.
- Tambahkan filter pill kecil di atas tabel: `Tersedia (3)` | `Habis (2)` | `Semua (5)` agar judul jumlah batch sesuai dengan jumlah baris yang tampil.

### 2. Perbaiki Mode Read-Only Koperasi & Tampilkan Alasan Susut (`Tab3FieldBast.tsx`)
- Saat role `COOPERATIVE_VIEWER` (Koperasi) aktif, ubah kotak `<input>` pada kolom `Diterima (kg)` menjadi kotak teks statis (`bg-slate-100`) agar tidak terlihat seperti form yang bisa diedit.
- Tetap tampilkan teks keterangan/alasan susut (contoh: *"Catatan: Susut Air/Perjalanan 1.250 kg saat timbang"*) dalam bentuk teks bacaan bagi role Koperasi agar transparansi terjaga.

### 3. Perjelas Alur Pencairan Terpisah & Tombol Salin WA (`Tab4InvoicesAndSettlements.tsx` & `Tab5ProfitLedger.tsx`)
- Pada `Tab4InvoicesAndSettlements.tsx`:
  * Standarkan status tagihan dapur menjadi 2 status tegas: **`Belum Bayar`** dan **`Lunas`** (ubah data simulasi `PARTIALLY_PAID` menjadi `ISSUED` / `Belum Bayar` agar konsisten dengan total tagihan `Rp 4.000.000`).
  * Pada tombol `💬 WA`, selain membuka WhatsApp, otomatis salin (*copy to clipboard*) teks ringkasan invoice dan tampilkan toast *"Ringkasan tagihan disalin & siap ditempel ke Grup WA"*.
- Pada `Tab5ProfitLedger.tsx`:
  * Pisahkan tombol pencairan di dalam kartu **Siap Dicairkan** menjadi 2 tombol berdampingan: **`Cairkan Hak Tim`** dan **`Cairkan Hak Koperasi`** (atau opsi pilih semua), karena waktu transfer kas ke Tim internal dan ke Koperasi di lapangan bisa berbeda.

### 4. Tambahkan Drawer/Modal "Kelola Data Master (Dapur, Supplier, Barang)" untuk Admin
- Tambahkan 1 tombol ikon **`⚙️ Data Master`** di header atas (khusus role `Admin` / `OWNER_ADMIN`).
- Saat dibuka, tampilkan modal/sheet dengan 3 tab sederhana yang tersimpan di `mbg-store.ts`:
  1. **Daftar Dapur MBG:** Bisa menambah dapur baru, mengubah nama dapur (misalnya dari `Tebet` menjadi nama SPPG/Dapur asli di daerah operasional), dan mengubah nama/no WA PIC.
  2. **Daftar Supplier:** Bisa menambah/mengedit nama Supplier dan info rekening/kontak.
  3. **Daftar Bahan Baku:** Bisa menambah/mengedit nama komoditas bahan baku (satuan tetap dikunci dalam `kg`).

Setelah selesai:
1. Jalankan `npm test`, `npm run typecheck`, dan `npm run build` hingga lulus 100%.
2. Lakukan `git add . && git commit -m "feat(ux): add master data manager, fix batch truncation, and refine coop/payout flows" && git push origin main`.
