# Changelog — MBG Supply Chain & Profit-Sharing Ledger

Seluruh perubahan penting pada arsitektur, fitur, dan optimalisasi aplikasi dicatat dalam dokumen ini.

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
