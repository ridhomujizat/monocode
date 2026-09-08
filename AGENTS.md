# AGENTS.md

Fork MonoCode, branch `workspace-plugins`. Upstream: `hardbeat920/monocode`.

Baca `CONTRIBUTING.md` untuk peta repo, cara menjalankan, dan aturan PR. File ini
tidak mengulanginya — isinya hanya pekerjaan yang sedang berjalan.

## Gate

```bash
npm run check     # vitest + tsc --noEmit + cargo fmt + cargo clippy + cargo test
```

Hijau = boleh lapor selesai. Jalankan sendiri. `check:web` / `check:rust` untuk
setengahnya saja kalau cuma satu sisi yang disentuh.

---

## Pekerjaan aktif: MonoCode Remote

Akses remote dari HP untuk memantau dan menyetir agent yang sedang berjalan, tanpa
mengekspos laptop ke internet. Laptop dial keluar ke relay di VM milik sendiri; HP
juga dial keluar ke relay yang sama.

**Spec lengkap ada di vault, bukan di repo ini:**

```
/Users/ridho/Documents/ridho-note/10 Projects/Personal/Monocode Remote/
├── Monocode Remote.md      ringkasan proyek
├── Agent Handoff.md        ← ANTRIAN TASK. Mulai dari sini.
├── prd/     PD-0001..0003  apa & kenapa
├── adr/     0001..0004     keputusan + tradeoff
└── diagram/ 01..03         mermaid: context, pairing, stream
```

**Antrian**: T0 → T9 di `Agent Handoff.md`. Satu task = satu sesi = satu commit.
Nomor ADR **bukan** urutan kerja — pemetaan ADR ke task ada di file itu.

**Posisi sekarang**: belum mulai. Task berikutnya **T0** (spike).

### Dua fakta yang menentukan desainnya

Salah paham soal dua hal ini menghasilkan arsitektur yang salah:

1. **Rust di sini hanya process supervisor.** `harness_spawn` memuntahkan
   `harness-stdout` mentah dan `blocks_json` cuma kolom TEXT buram. Yang mengubahnya
   jadi block, tool call, dan approval adalah adapter di `src/lib/harness/*Protocol.ts`
   (~3.500 baris, 6 provider). Server yang ditempel ke Rust hanya bisa streaming byte.
   Karena itu bridge remote adalah **modul frontend**. Selengkapnya di ADR 0002.
2. **State sesi ada di `App.tsx`** sebagai `useState<Session[]>` (sekitar baris 575),
   dengan `sessionsRef.current` yang disinkronkan tiap render (~baris 671). Pola store
   eksternal yang sudah dipakai repo ini ada di `src/lib/paneDrop.ts`. Menyambung
   bridge ke state cukup satu `useEffect` — bukan refactor.

### Aturan keras untuk pekerjaan ini

- **Jangan sentuh `src/lib/harness/*`.** Adapter dan protocol dipakai apa adanya.
  Seluruh desain bertumpu pada itu tidak berubah.
- **Baca spec dulu.** Tiap task menyebut file ADR/diagram yang harus dibaca sebelum
  menulis kode. Jangan mulai dari kode.
- **Spec bentrok dengan kode? BERHENTI dan laporkan.** Jangan menebak, jangan
  menambal diam-diam. Perbedaan itu temuan yang bernilai, bukan hambatan.
- **Fitur harus inert saat remote disabled**: tidak ada socket terbuka, tidak ada
  perilaku app yang berubah, tidak ada biaya saat startup.
- **Intent remote wajib memanggil fungsi yang sama dengan UI desktop.** Kalau sebuah
  intent terasa butuh salinan jalur kodenya sendiri, seam-nya salah tempat — lapor,
  jangan salin.
- **Jangan tambah dependency** tanpa menyebut alasannya di ringkasan akhir.
- Diff sekecil mungkin. Tidak ada abstraksi untuk kebutuhan yang belum ada.

### Yang sengaja ditunda

Jangan kerjakan tanpa diminta, semuanya sudah dicatat sebagai `ponytail:` di spec:
enkripsi end-to-end isi frame, Web Push/VAPID, memulai sesi baru dari HP, edit file
/ git / terminal di mobile, dan cross-window lock.

### Kredensial

`monocode.db` akan menyimpan kolom kredensial pertamanya (`remote_config`). Jangan
pernah mencatat isinya ke log, ringkasan, atau pesan error — termasuk saat gagal.

---

## Fork dan sinkronisasi dari upstream

Repo ini fork dari **https://github.com/hardbeat920/monocode**. Upstream masih aktif
dan pemilik repo ini rutin menarik update darinya.

```
origin    https://github.com/ridhomujizat/monocode.git   ← fork ini
upstream  https://github.com/hardbeat920/monocode.git    ← repo asli
```

Pola yang dipakai selama ini adalah **merge, bukan rebase**, ke branch fitur:

```bash
git fetch upstream
git merge upstream/main        # bukan rebase — riwayat merge sudah terlanjur begini
```

Jangan mengubah pola ini jadi rebase. Branch fitur sudah dipublikasikan ke `origin`,
dan riwayatnya penuh commit merge dari upstream.

### Konsekuensi untuk pekerjaan MonoCode Remote

Setiap merge dari upstream berpotensi bentrok. Yang menentukan seberapa sakit adalah
file mana yang disentuh:

| Aman — tidak pernah bentrok | Rawan — upstream sering mengubahnya |
|-----------------------------|--------------------------------------|
| `src/lib/remote/` (baru) | `src/App.tsx` — 5.750 baris, paling sering berubah |
| `mobile/` (baru) | `src-tauri/src/lib.rs` — daftar `invoke_handler` |
| `relay/` (baru) | `src-tauri/tauri.conf.json` |
| `AGENTS.md`, `CLAUDE.md` | `src/surfaces/SettingsView.tsx` |
| | `src-tauri/src/session_store.rs` |

Ini alasan sebenarnya di balik aturan "maksimal 3–5 baris di `App.tsx`" yang ada di
task queue: bukan soal kerapian, tapi supaya merge berikutnya dari upstream tidak
berubah jadi pekerjaan konflik. Taruh logika di `src/lib/remote/`, sisakan sesedikit
mungkin di file bersama.

Untuk file rawan, kumpulkan perubahan dalam **satu blok berurutan** dan beri penanda
komentar (`// monocode-remote: …`) di awal dan akhir. Konflik tetap mungkin terjadi,
tapi jadi jelas dan mekanis untuk diselesaikan.

Setelah setiap merge dari upstream: jalankan `npm run check` sebelum melanjutkan task
apa pun. Kalau merah karena upstream, perbaiki itu dulu sebagai commit terpisah.

### Arahnya satu: tarik saja, jangan pernah kirim

Fork ini untuk kebutuhan pribadi. **Tidak ada kontribusi balik ke upstream — sama
sekali, bukan cuma untuk MonoCode Remote.** Jangan buka PR ke `hardbeat920/monocode`,
jangan `git push upstream`, jangan susun commit "supaya rapi kalau nanti di-upstream".
Tidak akan ada nanti.

Yang tetap dilakukan: menarik update terbaru dari upstream secara rutin, karena repo
asli masih aktif dan perbaikannya berguna.

> Catatan: remote `upstream` masih punya push URL aktif. Untuk mematikan footgun itu:
> `git remote set-url --push upstream DISABLED`

### Resolusi konflik: yang di sini menang

Kalau merge dari upstream bentrok, bedakan dulu dua kasusnya — ini yang paling sering
salah:

**1. Fitur yang sama, dua-duanya mengerjakan.** Upstream menulis fitur yang sudah ada
versinya di sini. → **Versi lokal yang menang.** Jangan ganti dengan versi upstream.

Tapi jangan buang versi upstream diam-diam. Laporkan dulu:
- fitur apa yang tumpang tindih
- apa bedanya pendekatan upstream dari yang di sini
- ada tidak yang upstream tangani tapi versi lokal belum (edge case, bug fix, platform)

Lalu **konfirmasi ke pemilik repo** sebelum menyelesaikan konflik. Kadang upstream
menangani sesuatu yang layak diambil sebagian — itu keputusannya, bukan keputusan agent.

**2. File yang sama, urusan berbeda.** Upstream memperbaiki bug di fungsi yang tidak
disentuh di sini, tapi kebetulan sefile. → **Ambil dua-duanya**, merge biasa. Ini justru
alasan kenapa sync dilakukan. Jangan pakai "yang lokal menang" sebagai alasan menolak
perbaikan upstream yang tidak tumpang tindih dengan apa pun.

Aturan singkatnya: **utamakan lokal saat fiturnya bertabrakan, terima upstream saat
tidak.** Ragu masuk kasus yang mana? Itu tanda harus bertanya, bukan tanda harus memilih.

Jangan pernah `git checkout --ours .` atau `--theirs .` borongan di seluruh direktori.
Selesaikan per konflik dengan alasan yang bisa disebutkan.
