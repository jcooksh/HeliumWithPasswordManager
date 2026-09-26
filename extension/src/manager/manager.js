import { h, send, initial, KEY_ICON } from '../ui/dom.js';
import { passwordInput, strengthMeter } from '../ui/widgets.js';
import { generatePassword } from '../lib/generator.js';
import { loginsFromCsv } from '../lib/csv.js';

const app = document.getElementById('app');
const PAGES = {
  passwords: 'Passwords',
  import: 'Import',
  backup: 'Export & backup',
  settings: 'Settings',
  security: 'How it’s protected',
};
let page = PAGES[location.hash.slice(1)] ? location.hash.slice(1) : 'passwords';

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

async function copy(text) {
  await navigator.clipboard.writeText(text);
  await send('clipboard.clearLater').catch(() => {});
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

// Wraps an async action with button busy state + error display.
function action(btn, errorEl, fn) {
  return async (e) => {
    e?.preventDefault();
    const label = btn.textContent;
    btn.disabled = true;
    if (errorEl) errorEl.textContent = '';
    try {
      await fn();
    } catch (err) {
      if (err.locked) return render();
      if (errorEl) errorEl.textContent = err.message;
      else alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };
}

// ---- locked / setup ---------------------------------------------------------

function viewGate(state) {
  const setup = state === 'uninitialized';
  const pw = passwordInput({ placeholder: 'Master password' });
  const confirm = setup ? passwordInput({ placeholder: 'Confirm master password' }) : null;
  const error = h('div', { class: 'error' });
  const btn = h('button', { class: 'primary' }, setup ? 'Create vault' : 'Unlock');
  const form = h('form', { class: 'card' },
    h('h2', {}, setup ? `${KEY_ICON} Welcome to Helium Vault` : `${KEY_ICON} Helium Vault is locked`),
    setup ? h('p', { class: 'muted' }, 'Create a master password. It encrypts all your passwords on this device and can’t be recovered if you forget it — so make it long and memorable.') : null,
    pw,
    ...(setup ? strengthMeter(pw) : []),
    confirm,
    error,
    btn);
  form.onsubmit = action(btn, error, async () => {
    if (setup) {
      if (pw.value !== confirm.value) throw new Error('Passwords do not match.');
      await send('vault.create', { password: pw.value });
      page = 'import';
    } else {
      await send('vault.unlock', { password: pw.value });
    }
    render();
  });
  app.replaceChildren(h('div', { class: 'center' }, form));
  pw.focus();
}

// ---- shell -----------------------------------------------------------------

function shell(content) {
  const nav = h('nav', {},
    h('div', { class: 'brand' }, `${KEY_ICON} Helium Vault`),
    ...Object.entries(PAGES).map(([id, label]) => h('button', {
      'aria-current': id === page ? 'page' : null,
      onclick: () => {
        page = id;
        history.replaceState(null, '', '#' + id);
        render();
      },
    }, label)),
    h('div', { class: 'spacer' }),
    h('button', { onclick: async () => { await send('vault.lock'); render(); } }, 'Lock vault'));
  app.replaceChildren(h('div', { class: 'shell' }, nav, h('main', {}, ...content)));
}

// ---- passwords ---------------------------------------------------------------

function editDialog(login, onSaved) {
  const isNew = !login;
  const url = h('input', { value: login?.url ?? 'https://', spellcheck: false, autocomplete: 'off' });
  const username = h('input', { value: login?.username ?? '', spellcheck: false, autocomplete: 'off' });
  const password = h('input', { type: 'password', value: login?.password ?? '', spellcheck: false, autocomplete: 'off' });
  const title = h('input', { value: login?.title ?? '', autocomplete: 'off' });
  const notes = h('textarea', { rows: 3, spellcheck: false }, login?.notes ?? '');
  const error = h('div', { class: 'error' });
  const save = h('button', { class: 'primary' }, 'Save');
  const reveal = h('button', { type: 'button', onclick: () => { password.type = password.type === 'password' ? 'text' : 'password'; } }, 'Show');
  const gen = h('button', { type: 'button', onclick: () => { password.value = generatePassword({ length: 20 }); password.type = 'text'; } }, 'Generate');
  const form = h('form', { class: 'card' },
    h('h2', {}, isNew ? 'Add password' : 'Edit password'),
    h('div', { class: 'form' },
      h('label', {}, 'Website', url),
      h('label', {}, 'Username', username),
      h('label', {}, 'Password', h('div', { class: 'row' }, password, reveal, gen)),
      h('label', {}, 'Name (optional)', title),
      h('label', {}, 'Notes (optional)', notes)),
    error,
    h('div', { class: 'actions' },
      h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      save));
  const dialog = h('dialog', {}, form);
  form.onsubmit = action(save, error, async () => {
    const data = { url: url.value, username: username.value, password: password.value, title: title.value, notes: notes.value };
    if (isNew) await send('vault.add', { login: data });
    else await send('vault.update', { id: login.id, changes: data });
    dialog.close();
    onSaved();
  });
  dialog.addEventListener('close', () => {
    password.value = '';
    dialog.remove();
  });
  document.body.append(dialog);
  dialog.showModal();
}

async function viewPasswords() {
  const { logins } = await send('vault.list');
  logins.sort((a, b) => hostOf(a.url).localeCompare(hostOf(b.url)) || a.username.localeCompare(b.username));
  const search = h('input', { type: 'search', placeholder: `Search ${logins.length} passwords`, spellcheck: false, autocomplete: 'off' });
  const table = h('div', { class: 'table' });

  const row = (l) => {
    const pw = h('span', { class: 'mono ellipsis' }, '••••••••••');
    let hideTimer = 0;
    const show = h('button', {}, 'Show');
    show.onclick = async () => {
      if (show.textContent === 'Hide') {
        pw.textContent = '••••••••••';
        show.textContent = 'Show';
        return;
      }
      pw.textContent = (await send('vault.get', { id: l.id })).login.password;
      show.textContent = 'Hide';
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { pw.textContent = '••••••••••'; show.textContent = 'Show'; }, 20_000);
    };
    return h('div', { class: 'tr' },
      h('span', { class: 'avatar' }, initial(hostOf(l.url))),
      h('div', { style: 'min-width:0' },
        h('div', { class: 'ellipsis' }, l.title || hostOf(l.url)),
        h('div', { class: 'sub ellipsis' }, l.url)),
      h('div', { class: 'ellipsis hide-sm' }, l.username || h('span', { class: 'muted' }, '(none)')),
      h('div', { class: 'row hide-sm', style: 'min-width:0' }, pw),
      h('div', { class: 'btns' },
        show,
        h('button', { onclick: async () => copy((await send('vault.get', { id: l.id })).login.password) }, 'Copy'),
        h('button', { onclick: async () => editDialog((await send('vault.get', { id: l.id })).login, render) }, 'Edit'),
        h('button', {
          class: 'danger',
          onclick: async () => {
            if (!confirm(`Delete the password for ${l.username || hostOf(l.url)}?`)) return;
            await send('vault.delete', { id: l.id });
            render();
          },
        }, 'Delete')));
  };

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const shown = q ? logins.filter((l) => [l.url, l.username, l.title].some((v) => v?.toLowerCase().includes(q))) : logins;
    table.replaceChildren(...(shown.length ? shown.map(row) : [h('div', { class: 'empty' },
      logins.length ? 'No matches.' : 'No passwords yet. Import them from another browser or add one.')]));
  };
  search.addEventListener('input', draw);
  draw();

  shell([
    h('h1', {}, 'Passwords'),
    h('p', { class: 'lead muted' }, 'Saved logins are encrypted on this device with your master password.'),
    h('div', { class: 'toolbar' }, search, h('button', { class: 'primary', onclick: () => editDialog(null, render) }, 'Add password')),
    table,
  ]);
  search.focus();
}

// ---- import --------------------------------------------------------------------

const SOURCES = [
  ['Brave', 'Open brave://password-manager/settings, click “Export passwords”, confirm, and save the .csv file.'],
  ['Chrome / Edge / Vivaldi / Opera', 'Open the browser’s password manager settings (chrome://password-manager/settings or edge://wallet/passwords) and choose “Export passwords”.'],
  ['Firefox', 'Open about:logins, click the ⋯ menu, choose “Export passwords…”.'],
  ['Safari', 'File → Export → Passwords… (macOS Sonoma or later).'],
  ['Bitwarden / 1Password / LastPass', 'Use the vault’s export feature and pick the .csv (unencrypted) format.'],
];

function viewImport() {
  const file = h('input', { type: 'file', accept: '.csv,text/csv' });
  const overwrite = h('input', { type: 'checkbox' });
  const error = h('div', { class: 'error' });
  const out = h('div');
  const btn = h('button', { class: 'primary' }, 'Import');
  btn.onclick = action(btn, error, async () => {
    const f = file.files[0];
    if (!f) throw new Error('Choose a .csv file first.');
    btn.textContent = 'Importing…';
    const { logins, skipped } = loginsFromCsv(await readFile(f));
    const { result } = await send('vault.import', { logins, overwrite: overwrite.checked });
    logins.length = 0;
    file.value = '';
    out.replaceChildren(h('div', { class: 'result' },
      h('strong', {}, `Imported ${result.added} new password${result.added === 1 ? '' : 's'}.`),
      result.updated ? ` Updated ${result.updated}.` : '',
      result.duplicates ? ` ${result.duplicates} already saved.` : '',
      result.conflicts ? ` ${result.conflicts} skipped because a different password is already saved for that account (tick “Replace” to overwrite).` : '',
      skipped.length + result.invalid ? ` ${skipped.length + result.invalid} rows skipped (apps or rows without a password).` : ''),
    h('p', { class: 'warn', style: 'margin-top:10px' },
      `Important: “${f.name}” contains your passwords in plain text. Delete it now and empty your trash/recycle bin.`));
  });

  shell([
    h('h1', {}, 'Import passwords'),
    h('p', { class: 'lead muted' }, 'Bring your passwords over from Brave or any other browser. The file is read here on your device and never uploaded.'),
    h('div', { class: 'card' },
      h('h2', {}, '1. Export from your old browser'),
      h('div', { class: 'sites' }, ...SOURCES.map(([name, how]) => h('div', {}, h('strong', {}, name), h('div', { class: 'muted' }, how))))),
    h('div', { class: 'card' },
      h('h2', {}, '2. Choose the exported file'),
      file,
      h('label', { class: 'check' }, overwrite, 'Replace existing passwords when the same account is already saved'),
      error,
      h('div', {}, btn),
      out),
  ]);
}

// ---- export & backup ----------------------------------------------------------------

function viewBackup() {
  const backupPw = passwordInput({ placeholder: 'Master password' });
  const backupErr = h('div', { class: 'error' });
  const backupBtn = h('button', { class: 'primary' }, 'Download encrypted backup');
  backupBtn.onclick = action(backupBtn, backupErr, async () => {
    const { backup } = await send('vault.exportBackup', { password: backupPw.value });
    backupPw.value = '';
    download(`helium-vault-backup-${today()}.json`, JSON.stringify(backup), 'application/json');
  });

  const restoreFile = h('input', { type: 'file', accept: '.json,application/json' });
  const restorePw = passwordInput({ placeholder: 'Master password of the backup' });
  const restoreErr = h('div', { class: 'error' });
  const restoreBtn = h('button', { class: 'danger' }, 'Restore backup');
  restoreBtn.onclick = action(restoreBtn, restoreErr, async () => {
    const f = restoreFile.files[0];
    if (!f) throw new Error('Choose a backup file first.');
    if (!confirm('Restoring replaces ALL passwords currently in Helium Vault with the backup. Continue?')) return;
    let backup;
    try {
      backup = JSON.parse(await readFile(f));
    } catch {
      throw new Error('That file is not a Helium Vault backup.');
    }
    await send('vault.restoreBackup', { backup, password: restorePw.value });
    restorePw.value = '';
    page = 'passwords';
    render();
  });

  const csvPw = passwordInput({ placeholder: 'Master password' });
  const csvErr = h('div', { class: 'error' });
  const csvBtn = h('button', {}, 'Export unencrypted CSV');
  csvBtn.onclick = action(csvBtn, csvErr, async () => {
    const { csv } = await send('vault.exportCsv', { password: csvPw.value });
    csvPw.value = '';
    download(`helium-vault-passwords-${today()}.csv`, csv, 'text/csv');
  });

  shell([
    h('h1', {}, 'Export & backup'),
    h('p', { class: 'lead muted' }, 'Keep a backup somewhere safe in case this browser profile is lost.'),
    h('div', { class: 'card' },
      h('h2', {}, 'Encrypted backup (recommended)'),
      h('p', { class: 'muted' }, 'A file that stays encrypted with your master password. Safe to keep on a USB stick or cloud drive.'),
      h('div', { class: 'form' }, backupPw, backupErr, h('div', {}, backupBtn))),
    h('div', { class: 'card' },
      h('h2', {}, 'Restore from backup'),
      h('div', { class: 'form' }, restoreFile, restorePw, restoreErr, h('div', {}, restoreBtn))),
    h('div', { class: 'card' },
      h('h2', {}, 'Export as CSV'),
      h('p', { class: 'warn' }, 'The CSV file is NOT encrypted: anyone who gets it can read every password. Only use it to move to another password manager, then delete it.'),
      h('div', { class: 'form' }, csvPw, csvErr, h('div', {}, csvBtn))),
  ]);
}

// ---- settings ------------------------------------------------------------------

async function viewSettings() {
  const [{ settings }, { sites }] = await Promise.all([send('vault.status'), send('vault.neverList')]);
  const saveSetting = async (patch) => {
    await send('settings.set', { settings: patch });
  };
  const select = (key, options) => {
    const el = h('select', { onchange: () => saveSetting({ [key]: Number(el.value) }) },
      ...options.map(([v, label]) => h('option', { value: String(v), selected: settings[key] === v }, label)));
    return el;
  };
  const toggle = (key, label) => {
    const el = h('input', { type: 'checkbox', checked: settings[key], onchange: () => saveSetting({ [key]: el.checked }) });
    return h('label', { class: 'check' }, el, label);
  };

  const cur = passwordInput({ placeholder: 'Current master password' });
  const next = passwordInput({ placeholder: 'New master password' });
  const next2 = passwordInput({ placeholder: 'Confirm new master password' });
  const cpErr = h('div', { class: 'error' });
  const cpBtn = h('button', { class: 'primary' }, 'Change master password');
  cpBtn.onclick = action(cpBtn, cpErr, async () => {
    if (next.value !== next2.value) throw new Error('New passwords do not match.');
    await send('vault.changePassword', { current: cur.value, next: next.value });
    cur.value = next.value = next2.value = '';
    cpErr.textContent = '';
    alert('Master password changed.');
  });

  const delPw = passwordInput({ placeholder: 'Master password' });
  const delErr = h('div', { class: 'error' });
  const delBtn = h('button', { class: 'danger' }, 'Delete vault and all passwords');
  delBtn.onclick = action(delBtn, delErr, async () => {
    if (!confirm('This permanently deletes every saved password in Helium Vault. Continue?')) return;
    await send('vault.destroy', { password: delPw.value });
    render();
  });

  const neverList = h('div', { class: 'sites' }, ...(sites.length ? sites.map((s) => h('div', { class: 'row' },
    h('span', { class: 'ellipsis' }, s),
    h('button', { onclick: async () => { await send('vault.neverRemove', { site: s }); render(); } }, 'Remove')))
    : [h('div', { class: 'muted' }, 'None')]));

  shell([
    h('h1', {}, 'Settings'),
    h('p', { class: 'lead muted' }, 'Choose how Helium Vault locks, fills and saves.'),
    h('div', { class: 'card' },
      h('h2', {}, 'Locking'),
      h('div', { class: 'form' },
        h('label', {}, 'Lock automatically after inactivity',
          select('autoLockMinutes', [[1, '1 minute'], [5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [240, '4 hours'], [0, 'Only when Helium closes']])),
        toggle('lockOnSystemLock', 'Lock when my computer is locked'),
        h('label', {}, 'Clear copied passwords from the clipboard after',
          select('clipboardClearSeconds', [[30, '30 seconds'], [60, '1 minute'], [120, '2 minutes'], [0, 'Never']])))),
    h('div', { class: 'card' },
      h('h2', {}, 'Autofill'),
      h('div', { class: 'form' },
        toggle('inlineMenu', 'Show saved logins when I click a login field'),
        toggle('offerToSave', 'Offer to save passwords when I sign in'),
        h('p', { class: 'muted' }, 'Keyboard shortcut to fill the focused login: Ctrl+Shift+L (⌘+Shift+L on Mac). ',
          h('button', { class: 'link', onclick: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) }, 'Change shortcuts')))),
    h('div', { class: 'card' },
      h('h2', {}, 'Never save for these sites'),
      neverList),
    h('div', { class: 'card' },
      h('h2', {}, 'Master password'),
      h('div', { class: 'form' }, cur, next, ...strengthMeter(next), next2, cpErr, h('div', {}, cpBtn))),
    h('div', { class: 'card' },
      h('h2', {}, 'Danger zone'),
      h('div', { class: 'form' }, delPw, delErr, h('div', {}, delBtn))),
  ]);
}

// ---- security explainer ---------------------------------------------------------

function viewSecurity() {
  const points = [
    ['Encrypted at rest.', 'Every login is encrypted with AES-256-GCM before it is written to disk. The key comes from your master password via PBKDF2-SHA256 with 600,000 iterations. Even the list of websites is hidden (stored as keyed hashes).'],
    ['Nothing decrypted until you need it.', 'Unlike browsers that load every password into memory in plain text at startup, Helium Vault decrypts a password only at the moment you fill, copy or reveal it, and never keeps a decrypted copy around.'],
    ['Unlock key lives only in memory.', 'While unlocked, the key is kept in Chrome’s in-memory session storage: never written to disk, wiped when Helium closes, and not readable by websites or content scripts. It locks after inactivity and when your computer locks.'],
    ['Websites can’t see your accounts.', 'The suggestion menu and save prompt are isolated extension frames. A page can’t read which usernames you have saved, and a password is only sent to the exact site (scheme + domain + port) it was saved for.'],
    ['No silent autofill.', 'Passwords are filled only when you click a suggestion or press the shortcut, and never into hidden fields, so invisible tracking forms can’t harvest them.'],
    ['No network access.', 'The extension makes no network requests at all (its security policy blocks them). No accounts, no sync servers, no analytics.'],
    ['Clipboard is cleaned up.', 'Copied passwords are cleared from the clipboard automatically.'],
  ];
  shell([
    h('h1', {}, 'How your passwords are protected'),
    h('p', { class: 'lead muted' }, 'A summary. See SECURITY.md in the project for full details and limitations.'),
    h('div', { class: 'card' }, h('ul', { class: 'security' }, ...points.map(([t, d]) => h('li', {}, h('strong', {}, t), ' ', d)))),
    h('div', { class: 'card' },
      h('h2', {}, 'What it can’t protect against'),
      h('ul', { class: 'security' },
        h('li', {}, 'Malware already running on your computer while the vault is unlocked.'),
        h('li', {}, 'A weak master password: anyone with a copy of your browser profile can try to guess it offline. Use a long passphrase.'),
        h('li', {}, 'A website that is itself compromised — it receives your password when you sign in, as with any password manager.'))),
  ]);
}

// ---- router -----------------------------------------------------------------------

async function render() {
  const { state } = await send('vault.status');
  if (state !== 'unlocked') return viewGate(state);
  try {
    if (page === 'passwords') await viewPasswords();
    else if (page === 'import') viewImport();
    else if (page === 'backup') viewBackup();
    else if (page === 'settings') await viewSettings();
    else viewSecurity();
  } catch (e) {
    if (e.locked) return viewGate('locked');
    throw e;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'bg.locked') render();
});
render();
