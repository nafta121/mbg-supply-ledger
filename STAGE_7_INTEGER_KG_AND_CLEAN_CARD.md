Lakukan 2 perubahan utama secara menyeluruh pada aturan workspace, tampilan UI, seed data, dan unit test:
(A) Ubah seluruh satuan berat kilogram (`kg`) menjadi **Bilangan Bulat (Integer) TANPA desimal/koma** (contoh: `50 kg`, `20 kg`, `75 kg`, BUKAN `50.000 kg`).
(B) Perbaiki desain kartu dapur pada layar `Lapangan` (`Tab3FieldBast.tsx`) agar barang yang sudah ditimbang dan belum ditimbang terpisah dengan jelas.

Kerjakan 6 langkah berikut secara tuntas:

### 1. Update Aturan Invariant 1 (`.agents/rules/business-and-financial-invariants.md` & `AGENTS.md`)
- Perbarui Invariant 1: Seluruh kuantitas berat bahan baku menggunakan satuan **Kilogram bulat (`INTEGER` / bilangan bulat tanpa desimal atau koma)**, misalnya `50 kg`, `75 kg`, `-3 kg`.
- Di Indonesia, penulisan `50.000 kg` akan terbaca sebagai "lima puluh ribu kg". Oleh karena itu, DILARANG menampilkan `.000` atau desimal pada angka kilogram di bagian mana pun di aplikasi (UI, Input, maupun dokumen Print PDF / pesan WhatsApp).

### 2. Ubah Formatter Berat & Seed Data Menjadi Angka Bulat (`src/lib/ui-format.ts` & `src/lib/mbg-store.ts`)
- Ubah fungsi format berat (`formatKg` atau setara) di seluruh aplikasi agar membulatkan angka ke integer terdekat (`Math.round(kg)`) tanpa desimal sama sekali:
  * Contoh output yang benar: `50 kg`, `20 kg`, `70 / 70 kg`, `-3 kg`.
  * Contoh output yang DILARANG: `50.000 kg`, `50,000 kg`, `48.750 kg`.
- Perbarui angka pada **Seed Data (`src/lib/mbg-store.ts`)** menjadi bilangan bulat murni:
  * Batch 1 (`SUP-A` Ayam): Masuk `150 kg` @ `Rp 36.000/kg`. Dialokasikan ke `DPR-01` (`50 kg`, diterima `50 kg`), `DPR-02` (`50 kg`, diterima `49 kg`, susut `-1 kg`), dan `DPR-03` (`50 kg`, diterima `50 kg`).
  * Batch 2 (`SUP-B` Ayam): Masuk `100 kg` @ `Rp 37.000/kg`. Dialokasikan ke `DPR-04` (`50 kg`, diterima `48 kg`, susut `-2 kg`) dan `DPR-05` (`50 kg`, diterima `50 kg`).
  * Batch 3 (`SUP-C` Telur): Masuk `500 kg` @ `Rp 26.500/kg`. Dialokasikan `20 kg` ke `DPR-01` (status belum ditimbang) dan `20 kg` ke `DPR-02` (status belum ditimbang).
  * Batch aktif tambahan: `125 kg` (bukan `125.500 kg`).
  * Dengan demikian total susut fisik adalah `-3 kg` (`-1 kg` di DPR-02 dan `-2 kg` di DPR-04), seluruh kalkulasi tagihan dapur, potongan supplier, dan bagi hasil menjadi angka bulat yang sangat bersih.
- Pada seluruh `<input>` berat kilogram di semua tab (Tab 1, Tab 2, Tab 3), gunakan `inputMode="numeric"` dan `step="1"` dengan placeholder `"0"` (bukan `"0.000"`).

### 3. Perbaiki Desain Kartu Dapur di Layar `Lapangan` (`Tab3FieldBast.tsx`)
- **Untuk barang yang SUDAH ditimbang (`✓ Tertimbang`):**
  * JANGAN tampilkan kotak `<input>` terbuka dan tombol `100%`.
  * Render sebagai **1 baris ringkas terkunci (`bg-slate-50 rounded-lg px-3 py-2`)**:
    - Kiri: Nama Barang + badge hijau `✓ Tertimbang` (atau badge merah `Susut -1 kg` jika ada susut).
    - Kanan: Teks statis **`50 / 50 kg`** (atau **`49 / 50 kg`**) + tombol teks kecil **`Ubah`** (kotak input hanya terbuka jika kurir menekan `Ubah`).
- **Untuk barang yang BELUM ditimbang (`PENDING`):**
  * Tampilkan badge kuning **`Perlu Ditimbang`** di sebelah nama barang.
  * Kotak input `Diterima (kg)` WAJIB dimulai dalam keadaan **KOSONG (`value=""`, `placeholder="0"`)**, jangan diisi otomatis dengan angka kirim sebelum ditimbang.
  * Di sebelah kotak input, sediakan tombol **`✓ Pas (20 kg)`** yang jika diketuk baru mengisi angka `20` ke input.
- **Hapus Kode Batch Teknis:** Jangan tampilkan kode `BATCH-20261016-...` di kartu kurir.

### 4. Perbaiki Perhitungan "Total Diterima" & Tombol Bawah Kartu Dapur
- Jangan menjumlahkan barang yang belum ditimbang ke dalam `Total diterima`. Tampilkan dengan jujur: **`Tertimbang: 1/2 barang (50 / 70 kg)`**.
- Gunakan logika tombol bawah kartu yang aman (Anti-Timpa):
  * Tombol hijau **`✓ Terima Sesuai Kirim (Barang Belum Timbang)`** hanya melunaskan barang yang statusnya masih `Perlu Ditimbang` (`PENDING`), dan DILARANG menimpa barang yang sudah `✓ Tertimbang` (seperti Ayam `49 kg` / susut `-1 kg` di `DPR-02`).
  * Jika kurir sudah mengetik angka di input, tampilkan tombol **`💾 Simpan Timbangan Dapur`**.

### 5. Pastikan Print PDF & Pesan WhatsApp Menggunakan Kilogram Bulat
- Periksa `src/components/PrintDocuments.tsx` dan `src/lib/share.ts`: pastikan seluruh cetakan PDF Invoice, Surat Jalan BAST, Nota Potongan Supplier, dan teks WA menampilkan berat bulat seperti `50 kg`, `49 kg`, `-1 kg` (tanpa `.000`).

### 6. Sesuaikan & Jalankan Seluruh Unit Tests
- Perbarui unit test di `src/lib/__tests__/` agar menguji angka kilogram bulat baru serta memverifikasi bahwa format output berat tidak mengandung `.000` dan tombol "Terima Sesuai Kirim" tidak menimpa barang yang sudah tertimbang.
- Jalankan `npm test`, `npm run typecheck`, dan `npm run build` hingga lulus 100%, lalu lakukan `git add . && git commit -m "fix(kg): use whole integer kilograms without decimals and clean up courier card" && git push origin main`.
