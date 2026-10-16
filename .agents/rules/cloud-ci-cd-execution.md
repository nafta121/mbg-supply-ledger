---
trigger: always_on
description: Larangan mutlak menjalankan npm/node lokal di Termux; seluruh build, test, dan deploy ditangani GitHub Actions & Vercel.
---

# Cloud-Offloaded CI/CD & Execution Rule (Zero Local NPM)

1. **DILARANG KERAS Menjalankan Perintah Node/NPM Lokal:**
   - JANGAN PERNAH menjalankan `npm install`, `npm ci`, `npm test`, `npm run build`, `npm run dev`, `npm run typecheck`, `npx`, atau `vitest` di terminal lokal.
   - Tambahkan package yang dibutuhkan langsung ke `package.json` secara deklaratif.
2. **GitHub Actions & Vercel sebagai Mesin Build Utama:**
   - Setelah selesai menulis/mengubah kode, cukup jalankan `git add .`, `git commit -m "..."`, dan `git push origin main`.
