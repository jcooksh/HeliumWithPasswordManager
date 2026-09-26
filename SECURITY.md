# Helium Vault security design

This document explains how Helium Vault protects your passwords: on disk, in memory, and from the websites you visit. It also lists what the design cannot protect against.

## Threats considered

| Threat | Mitigation |
| --- | --- |
| Someone copies your browser profile or disk | Only ciphertext is stored. The key needs your master password (PBKDF2, 600k iterations). |
| Memory inspection or crash dumps ([the Edge problem](#the-edge-problem)) | Passwords are never bulk-decrypted. Each one is decrypted on demand and then discarded. |
| A malicious website trying to read your saved accounts | The suggestion UI runs in extension-origin iframes that the page can't read. |
| Hidden-form credential harvesting by ad or tracking scripts | Nothing fills without a click, and invisible fields are never filled. |
| A lookalike or wrong site (`github.com.evil.net`, `http://` vs `https://`) | Logins are matched on exact scheme, host (ignoring `www.`) and port. |
| Password left on the clipboard | The clipboard is cleared after 30s (configurable). |
| Vault left unlocked | It auto-locks after inactivity, when the OS locks, and when the browser closes. |
| Online guessing of the master password through the UI | An exponential delay starts after 3 wrong attempts. |
| Data exfiltration from the extension | The CSP sets `connect-src 'none'`: the extension cannot make network requests. |

## Encryption at rest

```
master password ──PBKDF2-HMAC-SHA256, 600,000 iterations, 128-bit random salt──▶ wrapping key
wrapping key    ──AES-256-GCM──▶ wraps a random 256-bit vault key (stored wrapped)
vault key       ──HKDF-SHA256──▶ encKey (AES-256-GCM)   +   macKey (HMAC-SHA256)
```

- Each login is stored as two separately encrypted blobs:
  - `meta` holds the URL, username, name and timestamps. It is decrypted to show suggestions.
  - `secret` holds the password and notes. It is decrypted only for a fill, copy or reveal.
- Every ciphertext uses a fresh random 96-bit IV. Its **AAD binds it to its slot** (`meta:<id>`, `secret:<id>`), so an attacker who can write to storage cannot swap one site's password blob into another entry. Any tampering fails authentication.
- Sites are indexed by `HMAC(macKey, site)`, so someone reading the files cannot see which websites you have accounts on. The "never save" list is also encrypted.
- Changing the master password only re-wraps the vault key, and the old wrapping is overwritten.
- All crypto uses the browser's built-in WebCrypto. There is no third-party crypto code, and every key is created non-extractable.

Everything lives in `chrome.storage.local` inside your Helium profile. Chromium stores this in LevelDB, which can keep stale copies of old records until compaction. Those copies are ciphertext too, so nothing readable is left behind.

## Memory and caching

### The Edge problem

In 2023, researchers showed that Microsoft Edge decrypted **every** saved password into process memory in plaintext at startup and kept it there, even when you never used them. Anyone who could read that memory (malware, a crash dump, another user with debug rights) got everything.

Helium Vault is designed to avoid this:

- **No bulk decryption.** Suggestions decrypt only `meta` blobs, and only for the site you are on. A password is decrypted at the moment you fill, copy or reveal it, returned to the caller, and never cached. Decrypted byte buffers are zeroed after use where JavaScript allows.
- **The key is in RAM only.** While unlocked, the raw vault key sits in `chrome.storage.session`. That store is held in memory, is **never written to disk**, is cleared when the browser exits, and is restricted to trusted extension contexts, so content scripts cannot read it. The service worker imports it as a non-extractable `CryptoKey`.
- **Locking wipes it.** Locking (manual, idle timer, OS lock or browser exit) removes the key and any pending "save password?" data from memory.
- **Spell-check is off.** Every password and username field in the extension sets `spellcheck="false"`. In 2022, Chrome's and Edge's enhanced spell-check was found sending password fields to Google and Microsoft ("spell-jacking").

## Autofill and websites

- The content script runs in Chromium's isolated world. It **never receives your list of saved usernames**. The suggestion menu and the save prompt are `chrome-extension://` iframes inside a closed shadow root, which is cross-origin to the page, so page scripts cannot read them. The e2e test checks this.
- A password is sent only after an explicit user action: clicking a suggestion, clicking **Fill** in the popup, or pressing the shortcut. It is sent with `chrome.tabs.sendMessage(..., { documentId })`, so it reaches exactly the document that asked. The background also re-checks that this document's browser-reported origin matches the login's site. The content script cannot claim a different origin.
- There is **no fill on page load**. Chrome can safely pre-fill because it withholds the values from page JavaScript until you interact. An extension can't do that, so Helium Vault always waits for you.
- **Invisible fields are never filled** (zero size, `display:none`, `visibility:hidden`, or near-zero opacity). This defeats hidden-form harvesting scripts.
- `https` logins are never offered on `http` pages. Insecure pages show a "Not secure" warning.
- Save prompts are only created from real user events (`isTrusted`). A page can't fake a submit to open one.
- Web pages cannot message the extension at all: `externally_connectable` is not declared. Every internal message is checked against its sender: content script, in-page UI frame, or privileged extension page. Each type can only call its own set of operations.
- In-page UI frames use tokens: random UUIDs bound to one tab, frame and document, which expire after 10 minutes. They also use `use_dynamic_url`, so sites can't embed them or fingerprint the extension.

## Import and export

- CSV files are read locally with the `FileReader` API and never uploaded. After an import, the file input and the parsed data are cleared, and you are reminded to delete the CSV.
- The encrypted backup is the raw ciphertext records. It is still protected by your master password.
- Exporting a CSV or a backup requires re-entering your master password.

## What this cannot protect against

- **Malware on your computer** while the vault is unlocked. It can read browser memory or log your keystrokes. No password manager can fully stop this.
- **A weak master password.** Anyone with a copy of your profile can guess offline. PBKDF2 slows this down but does not stop it. Use a long passphrase of four or more random words.
- **A compromised website** (for example, XSS on the real site). It receives your password when you sign in, as with any password manager.
- **JavaScript strings can't be wiped.** Decrypted values that pass through JS strings stay in memory until garbage collection. Exposure is limited to the single password you just used.
- **OS swap and hibernation files** may capture memory pages from the browser process, including the unlocked key. Enable full-disk encryption (BitLocker, FileVault or LUKS).
- **Brave's own password store** can't be read directly, because it's protected by the OS keychain, so importing needs a temporary plaintext CSV. Delete it straight after.
