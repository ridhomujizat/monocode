# Workspace plugins

Satu plugin = satu menu di rail (di bawah **Notes**) + satu workspace
full-screen. Semua plugin **eksternal**: folder `<appData>/plugins/<id>/`
dengan `plugin.json` (JSON), terpasang saat runtime tanpa rebuild. Ada tiga
flavour, dan satu manifest boleh menggabungkan:

| Flavour     | Deklarasi                     | Bisa                                                     |
| ----------- | ----------------------------- | -------------------------------------------------------- |
| **fetch**   | `request`                     | satu HTTP call → list (atau satu respons) → rows ke chat |
| **process** | `startup` / `actions` / `card`| jalankan command argv apa pun, push rows ke kartu rail   |
| **ui**      | `ui`                          | tampilan HTML/CSS/JS bebas dalam iframe sandbox + bridge |

Panduan lengkap format JSON untuk user/AI: **`docs/plugins-for-ai.md`**.

## Fetch (manifest)

`plugin.json` adalah **data, bukan script** — manifest hanya mendeklarasikan
request + cara melabeli hasilnya, lalu `ManifestWorkspace`
(`src/plugins/ManifestWorkspace.tsx`) yang merender: form connect → list →
klik → masuk chat.

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

### Kenapa HTTP harus lewat Rust

CSP webview: `connect-src ipc:` saja. `fetch()` ke host luar diblokir browser.
Jadi ada satu command generik di `src-tauri/src/plugins.rs` (ureq, timeout 30s,
body dibatasi 8 MB, hanya skema `http`/`https`) yang dipakai semua plugin —
bukan satu modul Rust per integrasi.

## UI: Settings → Plugins

Satu section berisi semua yang terpasang:

- **Toggle** on/off — menyembunyikan menu dari rail, manifest dan config tetap
  di disk. Daftar yang off disimpan per mesin di `localStorage`
  (`monocode.plugins.disabled`), pola yang sama dengan toggle Notes.
- **Uninstall** — hapus folder `plugins/<id>/`: manifest, config, dan token.
  Perlu klik kedua sebagai konfirmasi.
- **Install** — paste `plugin.json`, atau tulis file sendiri lalu **Refresh**.
- Manifest yang rusak tetap muncul dengan pesan errornya, tanpa toggle.

Plugin yang sedang terbuka lalu di-off/uninstall otomatis menutup
workspace-nya (`overlayOpen` ikut `activePlugin`).

## Free-UI plugins (`"ui"`)

Model extension browser: plugin membawa tampilannya sendiri, app menyediakan
sandbox + bridge. Manifest cukup metadata + `"ui": "index.html"`; file UI apa
pun di bawah folder plugin terserve lewat scheme `pluginui://<id>/<path>`
(`src-tauri/src/plugin_ui.rs`) dan dirender dalam
`<iframe sandbox="allow-scripts">` oleh `src/plugins/ui/UiWorkspace.tsx`.
Folder `ui/` adalah batasnya — `config.json` berisi token tidak mungkin
ter-serve.

Frame tidak punya akses ke app. Semua aksi host lewat bridge postMessage
(frame → host: `{ monocode: { seq, action, ...fields } }`; balasan host:
`{ monocode: { seq, ok, result | error } }`; host juga mendorong
`{ monocode: { event: "init", pluginId, cwd } }` saat load):

| Action       | Fields                             | Hasil                                    |
| ------------ | ---------------------------------- | ---------------------------------------- |
| `request`    | `method`, `url`, `headers`, `body` | `PluginResponse` (lewat `plugin_fetch`)  |
| `addToChat`  | `title`, `body`                    | chip note di composer, sesi baru         |
| `configGet`  | —                                  | isi `config.json` plugin ini             |
| `configSet`  | `config`                           | tulis `config.json`, mode 0600           |
| `open`       | `url` (http/https)                 | buka di browser sistem                   |

Model trust-nya model install extension: kode di frame adalah kode yang
diinstall user dengan sengaja. Sandbox menjaga frame keluar dari DOM app;
bridge mengikat config dan context ke id plugin itu sendiri.

Contoh lengkap: `board/`, `hn/`, dan `http/` di repo `monocode-modules`
(papan task gaya Jira + mock server; Hacker News dengan halaman detail
komentar; Postman-lite).

## Yang sengaja belum ada

- **Host allowlist per plugin.** `plugin_fetch` boleh ke host mana saja — memang
  dibutuhkan plugin HTTP client, dan manifest ditulis sendiri oleh user.
- **Multi-request / pagination / write-back** di manifest. Satu request per
  workspace; filter ditaruh di URL.
- **Entry di sidebar collapsed, command palette, dan menu bar.** Plugin muncul
  di rail yang terbuka saja.
- **Tab/split.** Workspace plugin adalah overlay seperti Notes, bukan pane yang
  bisa di-split.
