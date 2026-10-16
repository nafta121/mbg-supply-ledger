Lakukan penyesuaian arsitektur dan bangun fondasi kode inti (Database Migration + Financial Calculation Engine + Automated Tests) dengan langkah berikut:

1. **Update Tech Stack di `AGENTS.md` & `docs/03-mobile-ux-and-batch-screens.md`:**
   - Karena pengembangan dan pengujian dijalankan langsung di lingkungan Linux ARM64 mobile container, ganti referensi frontend dari **Flutter** menjadi **Next.js (App Router) + TypeScript (`strict: true`) + Tailwind CSS (Mobile-First PWA) + Supabase (PostgreSQL)**.
   - Pertahankan 100% seluruh 5 Invariant Bisnis, rumus di `docs/01-domain-workflows-and-formulas.md`, dan seluruh DDL SQL / Trigger / View di `docs/02-database-schema-and-rls.md`.

2. **Ekstrak DDL SQL ke File Migrasi Resmi (`supabase/migrations/0001_initial_mbg_schema.sql`):**
   - Salin dan rapikan seluruh kode SQL dari `docs/02-database-schema-and-rls.md` (12 tabel utama, trigger `fn_populate_supplier_cost_snapshot`, `fn_sync_invoice_payment_to_profit_ledger`, `fn_guard_profit_ledger_transition`, RLS policies, dan view `v_safe_delivery_items_bast`) ke dalam file `supabase/migrations/0001_initial_mbg_schema.sql` agar siap dieksekusi di Supabase.

3. **Inisialisasi Struktur Proyek TypeScript & Financial Engine:**
   - Buat `package.json` dan `tsconfig.json` untuk proyek Next.js + TypeScript + Tailwind CSS + Vitest (gunakan dependency minimal yang ringan dan cepat di-install di ARM64).
   - Buat `src/types/mbg.ts` yang merepresentasikan ke-12 tabel dan view `v_safe_delivery_items_bast` secara strict.
   - Buat `src/lib/financial-engine.ts` menggunakan aritmatika presisi (konversi ke integer gram `1 kg = 1000 gr` dan integer sen/rupiah agar bebas dari galat floating-point IEEE 754) yang mencakup:
     a) `reconcileKitchenDeliveryItem`: Menghitung `qty_shrinkage_kg = qty_dispatched_kg - qty_accepted_kg` (validasi tidak boleh negatif), `kitchen_line_total`, `supplier_gross_payable`, `supplier_shrinkage_deduction`, dan `supplier_net_payable` (`qty_accepted_kg * supplier_actual_cost_snapshot`).
     b) `calculateProfitSplitEntry`: Menghitung `total_markup = qty_accepted_kg * (kitchen_unit_price_snapshot - supplier_actual_cost_snapshot)`, porsi Tim (`team_share_amount`), porsi Koperasi (`koperasi_share_amount`), dan mengunci status di `LOCKED_UNPAID` hingga status invoice menjadi `PAID` (`AVAILABLE_FOR_PAYOUT`).
     c) `sanitizeDeliveryForFieldTeam`: Fungsi filter sesuai `v_safe_delivery_items_bast` yang menghapus seluruh atribut harga beli supplier, harga jual, dan markup untuk role `FIELD_TEAM`.

4. **Buat & Jalankan Unit Tests (`src/lib/__tests__/financial-engine.test.ts`):**
   - Uji skenario simulasi nyata yang ada di `docs/01-domain-workflows-and-formulas.md` (pengiriman ke 5 dapur dari 2 batch supplier berbeda, susut 3.000 kg yang memotong tagihan supplier, rekonsiliasi invoice dapur, dan transisi status bagi hasil `LOCKED_UNPAID` -> `AVAILABLE_FOR_PAYOUT` saat invoice `PAID`).
   - Jalankan test menggunakan Vitest dan pastikan seluruh test PASS 100%.
