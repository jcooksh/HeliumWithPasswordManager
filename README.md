# Helium Vault: a password manager for Helium

[Helium](https://github.com/imputnet/helium) removes Chromium's built-in password manager. Helium Vault adds one back as an extension. It saves your passwords encrypted on your device, fills them in as Chrome does, and imports your passwords from Brave or any other browser.

It also works in other Chromium browsers (Chrome, Brave, Edge, Vivaldi, Opera).

## Features

- **Autofill like Chrome.** Click a username or password field to see your saved logins for that site, then pick one to fill it in. You can also press **Ctrl+Shift+L** (⌘+Shift+L on Mac).
- **Save prompts.** When you sign in with a new or changed password, it asks whether to save or update it. You can also choose "Never for this site".
- **Strong password suggestions** on sign-up forms, plus a generator in the toolbar popup.
- **Import** from Brave, Chrome, Edge, Firefox, Safari, Bitwarden, 1Password and LastPass (CSV export).
- **Manage** your logins: search, add, edit, delete, reveal and copy.
- **Encrypted backup and restore**, plus a plain CSV export for moving to another manager.
- **Auto-lock** after inactivity, when your computer locks, and when Helium closes.
- Copied passwords are cleared from the clipboard automatically.
- No account, no cloud and no network access at all.

## Install in Helium

1. Download this repository (**Code → Download ZIP**) and unzip it, or run `git clone`.
2. In Helium, open `helium://extensions` (`chrome://extensions` also works).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the **`extension`** folder.
5. A setup tab opens. Create your master password. Pin the 🔑 icon to your toolbar with the puzzle-piece menu.

> Keep the folder where it is. Helium loads the extension from it, so if you delete or move the folder, the extension goes away. Your passwords stay in your Helium profile, but you should still keep an encrypted backup (see below).

## Import your passwords from Brave

1. In Brave, open `brave://password-manager/settings`.
2. Click **Export passwords** and save the file (`Brave Passwords.csv`).
3. In Helium Vault, open **Manage passwords → Import**, choose the file and click **Import**.
4. **Delete the CSV file** and empty your trash. It contains every password in plain text.

The Import page has the same steps for other browsers and password managers. A browser extension can't read Brave's password database directly, because it's locked with your OS keychain. Exporting to CSV is the only way.

## Security

Full details are in [SECURITY.md](SECURITY.md). In short:

- Passwords are encrypted with AES-256-GCM. The key is derived from your master password using PBKDF2-SHA256 with 600,000 iterations. Nothing is stored in plaintext, not even the list of sites.
- Some browsers load all your passwords into memory as plaintext at startup; [Edge did this in 2023](SECURITY.md#the-edge-problem). Helium Vault does not. It decrypts one password only at the moment you fill, copy or reveal it.
- While the vault is unlocked, the key is kept in memory only. It is never written to disk and is wiped when Helium closes or the vault auto-locks.
- Websites cannot see which accounts you have saved. Passwords are only ever filled into the exact site they belong to, only when you ask, and never into hidden fields.

## Development

```sh
npm test          # unit tests (crypto, vault, CSV import, URL matching)
npm run test:e2e  # loads the extension in Chromium via Playwright and tests fill/save/lock
npm run package   # builds helium-vault.zip
```

Layout:

```
extension/
  manifest.json
  src/background.js        service worker: the only code that holds keys
  src/lib/                 crypto, vault storage, CSV, URL matching, generator
  src/content/autofill.js  finds login fields, fills and captures
  src/ui/                  in-page suggestion menu and save prompt (isolated iframes)
  src/popup/               toolbar popup
  src/manager/             full password manager page
  src/offscreen/           clipboard clearing
```
