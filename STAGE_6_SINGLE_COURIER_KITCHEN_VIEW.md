Rombak tampilan dan alur kerja role `Lapangan` (`FIELD_TEAM`) dan Tab `Timbang` (`Tab3FieldBast.tsx`) menjadi **Kitchen-Centric View (1 Kartu Dapur = Seluruh Daftar Barang yang Harus Dikirim ke Dapur Tersebut)** karena operasional saat ini dijalankan oleh 1 kurir tunggal.

Pertahankan 100% rumus di `src/lib/financial-engine.ts` dan Invariant 5 (DILARANG menampilkan harga beli supplier, harga jual dapur, maupun rupiah di layar `Lapangan`).

Kerjakan 5 spesifikasi berikut secara lengkap:

### 1. Sederhanakan Navigasi Saat Mode `Lapangan` (`FIELD_TEAM`) Aktif (`AppShell.tsx`)
- Saat pengguna memilih role **`Lapangan`**, langsung arahkan ke layar **`Kirim Dapur`** (`Tab3FieldBast.tsx`) dan sembunyikan tab `Bagi ke Dapur` milik Admin agar kurir tidak bingung melihat matriks alokasi admin.
- Pada mode `Lapangan`, kurir hanya membutuhkan tampilan fokus untuk melihat muatan dan menyelesaikan pengiriman dapur satu per satu.

### 2. Kartu Ringkasan "Total Muatan Hari Ini" di Bagian Atas (`Tab3FieldBast.tsx`)
- Di bagian paling atas layar `Timbang`, tampilkan kartu ringkas **"📦 Total Muatan Hari Ini"** yang menjumlahkan total `qty_dispatched_kg` per jenis bahan baku dari seluruh pengiriman dapur yang aktif (contoh: `Daging Ayam Fillet: 250.000 kg` • `Telur Ayam Negeri: 100.000 kg`).
- Tampilkan indikator progres kunjungan dapur: **`Progres Kurir: X dari Y Dapur Selesai`** beserta total akumulasi susut fisik (jika ada).

### 3. Kelompokkan Kartu Berdasarkan Dapur (`1 Kartu = 1 Dapur Lengkap dengan Semua Barangnya`)
- Ubah struktur daftar di `Tab3FieldBast.tsx` yang tadinya 1 kartu per pengiriman item menjadi **dikelompokkan per Dapur (`kitchen_id`)**:
  * **Header Kartu Dapur ** Nama Dapur (`DPR-01 • Tebet`),PIC Dapur, dan badge status dapur (`Belum Selesai` / `Selesai`).
  * **Daftar Barang di Dalam Kartu Dapur:** Tampilkan seluruh item bahan baku yang harus dikirim ke dapur tersebut dalam baris-baris yang rapi. Setiap baris item menampilkan:
    - Nama Bahan Baku & Kode Batch asal.
    - Bobot **Kirim (`kg`)** vs Input Bobot **Diterima (`kg`)** (presisi 3 desimal) + tombol kecil `100%` di tiap baris.
  * **Penanganan Susut per Baris Item:** Jika pada salah satu barang nilai `Diterima (kg) < Kirim (kg)`, tampilkan badge merah **`Susut -X.XXX kg (Potong Tagihan Supplier)`** tepat di bawah item tersebut, dilengkapi tombol pilihan cepat (quick chips) alasan susut: `[Susut]`, `[Barang Rusak/Reject]`, `[Selisih Timbang]` + kolom catatan singkat.
  * **Tombol Aksi di Bawah Kartu Dapur:**
    - Tombol cepat 1-klik: **`✓ Terima 100% Semua Barang`** (langsung mengisi seluruh barang di dapur itu sesuai bobot kirim dan menyimpan BAST).
    - Tombol **`Simpan Timbangan Dapur`** (untuk menyimpan hasil input/koreksi timbangan seluruh barang di dapur tersebut sekaligus).
    - Jika dapur sudah berstatus `Selesai`, tampilkan tombol **`📄 Bukti BAST`** dan **`💬 WA BAST ke PIC`** (berisi rekap seluruh barang yang diterima dapur tersebut dalam satuan `kg` TANPA harga).

### 4. Perkaya Seed Data agar Ada Dapur dengan Multi-Barang (`src/lib/mbg-store.ts`)
- Agar tampilan 1 Dapur dengan banyak barang bisa langsung terlihat dan diuji, pastikan di Seed Data (atau fungsi alokasi) ketika Admin mengalokasikan lebih dari 1 jenis bahan baku ke dapur yang sama (misalnya `DPR-01 • Tebet` dan `DPR-02 • Cawang` menerima `Daging Ayam Fillet` DAN `Telur Ayam Negeri`), kedua barang tersebut tampil berkumpul di bawah kartu dapur yang sama di layar Kurir.

### 5. Sinkronisasi Keterangan Susut ke Layar Admin & Koperasi
- Pastikan alasan susut yang dipilih kurir tetap tampil jelas di mode `Koperasi` (sebagai teks read-only) dan di sub-tab `Bayar Supplier` milik `Admin` sebagai dasar pemotongan tagihan ke Supplier.

Setelah selesai:
1. Jalankan `npm test`, `npm run typecheck`, dan `npm run build` hingga lulus 100%.
2. Lakukan `git add . && git commit -m "feat(courier): group field deliveries by kitchen stop with multi-item BAST and total vehicle load" && git push origin main`.
