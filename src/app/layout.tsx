import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MBG B2B Supply Chain, Invoicing & Profit-Sharing Ledger',
  description:
    'Sistem Pengadaan Batch Supplier, Matriks Alokasi 25 Dapur MBG/SPPG, BAST Susut Supplier, Invoice Dapur, dan Ledger Bagi Hasil Cash-Basis Tim vs Koperasi',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="id" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-[100dvh] bg-[#070A10] text-slate-100 font-sans antialiased">
        {/* Fixed subtle tactile grain overlay (pointer-events-none, zero scroll repaint) */}
        <div
          aria-hidden="true"
          className="no-print pointer-events-none fixed inset-0 z-40 opacity-[0.022]"
          style={{
            backgroundImage: `radial-gradient(rgba(255,255,255,0.7) 1px, transparent 0)`,
            backgroundSize: '20px 20px',
          }}
        />
        {children}
      </body>
    </html>
  );
}
