# MBG Supply Chain & Profit-Sharing Ledger — Architecture & Domain Context (`CONTEXT.md`)

Dokumen ini menjadi acuan tunggal (*Single Source of Truth*) untuk struktur arsitektur, skema data, kontrak API, dan invarian bisnis pada aplikasi **MBG Supply Chain Ledger** (`https://mbg.letsgrow.web.id`) dalam migrasi dan operasional **100% Full Cloudflare Stack**.

---

## 1. Arsitektur Target: 100% Full Cloudflare Stack

Seluruh lapisan aplikasi berjalan di jaringan Edge Cloudflare tanpa ketergantungan pada database atau layanan eksternal (Supabase PostgreSQL / PostgREST / Realtime dilepas sepenuhnya):

| Lapisan | Produk Cloudflare | Binding / Lokasi | Fungsi Utama |
| :--- | :--- | :--- | :--- |
| **Frontend SPA / PWA** | **Workers Static Assets** | `env.ASSETS` (`./out`) | Menyajikan aplikasi Next.js Static Export + Service Worker `public/sw.js` langsung dari PoP Cloudflare terdekat (`run_worker_first = ["/api/*"]`). |
| **API & Edge Compute** | **Cloudflare Workers** | [`src/worker.ts`](src/worker.ts) | Menangani seluruh endpoint `/api/*`, validasi autentikasi PIN dengan Web Crypto API, caching ETag (`caches.default`), dan orkestrasi transaksi. |
| **Database Relasional** | **Cloudflare D1 (SQLite)** | `env.DB` (`mbg-supply-ledger-db`) | Menyimpan seluruh 8 tabel operasional MBG + kredensial role secara relasional dengan transaksi atomik `db.batch([...])` dan `PRAGMA foreign_keys = ON`. |
| **Koordinasi Real-Time** | **Cloudflare Durable Objects** | `env.MBG_SYNC_HUB` (`MbgSyncHub`) | Menangani koneksi WebSocket Hibernation (`/api/ws`), *zero-latency inline snapshot push* (`0ms`), deduplikasi mutasi idempoten (`clientMutationId`), dan metadata rilis APK. |
| **Penyimpanan Objek** | **Cloudflare R2** | `env.MBG_STORAGE` (`mbg-supply-ledger-files`) | Menyimpan dokumen foto BAST, bukti transfer pencairan, dan file binary APK Android dengan **$0 biaya egress**. |

---

## 2. Invarian Bisnis & Akuntansi (Wajib Dipertahankan 100%)

1. **Invarian 1 — Aritmetika Uang & Berat Berbasis Integer (`BigInt` Sen & Gram):**
   - Seluruh perhitungan uang di [`src/lib/financial-engine.ts`](src/lib/financial-engine.ts) menggunakan satuan **Sen (`1 Rp = 100n Sen`)** dan berat dalam **Gram (`1 kg = 1000n g`)**.
   - Rumus nilai baris: `round((acceptedGrams * priceSen) / 1000n)`.
   - Pembagian porsi bagi hasil (`splitMarginSen`): porsi Tim dihitung dengan pembulatan *half-up*, dan porsi Koperasi adalah `totalMarginSen - teamSen` sehingga `team + coop === totalMargin` selalu pasti tanpa selisih 1 rupiah pun.

2. **Invarian 2 — Alur *Order-Driven* (Stage 8):**
   - Setiap order dapur (`kitchen_orders`) memiliki baris barang (`kitchen_order_items`), tepat 1 tagihan (`kitchen_invoices`), dan 1 baris buku besar bagi hasil (`profit_ledger_entries`) untuk setiap baris barang.
   - Jika `upsert_order` dipanggil untuk `kitchen_id` dan `order_date` yang sudah memiliki order berstatus `UNPAID`, item baru digabungkan (*merged*) ke order yang ada; jika item sudah ada, kuantitasnya ditambahkan.
   - Setiap perubahan pada item order otomatis menghitung ulang `kitchen_invoices.total_amount_rp` dan nilai bagi hasil pada `profit_ledger_entries` (kecuali baris yang sudah dicairkan penuh).

3. **Invarian 3 — Siklus Hidup Tagihan & Pencairan Bagi Hasil:**
   - Saat invoice berstatus `UNPAID`, seluruh entri bagi hasil terkait berstatus `LOCKED_UNPAID`.
   - Saat Admin menandai invoice **Lunas** (`mark_invoice_paid`):
     - Semua item yang belum ditimbang otomatis diselesaikan dengan `qty_accepted_kg = qty_ordered_kg`.
     - Status order menjadi `BAST_VERIFIED`, status invoice menjadi `PAID` (`amount_paid_rp = total_amount_rp`), dan entri bagi hasil terbuka menjadi `AVAILABLE_FOR_PAYOUT`.
   - Saat Admin mengeksekusi **Pencairan Bagi Hasil** (`execute_payout` untuk `TEAM`, `COOPERATIVE`, atau `BOTH`):
     - Dibuat record batch baru di `profit_payout_batches` untuk masing-masing penerima manfaat yang memiliki saldo siap cair (`> 0`).
     - Kolom `team_paid_out` / `coop_paid_out` beserta `team_payout_batch_id` / `coop_payout_batch_id` dikunci. Jika kedua belah pihak sudah cair, `status` menjadi `PAID_OUT`.

4. **Invarian 4 — Penghapusan Invoice/Order Lunas & Rekonsiliasi Batch Bersih:**
   - Admin dapat menghapus order/invoice (termasuk yang sudah `PAID` / `PAID_OUT`).
   - Penghapusan `kitchen_orders` menghapus bersih `kitchen_order_items`, `kitchen_invoices`, dan `profit_ledger_entries` terkait.
   - Setiap penghapusan wajib menjalankan **rekonsiliasi `profit_payout_batches`**:
     - `total_payout_amount` pada setiap batch dihitung ulang dari jumlah aktual `profit_ledger_entries` yang masih hidup.
     - Batch pencairan yang tidak lagi memiliki `profit_ledger_entries` aktif (`total <= 0` atau yatim) **dihapus bersih** sehingga tidak meninggalkan riwayat pencairan hantu di Tab Bagi Hasil.

5. **Invarian 5 — Keamanan Role & Verifikasi PIN di Edge:**
   - Role `OWNER_ADMIN` wajib terverifikasi melalui PIN (`verify_role_pin` dan header `x-admin-pin` pada setiap mutasi tulis).
   - Verifikasi PIN dilakukan di Cloudflare Worker menggunakan Web Crypto API (`SHA-256` + perbandingan waktu konstan `timingSafeEqual`) terhadap hash di tabel `role_credentials` D1.

---

## 3. Skema Tabel Relasional Cloudflare D1 (`migrations/0001_d1_schema.sql`)

1. `kitchens`: Data master dapur SPPG/MBG (`id`, `code`, `name`, `address`, `pic_name`, `pic_phone`, `default_markup_per_kg`, `is_active`, `created_at`).
2. `products`: Data master komoditas/barang (`id`, `code`, `name`, `category`, `default_kitchen_price_rp`, `default_margin_per_kg_rp`, `is_active`, `created_at`).
3. `kitchen_orders`: Header order pengiriman dapur (`id`, `order_code`, `kitchen_id`, `order_date`, `status`, `bast_signed_by_name`, `bast_verified_at`, `notes`, `created_at`, `updated_at`).
4. `kitchen_order_items`: Rincian barang per order (`id`, `order_id`, `product_id`, `product_name_snapshot`, `qty_ordered_kg`, `qty_accepted_kg`, `kitchen_unit_price_rp`, `margin_per_kg_rp`, `is_weighed`, `weighed_at`, `shrinkage_reason`, `shrinkage_note`, `created_at`, `updated_at`).
5. `kitchen_invoices`: Tagihan dapur 1-ke-1 dengan order (`id`, `invoice_code`, `order_id`, `kitchen_id`, `invoice_date`, `due_date`, `total_amount_rp`, `amount_paid_rp`, `status`, `paid_at`, `supplier_name`, `payment_bank_name`, `payment_account_number`, `payment_account_holder`, `created_at`, `updated_at`).
6. `profit_ledger_entries`: Buku besar bagi hasil 1-ke-1 dengan item order (`id`, `invoice_id`, `order_id`, `order_item_id`, `kitchen_id`, `gross_margin_rp`, `team_share_pct`, `coop_share_pct`, `team_amount_rp`, `coop_amount_rp`, `status`, `team_paid_out`, `coop_paid_out`, `team_payout_batch_id`, `coop_payout_batch_id`, `team_paid_out_at`, `coop_paid_out_at`, `unlocked_at`, `paid_out_at`, `created_at`, `updated_at`).
7. `app_settings`: Pengaturan global porsi bagi hasil & rekening pembayaran (`id = 'default'`, `team_share_pct`, `coop_share_pct`, `supplier_name`, `payment_bank_name`, `payment_account_number`, `payment_account_holder`, `updated_at`).
8. `profit_payout_batches`: Riwayat pencairan bagi hasil (`id`, `payout_reference`, `beneficiary_type`, `total_payout_amount`, `transfer_proof_url`, `notes`, `disbursed_by`, `disbursed_at`, `created_at`).
9. `role_credentials`: Kredensial PIN role terenkripsi SHA-256 (`role`, `pin_sha256`, `updated_at`).

---

## 4. Kontrak Endpoint Worker (`src/worker.ts`)

- **`GET /api/hyperdrive`** (dipertahankan untuk kompatibilitas penuh klien):
  - Membaca snapshot `MbgData` dari Edge Cache (`caches.default`) atau **Cloudflare D1 (`env.DB`)** dalam 1 batch round-trip.
  - Mendukung `If-None-Match` (`304 Not Modified`), `?fresh=1`, dan `?etag=<expectedEtag>` (bypass cache PoP jika stale).
- **`POST /api/hyperdrive`**:
  - Mengeksekusi seluruh mutasi (`verify_role_pin`, `upsert_order`, `update_order`, `mark_invoice_paid`, `execute_payout`, `update_app_settings`, `delete_order_item`, `delete_order`, `upsert_kitchen`, `delete_kitchen`, `upsert_product`, `delete_product`) secara atomik di **Cloudflare D1**.
  - Mengembalikan `{ ok: true, ..., etag, snapshot }` dan mendorong `snapshot` ke seluruh klien via `MbgSyncHub` WebSocket (`/api/ws`).
- **`GET /api/ws`**:
  - Upgrade WebSocket ke Durable Object `MbgSyncHub` (WebSocket Hibernation API).
- **`GET / POST /api/apk/version`**:
  - Membaca & memperbarui manifest rilis APK Android di SQLite `MbgSyncHub`.
- **`GET / POST /api/documents`**:
  - Mengunggah & menyajikan dokumen BAST / bukti transfer / APK dari bucket **Cloudflare R2 (`env.MBG_STORAGE`)**.
