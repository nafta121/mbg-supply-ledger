---
trigger: always_on
description: >-
  Aturan bisnis, akuntansi, dan keamanan data mutlak (5 Business & Financial Invariants)
  untuk aplikasi B2B Supply Chain, Invoicing, dan Profit-Sharing Ledger Dapur MBG.
---

# Business and Financial Invariants (Aturan Mutlak)

Aturan di dalam dokumen ini bersifat **MUTLAK (NON-NEGOTIABLE)** dan **TIDAK BOLEH DILANGGAR** di bagian kode mana pun—baik pada skema database SQL, fungsi backend/RPC, model data Dart/Flutter, maupun komponen UI.

---

## Invariant 1: Presisi Angka & Satuan (`NUMERIC` & Satuan Dasar `kg`)

1. **Larangan Floating-Point Biner:**
   - **DILARANG KERAS** menggunakan tipe data `FLOAT`, `FLOAT4`, `FLOAT8`, `REAL`, atau `DOUBLE PRECISION` di PostgreSQL untuk menyimpan nominal uang, harga satuan, persentase bagi hasil, maupun kuantitas berat barang.
   - Di lapisan aplikasi (Flutter/Dart atau TypeScript), hindari aritmatika `double` langsung untuk kalkulasi buku besar/keuangan; gunakan representasi desimal presisi tetap (`Decimal` / integer sen / string `NUMERIC` dari database).
2. **Standar Tipe Data Database:**
   - **Mata Uang (IDR):** Wajib menggunakan `NUMERIC(15,2)`.
   - **Kuantitas Berat (`kg`):** Wajib menggunakan `NUMERIC(10,3)` dalam satuan dasar **kilogram (`kg`)** agar akurat hingga satuan gram (`0.001 kg`). Contoh: `14.250` merepresentasikan `14 kg 250 gram`.
3. **Pembulatan Terstandar:**
   - Seluruh kalkulasi total harga (`qty_kg × unit_price`) dibulatkan ke `NUMERIC(15,2)` menggunakan `ROUND(val, 2)` (half-up) di level database agar tidak pernah terjadi selisih Rp 0,01 antara invoice, tagihan supplier, dan ledger bagi hasil.

---

## Invariant 2: Zero-Shrinkage Risk (Beban Susut 100% di Supplier)

Segala bentuk penyusutan bobot (*shrinkage*) di perjalanan atau barang rusak/reject saat ditimbang terima oleh Dapur MBG adalah **100% tanggung jawab Supplier**, **BUKAN** tanggung jawab Tim maupun Koperasi.

1. **Rumus Kuantitas Susut / Klaim Supplier:**
   $$\text{qty\_supplier\_claim\_or\_return\_kg} = \text{qty\_dispatched\_kg} - \text{qty\_accepted\_by\_kitchen\_kg}$$
   - Nilai `qty_accepted_by_kitchen_kg` adalah satu-satunya kuantitas sah yang menjadi dasar tagihan ke dapur, dasar pembayaran ke supplier, dan dasar perhitungan bagi hasil.
2. **Rumus Tagihan ke Dapur (`Kitchen Invoice`):**
   $$\text{Kitchen Invoice Line Total} = \text{qty\_accepted\_by\_kitchen\_kg} \times \text{kitchen\_unit\_price\_snapshot}$$
3. **Rumus Kewajiban Bayar ke Supplier (`Supplier Payable`):**
   $$\text{Supplier Payable Line Total} = \text{qty\_accepted\_by\_kitchen\_kg} \times \text{supplier\_actual\_cost\_snapshot}$$
   - **DILARANG** menghitung hutang ke supplier berdasarkan `qty_dispatched_kg` (bobot kirim awal).
   - Selisih bobot (`qty_supplier_claim_or_return_kg`) wajib tercatat otomatis sebagai **Potongan Tagihan / Nota Retur Supplier** (`supplier_claim_amount = qty_supplier_claim_or_return_kg × supplier_actual_cost_snapshot`).

---

## Invariant 3: Actual Supplier Batch Costing & Price Immutability

1. **Larangan Harga Rata-Rata (*Average Costing*):**
   - Metode Harga Pokok Penjualan (HPP) / harga beli **WAJIB** menggunakan **harga beli aktual dari supplier per batch (`Actual Cost per Batch`)**, bukan rata-rata tertimbang (*moving/weighted average*) maupun estimasi standar.
2. **Keterlacakan Batch (`supplier_batch_id`):**
   - Setiap baris pengiriman dan item pada Invoice Dapur (`kitchen_delivery_items`) **WAJIB** memiliki foreign key `NOT NULL` ke `supplier_procurement_batches(id)` (`supplier_batch_id`).
3. **Immutability Snapshot Harga:**
   - Saat alokasi/pengiriman ke dapur dibuat, sistem **WAJIB** menyalin dan mengunci nilai:
     - `supplier_actual_cost_snapshot` (`NUMERIC(15,2)`) dari batch supplier terkait.
     - `kitchen_unit_price_snapshot` (`NUMERIC(15,2)`) yang berlaku untuk dapur tersebut.
   - Perubahan harga di tabel master item atau perubahan harga pada batch pengadaan baru di masa depan **TIDAK BOLEH** mengubah histori invoice dapur, tagihan supplier, maupun nominal bagi hasil yang sudah tercatat.

---

## Invariant 4: Cash-Basis Profit Sharing (`LOCKED_UNPAID` -> `AVAILABLE_FOR_PAYOUT`)

1. **Rumus Total Markup (Gross Profit per Pengiriman Dapur):**
   $$\text{Total Markup} = \text{qty\_accepted\_by\_kitchen\_kg} \times (\text{kitchen\_unit\_price\_snapshot} - \text{supplier\_actual\_cost\_snapshot})$$
   - `Total Markup` dibagi antara **Tim** (`TEAM`) dan **Koperasi** (`COOPERATIVE`) sesuai konfigurasi porsi bagi hasil yang berlaku pada transaksi tersebut.
2. **Prinsip Kas Masuk (*Strict Cash Basis*):**
   - Saat BAST diselesaikan dan Invoice Dapur diterbitkan (`ISSUED`, `UNPAID`, atau `PARTIALLY_PAID`), baris buku besar bagi hasil (`profit_ledger_entries`) untuk Tim dan Koperasi dibuat dengan status **`LOCKED_UNPAID`**.
   - Selama berstatus `LOCKED_UNPAID`, dana bagi hasil **DILARANG KERAS** dimasukkan ke dalam batch pencairan (`profit_payout_batches`) atau dicairkan sebagian maupun seluruhnya.
   - Saldo bagi hasil otomatis berubah status menjadi **`AVAILABLE_FOR_PAYOUT`** (siap dicairkan) **HANYA SETELAH** Invoice Dapur terkait diverifikasi lunas dan berstatus **`PAID`** (melalui Database Trigger yang atomik).
   - Apabila status invoice yang semula `PAID` dibatalkan/dikoreksi (selama bagi hasil belum berstatus `PAID_OUT`), trigger wajib mengembalikan status ledger menjadi `LOCKED_UNPAID`.

---

## Invariant 5: Strict Role-Based Access Control (Proteksi Harga Modal)

Akses terhadap harga modal (`supplier_actual_cost`), nominal markup, dan buku besar bagi hasil harus ditegakkan di **level Database (PostgreSQL RLS & View/Column Security)** serta di **level UI Mobile**:

1. **Role `FIELD_TEAM` (Tim Lapangan / Kurir / Gudang):**
   - **Diizinkan:** Melihat daftar dapur, item barang, kuantitas alokasi/kirim (`qty_dispatched_kg`), surat jalan, serta menginput bobot terima dapur (`qty_accepted_kg`), bobot susut/reject, dan foto bukti BAST.
   - **DILARANG KERAS:** Melihat atau melakukan query terhadap `supplier_actual_cost`, `supplier_actual_cost_snapshot`, `kitchen_unit_price_snapshot`, nominal `markup`, total tagihan supplier, maupun laporan bagi hasil.
   - Query API untuk `FIELD_TEAM` wajib melalui *Security-Barrier View* atau RPC yang tidak menyertakan kolom harga/biaya.
2. **Role `COOPERATIVE_VIEWER` (Pihak Koperasi):**
   - **Diizinkan:** Melihat rekap kuantitas diterima oleh masing-masing dapur (`qty_accepted_kg`), status pembayaran invoice dapur (`UNPAID`, `PARTIALLY_PAID`, `PAID`), serta rincian perhitungan dan status pencairan hak bagi hasil Koperasi (`LOCKED_UNPAID`, `AVAILABLE_FOR_PAYOUT`, `PAID_OUT`).
   - **Tidak Diizinkan:** Mengubah data operasional, mengubah harga/markup, atau mengeksekusi pencairan dana.
3. **Role `OWNER_ADMIN` / `FINANCE`:**
   - **Diizinkan:** Akses penuh (`SELECT`, `INSERT`, `UPDATE`) ke seluruh batch pengadaan supplier, `supplier_actual_cost`, pengaturan markup per dapur/item, penerbitan & verifikasi pelunasan invoice dapur (`PAID`), penyelesaian pembayaran ke supplier (`supplier_settlements`), serta eksekusi pencairan bagi hasil (`profit_payout_batches`).
