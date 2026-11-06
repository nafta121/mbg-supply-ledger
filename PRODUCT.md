# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

1. **Admin Supplier MBG (`OWNER_ADMIN`):** Staf operasional dan keuangan supplier bahan baku Program Makan Bergizi Gratis (MBG) yang menginput order bahan pangan harian per Dapur SPPG, merekonsiliasi berat diterima (BAST), menerbitkan dan menandai pelunasan invoice gabungan, mencairkan bagi hasil margin, serta mengelola data master dapur, barang, dan rekening pembayaran.
2. **Pengurus Koperasi (`COOPERATIVE_VIEWER`):** Mitra koperasi yang memantau transparansi tagihan invoice dapur, status pelunasan, rincian margin per kilogram, serta akumulasi dan riwayat pencairan bagi hasil porsi Koperasi secara *read-only*.

## Product Purpose

**MBG Supply Chain Ledger (`MBG Ledger`)** adalah buku besar operasional rantai pasok B2B antara Supplier Bahan Baku MBG, Dapur SPPG, dan Mitra Koperasi. Produk ini ada untuk menghilangkan selisih hitung manual antara pesanan awal, berat timbangan serah terima (BAST), tagihan dapur, dan pembagian margin bersih antara Tim Operasional dan Koperasi. Keberhasilan diukur dari kecepatan input order harian di perangkat seluler/desktop (`0 ms` *optimistic UI*), keakuratan tagihan Rupiah tanpa selisih pembulatan, serta kejelasan audit dana bagi hasil yang siap dicairkan maupun yang masih menunggu pelunasan dapur.

## Positioning

Satu-satunya buku besar operasional SPPG-Koperasi yang mengikat **Order Bahan Baku $\rightarrow$ Timbangan BAST (`kg`) $\rightarrow$ Invoice Gabungan Dapur $\rightarrow$ Kunci Bagi Hasil Otomatis (`60:40`)** dalam satu rantai transaksi atomik di PostgreSQL: tagihan hanya dihitung dari berat diterima (`qty_accepted_kg`), bagi hasil terkunci otomatis (`LOCKED_UNPAID`) hingga invoice dilunasi (`PAID`), dan seluruh mutasi terkunci permanen begitu invoice lunas atau bagi hasil telah dicairkan (`PAID_OUT`).

## Operating Context

- Digunakan setiap hari kerja oleh Admin Supplier di gudang/kantor dan Pengurus Koperasi melalui browser HP Android/iOS (PWA) di jaringan seluler 4G maupun layar desktop.
- Satu order dapur per tanggal pengiriman menggabungkan seluruh item bahan baku ke dalam satu Surat Jalan (`SJ-...`) dan satu Invoice Dapur (`INV-...`).
- Tagihan dikirimkan langsung ke WhatsApp PIC Dapur SPPG menggunakan format pesan terstruktur satu klik (*Salin & WA*) atau dicetak sebagai dokumen PDF/kertas A4 ([`src/components/PrintDocuments.tsx`](src/components/PrintDocuments.tsx)).
- Pergantian peran ke `Admin` dilindungi verifikasi PIN 4 digit di sisi server (`rpc_verify_role_pin`) yang diteruskan pada setiap mutasi melalui Cloudflare Worker + Hyperdrive.

## Capabilities and Constraints

- **Invarian 1 (Satuan Terkunci `kg`):** Seluruh kuantitas barang wajib menggunakan satuan kilogram (`kg`) dengan dukungan presisi hingga 3 desimal (gram, dibulatkan `roundKg`) dan aritmetika integer gram/sen (`BigInt`) bebas galat *floating-point* ([`src/lib/financial-engine.ts`](src/lib/financial-engine.ts)).
- **Invarian 2 & 3 (Snapshot Harga & Tagihan BAST):** Harga dapur per `kg` dan margin per `kg` di-*snapshot* pada setiap baris order saat dibuat; nilai tagihan baris selalu `qty_accepted_kg × kitchen_unit_price_snapshot` dengan pembulatan `HALF_UP`.
- **Invarian 4 (Kunci Siklus Bagi Hasil):** Porsi bagi hasil (default Tim `60%` : Koperasi `40%`, jumlah wajib `100%`) berstatus `LOCKED_UNPAID` saat invoice belum dibayar, otomatis terbuka menjadi `AVAILABLE_FOR_PAYOUT` saat invoice ditandai `LUNAS`, dan berstatus `PAID_OUT` setelah dicairkan (baik per pihak maupun sekaligus).
- **Invarian 5 (Proteksi Mutasi & Histori):** Baris order, order, atau invoice yang sudah berstatus `PAID` atau memiliki bagi hasil `PAID_OUT` terkunci dari penghapusan, serta dapur/barang yang memiliki histori order tidak dapat dihapus.
- **Arsitektur Edge-First:** Frontend Next.js (Static Export PWA) disajikan oleh Cloudflare Workers (`src/worker.ts`) dengan koneksi tunggal Hyperdrive (`src/lib/hyperdrive.ts`) ke Supabase PostgreSQL (`ap-southeast-1`), didukung *Optimistic UI Commit* (`0 ms`), *Single-Hop Mutation Snapshot*, dan *Stale-While-Revalidate* (`sessionStorage`).

## Brand Commitments

- **Identitas aplikasi:** `MBG Ledger` (Bahasa Indonesia operasional B2B yang lugas, ringkas, dan bebas jargon teknis).
- **Terminologi baku:** `Order Dapur`, `Invoice Dapur`, `Bagi Hasil`, `Belum Bayar` / `Lunas`, `Tahan` / `Siap Cair` / `Cair`, `Harga Dapur / kg`, `Margin / kg`, `Hak Tim`, `Hak Koperasi`.

## Evidence on Hand

- Kode produksi dan mesin kalkulasi finansial: [`src/lib/financial-engine.ts`](src/lib/financial-engine.ts), [`src/lib/order-engine.ts`](src/lib/order-engine.ts), [`src/lib/invoice-view.ts`](src/lib/invoice-view.ts).
- Antarmuka *workbench* 3 tab dan modal: [`src/components/AppShell.tsx`](src/components/AppShell.tsx), [`src/components/Tab1KitchenOrders.tsx`](src/components/Tab1KitchenOrders.tsx), [`src/components/Tab3KitchenInvoices.tsx`](src/components/Tab3KitchenInvoices.tsx), [`src/components/Tab4ProfitSharing.tsx`](src/components/Tab4ProfitSharing.tsx), [`src/components/OrderInvoiceEditSheet.tsx`](src/components/OrderInvoiceEditSheet.tsx), [`src/components/MasterDataSheet.tsx`](src/components/MasterDataSheet.tsx).
- Skema dan prosedur RPC PostgreSQL: [`supabase/migrations/`](supabase/migrations) (`0001`–`0013`) dan suite pengujian [`src/lib/__tests__/`](src/lib/__tests__) (54 unit test).
- Sistem token desain terkunci di [`design.md`](design.md) dan [`src/app/tokens.css`](src/app/tokens.css).
- Jangan pernah menambahkan metrik fiktif, klaim pelanggan palsu, atau testimoni buatan.

## Product Principles

1. **Kebenaran Angka di Atas Segalanya:** Setiap angka Rupiah dan kilogram di layar, cetakan PDF, dan pesan WhatsApp harus berasal dari *snapshot* transaksi yang sama tanpa selisih satu Rupiah pun.
2. **Kecepatan Operasional Lapangan (`0 ms` Perceived Latency):** Input berulang oleh Admin dan pengecekan saldo oleh Koperasi harus merespons seketika di jaringan seluler tanpa menahan alur kerja dengan *modal* atau *toast* yang tidak perlu.
3. **Keterbacaan Buku Besar (*Tabular Clarity*):** Kepadatan informasi dijaga tetap rapi melalui baris ringkasan *accordion* yang dapat dibuka-tutup, kesejajaran angka `tabular-nums`, dan pemisahan jelas antara dana tertahan vs dana siap cair.
4. **Pengamanan Status Transaksi:** Status pembayaran dan pencairan mengendalikan aksi apa yang boleh dilakukan; data yang sudah lunas atau cair terlindung dari perubahan tidak sengaja baik di UI maupun di database.

## Accessibility & Inclusion

- Standar kontras minimal WCAG 2.1 AA pada seluruh teks fungsional, *badge* status (`Lunas`, `Belum Bayar`, `Siap Cair`, `Cair`), dan kontrol form di bawah pencahayaan luar ruangan/gudang.
- Seluruh kontrol interaktif mendukung navigasi papan ketik (`:focus-visible` instan), atribut ARIA semantik (`aria-expanded`, `aria-pressed`, `role="dialog"`), target sentuh memadai di layar seluler, serta mematuhi `prefers-reduced-motion: reduce`.
