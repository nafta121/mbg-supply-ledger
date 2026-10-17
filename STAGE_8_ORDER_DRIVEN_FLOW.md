Lakukan refaktor arsitektur bisnis dan UI/UX aplikasi menjadi **Order-Driven Workflow (By Order dari Dapur)** sesuai perubahan kebutuhan operasional Fase 1:

### Aturan Bisnis Baru (Wajib Diterapkan di `AGENTS.md`, `.agents/rules/`, Store, dan UI):
1. **HAPUS TOTAL Fitur Stok Batch & Settlement Supplier:**
   - Hapus Tab `Stok & HPP` (`Tab1SupplierBatches.tsx`), hapus konsep alokasi stok batch (`Tab2KitchenMatrix.tsx`), dan hapus sub-tab `Bayar Supplier` / `Nota Potongan Supplier`.
   - Fase ini HANYA menangani **Order Dapur -> Pengiriman & Timbang BAST Kurir -> Invoice Tagihan ke Dapur -> Bagi Hasil (Tim & Koperasi)**. Tidak ada pencatatan hutang/pembayaran ke supplier.
2. **Alur Input Order per Dapur (Multi-Item Order):**
   - Admin menerima order dari sebuah dapur (contoh: `DPR-01 • Dapur A` memesan `Wortel 35 kg` dan `Kubis 25 kg`).
   - Admin menginput **Order Dapur** yang berisi daftar barang yang harus dikirim ke dapur tersebut beserta **`Harga Dapur / kg (Rp)`** (harga jual ke dapur yang sudah termasuk markup dari supplier) dan **`Margin / Bagian Kita per kg (Rp)`** (nominal selisih/komisi per kg yang menjadi hak bagi hasil Tim & Koperasi).
3. **Satuan Berat Kilogram Bulat (Integer Tanpa Desimal):**
   - Seluruh angka berat wajib bilangan bulat murni (`35 kg`, `25 kg`, `60 kg`) TANPA `.000` atau koma di seluruh layar, input, PDF, dan pesan WhatsApp.
4. **Invoicing ke Dapur Berbasis Bobot Terima (`qty_accepted_kg`):**
   - Setiap Order Dapur menghasilkan **1 Kartu Pengiriman Dapur (Multi-Barang)** di layar Kurir dan **1 Invoice Tagihan Dapur Gabungan (Multi-Barang)**.
   - Tagihan per baris barang di Invoice Dapur = `qty_accepted_kg * kitchen_unit_price_rp`.
   - Jika saat ditimbang di dapur ada barang yang kurang/reject (misal kirim Wortel `35 kg`, diterima dapur `33 kg`, selisih `-2 kg`), maka Invoice ke Dapur otomatis hanya menagih sebesar bobot yang diterima dapur (`33 kg`).
5. **Bagi Hasil Cash-Basis (Tim vs Koperasi):**
   - Total bagi hasil per item = `qty_accepted_kg * margin_per_kg_rp`, dibagi sesuai persentase Tim (misal 60%) dan Koperasi (40%).
   - Tetap berbasis Cash-Basis: berstatus **`Menunggu Dapur Bayar`** saat invoice belum lunas, dan otomatis menjadi **`Siap Dicairkan`** saat Invoice Dapur ditandai **`Lunas`**.
6. **Strict RBAC (Proteksi Harga di Layar Lapangan):**
   - Role **`Lapangan` (Kurir)** hanya melihat daftar dapur, nama PIC, dan daftar barang beserta kuantitas kilogram bulat (`Wortel 35 kg`, `Kubis 25 kg`) TANPA melihat harga maupun rupiah.

---

### Spesifikasi 4 Tab Aplikasi Baru:

#### 1. Tab 1: "Order Dapur" (Pengganti Tab Stok & Matriks — Khusus `Admin`)
- **Form "+ Buat Order Dapur Baru" (Atau langsung di atas layar):**
  * Pilih **Dapur Tujuan** (dari daftar 25 dapur, lengkap dengan pencarian cepat).
  * **Daftar Barang Pesanan (Bisa tambah banyak baris barang dalam 1 order):**
    - Pilih/Ketik Nama Barang (misal: `Wortel`, `Kubis`, `Daging Ayam`, `Telur Ayam`, `Beras`) — otomatis mengisi harga default barang tersebut sehingga Admin tidak perlu mengetik harga berulang kali, namun harga tetap bisa diedit.
    - Input **Berat Order (`kg` bulat)**, contoh: `35`.
    - Input **Harga Dapur/kg (`Rp`)**, contoh: `14.000`.
    - Input kecil/opsional **Margin Kita/kg (`Rp`)** untuk dasar bagi hasil Tim & Koperasi.
    - Tombol `+ Tambah Barang Lain` di dalam order dapur tersebut.
  * Tampilkan preview singkat: `Total Barang: 2 jenis (60 kg) • Estimasi Tagihan Dapur: Rp ...`
  * Tombol utama: **"Simpan Order & Kirim ke Daftar Kurir"**.
- **Daftar Order Dapur Aktif Hari Ini:**
  * Menampilkan kartu per dapur beserta rincian barang yang dipesan (`Wortel 35 kg, Kubis 25 kg`), status pengiriman (`Menunggu Kurir` / `Sebagian Tertimbang` / `Selesai BAST`), dan tombol hapus/tambah barang.

#### 2. Tab 2: "Timbang" (Layar Utama Kurir `Lapangan` & `Admin`)
- Saat role **`Lapangan`** dipilih, langsung buka layar ini dan sembunyikan navigasi bawah.
- **Kartu Ringkasan Atas ("📦 Total Barang yang Harus Dibawa Kurir"):**
  * Menjumlahkan total kilogram bulat per jenis barang dari semua order dapur hari ini (contoh: `Wortel: 105 kg` • `Kubis: 75 kg` • `Daging Ayam: 150 kg`).
- **Daftar Kartu per Dapur (`1 Kartu = 1 Dapur beserta seluruh barang orderannya`):**
  * Contoh Kartu `DPR-01 • Dapur A`:
    - Baris 1: `Wortel` — Order/Kirim: **`35 kg`** | Input Diterima: `[   ]` kg + tombol `✓ Pas (35 kg)`.
    - Baris 2: `Kubis` — Order/Kirim: **`25 kg`** | Input Diterima: `[   ]` kg + tombol `✓ Pas (25 kg)`.
  * Barang yang sudah ditimbang otomatis tampil sebagai **baris ringkas terkunci** (`✓ Tertimbang: 35 / 35 kg` + tombol `Ubah`).
  * Barang yang belum ditimbang memiliki kotak input kosong (`placeholder="0"`) dan badge `Perlu Ditimbang`.
  * Jika `Diterima < Kirim`, tampilkan badge merah `Selisih/Reject -2 kg (Hanya ditagih 33 kg ke Dapur)` + catatan singkat.
  * Tombol bawah kartu: **`✓ Terima Sesuai Order (Semua Barang)`** dan **`💾 Simpan Timbangan Dapur`**, serta tombol **`📄 Cetak Surat Jalan / BAST`** & **`💬 WA BAST`** (tanpa harga).

#### 3. Tab 3: "Invoice Dapur" (Fokus 100% Tagihan ke Dapur — Tanpa Sub-Tab Supplier)
- Hapus sub-tab `Bayar Supplier`. Halaman ini murni mengelola **Invoice Tagihan ke Dapur**.
- Rekap 2 Kartu di atas: **`Belum Dibayar Dapur (Rp ...)`** dan **`Sudah Lunas (Rp ...)`**.
- **Kartu Invoice Dapur Gabungan (Multi-Item per Dapur):**
  * Menampilkan Nama Dapur, Nomor Invoice, Badge Status (`Belum Bayar` / `Lunas`).
  * Tabel ringkas seluruh barang di dalam invoice tersebut:
    - `Wortel`: `35 kg × Rp 14.000 = Rp 490.000`
    - `Kubis`: `25 kg × Rp 10.000 = Rp 250.000`
  * **Total Tagihan Dapur (`Rp 740.000`)** dalam ukuran besar.
  * Tombol **`✓ Tandai Lunas`**, **`🖨️ PDF Invoice Dapur`**, **`💬 Salin & WA Tagihan`**, dan **`📄 Surat Jalan BAST`**.

#### 4. Tab 4: "Bagi Hasil" (Tim vs Koperasi — Cash Basis)
- Kartu 1: **`Siap Dicairkan (Dari Invoice Dapur yang Sudah Lunas)`** dengan rincian `Hak Tim` & `Hak Koperasi` serta tombol pencairan.
- Kartu 2: **`Menunggu Dapur Bayar (Dari Invoice Belum Lunas)`**.
- Rincian bagi hasil per Invoice Dapur di bawahnya.

#### 5. Perbarui Seed Data & Unit Tests
- Perbarui Seed Data di `src/lib/mbg-store.ts` agar mencerminkan skenario nyata ini (gunakan komoditas seperti `Wortel`, `Kubis`, `Daging Ayam Fillet`, `Telur Ayam`, `Beras` dengan angka kilogram bulat seperti `35 kg`, `25 kg`, `50 kg` pada beberapa dapur).
- Sesuaikan seluruh unit test di `src/lib/__tests__/`, pastikan `npm test`, `npm run typecheck`, dan `npm run build` lulus 100%, lalu jalankan `git add . && git commit -m "feat: pivot to kitchen order-driven flow without stock or supplier settlement" && git push origin main`.
