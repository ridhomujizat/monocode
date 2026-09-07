# Workspace plugins

Satu plugin = satu menu di rail (di bawah **Notes**) + satu workspace
full-screen. Ada dua jenis:

| Jenis        | Bentuk                                      | Install                |
| ------------ | ------------------------------------------- | ---------------------- |
| **Built-in** | `src/plugins/<id>/index.tsx` (React)        | drop folder → rebuild  |
| **User**     | `<appData>/plugins/<id>/plugin.json` (JSON) | runtime, tanpa rebuild |

Panduan lengkap format JSON untuk user/AI: **`docs/plugins-for-ai.md`**.

## Built-in plugin

```
src/plugins/<id>/index.tsx   → default export Plugin
```

```ts
export type Plugin = {
  id: string; // [a-z0-9-], dipakai juga sebagai nama folder config
  label: string; // label di rail
  icon: IconComponent; // dari src/chrome/icons.tsx
  Workspace: ComponentType<PluginHost>;
};
```

`src/plugins/registry.ts` mengumpulkannya lewat `import.meta.glob` (fitur
Vite, eager). Drop folder → menu muncul. Hapus folder → hilang. Tidak ada
daftar registrasi yang perlu diedit.

## User plugin (manifest)

`plugin.json` adalah **data, bukan script** — CSP webview (`script-src 'self'`,
`frame-src 'none'`) menutup jalan memuat kode pihak ketiga saat runtime. Jadi
manifest hanya mendeklarasikan request + cara melabeli hasilnya, lalu
`ManifestWorkspace` yang merender: form connect → list → klik → masuk chat.

Validasi bentuknya ada di `src/plugins/manifest.ts` (pesan error-nya ditujukan
ke penulis manifest, tampil di Settings). Rust tetap menjaga batas
filesystem-nya: id divalidasi lagi, skema URL harus `http`/`https`.

## Yang host sediakan (`PluginHost`)

| Prop                      | Kegunaan                                                             |
| ------------------------- | -------------------------------------------------------------------- |
| `cwd`                     | project aktif, kalau plugin mau scoping per repo                     |
| `addToChat(title, body)`  | kirim hasil ke composer sebagai chip berbentuk note, di session baru |
| `request({method,url,…})` | HTTP lewat Rust (`plugin_fetch`)                                     |
| `loadConfig()`            | baca config plugin (JSON, 1 file per plugin)                         |
| `saveConfig(config)`      | tulis config, mode `0600` — tempat menyimpan API token               |

Plugin **tidak** import apa pun dari App/Sidebar. Header overlay (tombol back,
toggle sidebar, window controls) sudah diberikan `PluginSurface`; plugin hanya
mengisi badannya.

### Kenapa HTTP harus lewat Rust

CSP webview: `connect-src ipc:` saja. `fetch()` ke host luar diblokir browser.
Jadi ada satu command generik di `src-tauri/src/plugins.rs` (ureq, timeout 30s,
body dibatasi 8 MB, hanya skema `http`/`https`) yang dipakai semua plugin —
bukan satu modul Rust per integrasi.

## UI: Settings → Plugins

Satu section berisi semua yang terpasang (built-in dan user):

- **Toggle** on/off — menyembunyikan menu dari rail, manifest dan config tetap
  di disk. Daftar yang off disimpan per mesin di `localStorage`
  (`monocode.plugins.disabled`), pola yang sama dengan toggle Notes.
- **Uninstall** (hanya user plugin) — hapus folder `plugins/<id>/`: manifest,
  config, dan token. Perlu klik kedua sebagai konfirmasi.
- **Install** — paste `plugin.json`, atau tulis file sendiri lalu **Refresh**.
- Manifest yang rusak tetap muncul dengan pesan errornya, tanpa toggle.

Plugin yang sedang terbuka lalu di-off/uninstall otomatis menutup
workspace-nya (`overlayOpen` ikut `activePlugin`).

## Contoh terpasang: HTTP (`src/plugins/http/`)

Postman-lite: method + URL + headers + body → Send → response viewer, lalu
**Add to chat** untuk melempar `METHOD URL → status` + body ke agent. Request
terakhir tersimpan lewat `saveConfig`.

## Contoh terpasang: Hacker News (`src/plugins/hn/`)

Contoh **kenapa built-in diperlukan**: front page → klik story → **halaman
detail** dengan komentar (HTML di-strip, kedalaman dibatasi) → "Add to chat"
atau buka artikel/diskusi. Navigasi list→detail seperti ini tidak
ekspresibel di manifest JSON.

## Yang sengaja belum ada

- **Plugin runtime dengan kode sendiri.** Manifest cukup untuk "fetch → list →
  add to chat". Kalau ada yang butuh interaksi nyata (form multi-step, jalankan
  command lokal), itu built-in plugin dan perlu rebuild. Sandbox iframe +
  bridge `postMessage` baru relevan kalau ada pihak ketiga yang mau ship kode.
- **Host allowlist per plugin.** `plugin_fetch` boleh ke host mana saja — memang
  dibutuhkan plugin HTTP client, dan manifest ditulis sendiri oleh user.
- **Multi-request / pagination / write-back** di manifest. Satu request per
  workspace; filter ditaruh di URL.
- **Entry di sidebar collapsed, command palette, dan menu bar.** Plugin muncul
  di rail yang terbuka saja.
- **Tab/split.** Workspace plugin adalah overlay seperti Notes, bukan pane yang
  bisa di-split.
