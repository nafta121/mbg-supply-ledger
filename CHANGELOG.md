# Changelog — MBG Supply Chain & Profit-Sharing Ledger

Seluruh perubahan penting pada arsitektur, fitur, dan optimalisasi aplikasi dicatat dalam dokumen ini.

---

## [2.3.0] — 2026-11-12 — Tahap 3 Audit Hardening (Pengamanan UX, Target Sentuh Mobile, & Pemangkasan Kode Mati)

- **[UX Safety — Hallmark & Impeccable] Konfirmasi 2-Langkah Inline untuk Aksi Destruktif (`src/components/Tab1KitchenOrders.tsx`, `src/components/Tab3KitchenInvoices.tsx`):** Menambahkan bar konfirmasi 2-langkah inline (`Ya, Hapus` / `Batal`) sebelum mengeksekusi `Hapus Order` di Tab 1 dan `Hapus Invoice` di Tab 3 agar tidak terpicu tidak sengaja saat menggulir di layar sentuh.
- **[Mobile Touch Targets & Reduced Motion] Target Sentuh Nyaman & `prefers-reduced-motion` (`src/components/AppShell.tsx`, `src/components/Tab1KitchenOrders.tsx`, `src/components/ui.tsx`, `src/app/base.css`, `src/app/globals.css`):** Memperbesar area sentuh tombol aksi sekunder/tutup (`min-h-[38px]`–`40px`) serta membatasi transformasi tekan tombol (`translateY(1px)`) hanya pada `@media (prefers-reduced-motion: no-preference)`.
- **[Lean Code — Ponytail] Pemangkasan Fallback Dead Code & Penyelarasan Teks UI (`src/lib/supabase-sync.ts`, `src/components/MasterDataSheet.tsx`, `src/lib/__tests__/hyperdrive.test.ts`):** Menghapus ~180 baris cabang fallback mati `supabase.rpc` / `supabase.from` / `supabase.channel` di `src/lib/supabase-sync.ts`, memperbarui pesan notifikasi UI dari `"Supabase"` menjadi `"Cloudflare D1"`, serta menambahkan pengujian unit D1 untuk `delete_order_item`.

---

## [2.2.0] — 2026-11-10 — Tahap 2 Audit Hardening (Performa Edge, Caching Immutable, Tipografi Geist, & Smart Placement)

- **[Web-Perf & Cloudflare] Immutable Caching untuk Aset Statis (`public/_headers`):** Menambahkan aturan `Cache-Control: public, max-age=31536000, immutable` pada `/_next/static/*` dan `/fonts/*` serta `stale-while-revalidate` pada ikon PWA agar tidak memicu revalidasi jaringan pada pemuatan berulang.
- **[Theming & Web-Perf] Self-Hosted Variable Fonts `Geist` & `Geist Mono` (`public/fonts/`, `src/app/tokens.css`, `src/app/layout.tsx`, `public/sw.js`):** Menyediakan file font variabel `Geist-Variable.woff2` dan `GeistMono-Variable.woff2` secara lokal dengan `@font-face` (`font-display: swap`), `<link rel="preload">`, dan precache Service Worker `v4` sehingga tipografi *Warm Archival Ledger* tampil instan dan 100% bekerja saat offline.
- **[Cloudflare Best Practices] Smart Placement, Durable Object RPC, & Edge Cache TTL (`wrangler.toml`, `src/worker.ts`, `package.json`):** Mengaktifkan `[placement] mode = "smart"`, menambahkan pemanggilan method langsung `broadcastMutation()` pada `MbgSyncHub`, menaikkan `SNAPSHOT_CACHE_TTL_SECONDS` dari `5` ke `60` detik, serta menambahkan `browserslist` modern.

---

## [2.1.0] — 2026-11-10 — Tahap 1 Audit Hardening (Keamanan, Presisi Sen `BigInt`, & Skala D1/R2)

- **[Security] Autentikasi `GET /api/documents` (`src/worker.ts`):** Menutup akses publik tanpa autentikasi pada daftar dan unduhan dokumen BAST/bukti transfer dengan mewajibkan verifikasi PIN (`OWNER_ADMIN` atau `COOPERATIVE_VIEWER`).
- **[Security] Salted SHA-256 PIN & Penghapusan Plaintext PIN (`src/lib/hyperdrive.ts`, `migrations/0002_security_hardening.sql`):** Menggunakan hash ber-*salt* (`<ROLE>:mbg-pin-v1:<PIN>`) pada `role_credentials` (dengan auto-upgrade transparan dari hash lama) serta mengosongkan kolom plaintext `admin_pin` dan `coop_pin` di `app_settings`.
- **[Security & Scale] Persistensi Rate-Limit PIN & Idempotensi Mutasi di D1 (`src/lib/hyperdrive.ts`):** Mem-backup state pembatas percobaan PIN (`security_rate_limits`) dan deduplikasi `clientMutationId` (`mutation_idempotency_log`) ke tabel D1 agar konsisten lintas *isolate* Cloudflare Workers.
- **[Bug & Precision] Penyatuan Perhitungan Bagi Hasil D1 ke `BigInt` Sen (`src/lib/hyperdrive.ts`, `src/lib/financial-engine.ts`):** Mengganti pembulatan `Math.round` floating-point pada `recalculateOrderFinancialsD1` dengan `calculateProfitSplitEntry` (`divideHalfUp` berbasis Sen `BigInt`) dan memanggil `reconcilePayoutBatchesD1` saat item dihapus melalui `update_order`.
- **[Scale] Optimasi `update_app_settings` Menjadi `O(1)` Batch D1 (`src/lib/hyperdrive.ts`):** Mengganti loop `2 × N` query berurutan per order terbuka menjadi 1 batch baca + 1 batch tulis atomik (`db.batch`).
- **[Cloudflare DO & R2] Deduplikasi Blob SQLite DO & Pembersihan Objek R2 (`src/worker.ts`):** Tidak menduplikasi string Base64 hingga 2 MB di SQLite Durable Object saat penyimpanan ke R2 (`MBG_STORAGE`) berhasil, serta menghapus objek di R2 saat `DELETE /api/documents` dipanggil.
- **[Bug] Penanganan `action` Tidak Dikenal (`src/lib/hyperdrive.ts`):** Menambahkan cabang `default:` pada `executeD1Action` dan `executeHyperdriveAction` agar mengembalikan error terstruktur tanpa melempar `TypeError`.

---

## [2.0.0] — 2026-11-06 — Migrasi Penuh ke 100% Full Cloudflare Stack (D1 + Workers + Durable Objects + R2)

### Tahapan Migrasi Bertahap
1. **Fase 1 — Dokumentasi Arsitektur & Kontrak Domain (`CONTEXT.md` & `CHANGELOG.md`):**
   - Menetapkan spesifikasi invarian bisnis, skema tabel SQLite D1, dan kontrak endpoint API agar tidak ada perubahan perilaku bisnis selama pelepasan Supabase.
2. **Fase 2 — Provisioning Cloudflare D1 & R2 + Migrasi Skema & Data Produksi:**
   - Membuat database Cloudflare D1 (`mbg-supply-ledger-db`) dan bucket Cloudflare R2 (`mbg-supply-ledger-files`).
   - Menerapkan skema SQLite `migrations/0001_d1_schema.sql` dan memigrasikan seluruh data produksi aktif (dapur, produk, order, item order, invoice, ledger bagi hasil, batch pencairan, pengaturan aplikasi, dan kredensial PIN).
3. **Fase 3 — Engine Transaksi D1 Atomik (`src/lib/hyperdrive.ts` & `src/worker.ts`):**
   - Mengganti driver TCP `postgres` dan PL/pgSQL RPC dengan eksekusi batch atomik Cloudflare D1 (`env.DB.batch([...])`) + mesin aritmetika `BigInt` Sen (`src/lib/financial-engine.ts`) dan Web Crypto API (`crypto.subtle`) untuk verifikasi PIN.
4. **Fase 4 — Penyederhanaan Frontend Sync Layer (`src/lib/supabase-sync.ts`) & Pelepasan SDK Eksternal:**
   - Menghapus jalur fallback PostgREST/Realtime Supabase (`@supabase/supabase-js` & `postgres`) sehingga seluruh operasi baca/tulis dan WebSocket real-time (`MbgSyncHub`) berjalan 100% di atas jaringan Cloudflare.
5. **Fase 5 — Verifikasi Test Suite, Build, & Cutover Produksi (`https://mbg.letsgrow.web.id`):**
   - Memastikan seluruh unit test (`vitest`), pemeriksaan tipe (`tsc --noEmit`), dan deployment produksi berjalan tanpa regresi.

---

## [1.4.0] — 2026-11-06 — Hardening Sinkronisasi Real-Time Zero-Latency (`65b5f93`)
- **Zero-Latency WebSocket State Push (`0ms`):** Menyertakan `snapshot` otoritatif langsung di dalam frame WebSocket `MbgSyncHub` (`/api/ws`) sehingga perangkat lain langsung memperbarui UI tanpa jeda debounce `250ms` dan tanpa HTTP GET tambahan.
- **Penghapusan Echo Guard `2500ms`:** Mengganti pemblokiran waktu `2.5s` di `mbg-store.ts` dengan deduplikasi berbasis `ETag`.
- **Bypass Stale Cache Lintas PoP (`?etag=`):** Memastikan fallback `GET /api/hyperdrive?etag=...` selalu melewati cache lokal PoP apabila ETag belum mutakhir.
- **Pembersihan Offline Outbox Konflik & Rekonsiliasi Batch Tunggal:** Menghapus `mbg_offline_outbox_v1` yang berbenturan dengan optimistic rollback dan menyatukan logika pembersihan batch pencairan.

---

## [1.3.0] — 2026-11-06 — Implementasi 4 Pilar Optimalisasi Cloudflare Edge (`a710f1d`)
- **Durable Object `MbgSyncHub` (SQLite + WebSocket Hibernation):** Koordinasi WebSocket real-time `/api/ws`, penyimpanan idempotency key `clientMutationId`, dan manifest rilis APK `/api/apk/version`.
- **Workers Static Assets Routing (`run_worker_first = ["/api/*"]`):** Aset statis disajikan langsung oleh CDN Edge tanpa membangunkan Worker.
- **PWA Service Worker `v3` & Endpoint Dokumen R2 (`/api/documents`).**

---

## [1.2.0] — 2026-11-06 — Fitur Hapus Invoice Lunas & Pembersihan Riwayat Pencairan (`621968f`)
- Menambahkan fitur hapus invoice yang sudah lunas khusus Admin dengan rekonsiliasi penuh pada `profit_payout_batches` di frontend dan backend.
