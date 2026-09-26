import { h, send, initial, KEY_ICON } from '../ui/dom.js';
import { generatePassword } from '../lib/generator.js';
import { passwordInput, strengthMeter } from '../ui/widgets.js';

const app = document.getElementById('app');
const toastEl = h('div', { class: 'toast', role: 'status' });
document.body.append(toastEl);
let tab = null;

function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 1400);
}

async function copy(text, what) {
  await navigator.clipboard.writeText(text);
  await send('clipboard.clearLater').catch(() => {});
  toast(`${what} copied`);
}

function header(extra = []) {
  return h('header', {}, h('span', { class: 'title grow' }, `${KEY_ICON} Helium Vault`), ...extra);
}

function viewSetup() {
  const pw = passwordInput({ placeholder: 'Master password', autofocus: true });
  const confirm = passwordInput({ placeholder: 'Confirm master password' });
  const error = h('div', { class: 'error' });
  const btn = h('button', { class: 'primary' }, 'Create vault');
  const submit = async (e) => {
    e.preventDefault();
    error.textContent = '';
    if (pw.value !== confirm.value) return (error.textContent = 'Passwords do not match.');
    if (pw.value.length < 10) return (error.textContent = 'Use at least 10 characters.');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      await send('vault.create', { password: pw.value });
      render();
    } catch (err) {
      error.textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Create vault';
    }
  };
  app.replaceChildren(header(), h('form', { class: 'pad', onsubmit: submit },
    h('h2', {}, 'Create your password vault'),
    h('div', { class: 'muted' }, 'Pick a master password. It encrypts everything and cannot be recovered if you forget it.'),
    pw, ...strengthMeter(pw), confirm, error, btn,
  ));
  pw.focus();
}

function viewLocked() {
  const pw = passwordInput({ placeholder: 'Master password', autofocus: true });
  const error = h('div', { class: 'error' });
  const btn = h('button', { class: 'primary' }, 'Unlock');
  const submit = async (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = 'Unlocking…';
    error.textContent = '';
    try {
      await send('vault.unlock', { password: pw.value });
      render();
    } catch (err) {
      error.textContent = err.message;
      pw.select();
      btn.disabled = false;
      btn.textContent = 'Unlock';
    }
  };
  app.replaceChildren(header(), h('form', { class: 'pad', onsubmit: submit },
    h('h2', {}, 'Vault locked'), pw, error, btn));
  pw.focus();
}

function loginRow(login, { canFill, site }) {
  const getPassword = async () => (await send('vault.get', { id: login.id })).login.password;
  return h('div', { class: 'login' },
    h('span', { class: 'avatar' }, initial(login.username || login.title || site)),
    h('div', { class: 'grow' },
      h('div', { class: 'ellipsis' }, login.username || '(no username)'),
      h('div', { class: 'sub ellipsis' }, login.title || hostOf(login.url))),
    h('div', { class: 'btns' },
      canFill ? h('button', {
        class: 'primary',
        onclick: async () => {
          try {
            await send('vault.fillTab', { tabId: tab.id, id: login.id });
            window.close();
          } catch (e) {
            toast(e.message);
          }
        },
      }, 'Fill') : null,
      h('button', { title: 'Copy username', onclick: () => copy(login.username, 'Username') }, 'User'),
      h('button', { title: 'Copy password', onclick: async () => copy(await getPassword(), 'Password') }, 'Pass')));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

async function viewUnlocked() {
  const [{ site, secure, logins }, all] = await Promise.all([
    tab ? send('vault.tabLogins', { tabId: tab.id }) : { site: null, logins: [] },
    send('vault.list').then((r) => r.logins),
  ]);
  const search = h('input', { type: 'search', placeholder: 'Search all passwords', spellcheck: false, autocomplete: 'off' });
  const list = h('div', { class: 'list' });
  const gen = h('div');

  const renderList = () => {
    const q = search.value.trim().toLowerCase();
    if (q) {
      const hits = all.filter((l) => [l.username, l.url, l.title].some((v) => v?.toLowerCase().includes(q))).slice(0, 50);
      list.replaceChildren(
        h('div', { class: 'section' }, `Results (${hits.length})`),
        ...(hits.length ? hits.map((l) => loginRow(l, { canFill: false, site: hostOf(l.url) })) : [h('div', { class: 'empty' }, 'No matches')]));
      return;
    }
    list.replaceChildren(...[
      h('div', { class: 'section' }, site ? `Saved for ${site}` : 'This page'),
      site && !secure ? h('div', { class: 'section warn' }, 'Not a secure connection') : null,
      ...(logins.length
        ? logins.map((l) => loginRow(l, { canFill: true, site }))
        : [h('div', { class: 'empty' }, site ? 'No saved passwords for this site.' : 'Open a website to see its saved passwords.')]),
    ].filter(Boolean));
  };
  search.addEventListener('input', renderList);
  renderList();

  const toggleGen = () => {
    if (gen.firstChild) return gen.replaceChildren();
    const out = h('div', { class: 'out' });
    const len = h('input', { type: 'range', min: 12, max: 64, value: 20 });
    const lenLabel = h('span', { class: 'muted' });
    const symbols = h('input', { type: 'checkbox', checked: true, style: 'width:auto' });
    const regen = () => {
      out.textContent = generatePassword({ length: Number(len.value), symbols: symbols.checked });
      lenLabel.textContent = `${len.value} chars`;
    };
    len.addEventListener('input', regen);
    symbols.addEventListener('change', regen);
    regen();
    gen.replaceChildren(h('div', { class: 'gen' },
      out,
      h('div', { class: 'row' }, len, lenLabel),
      h('label', { class: 'row muted' }, symbols, 'Symbols'),
      h('div', { class: 'row' },
        h('button', { class: 'grow', onclick: regen }, 'Regenerate'),
        h('button', { class: 'primary grow', onclick: () => copy(out.textContent, 'Password') }, 'Copy'))));
  };

  app.replaceChildren(
    header([h('button', { title: 'Lock now', onclick: async () => { await send('vault.lock'); render(); } }, 'Lock')]),
    h('div', { style: 'padding:10px 12px 4px' }, search),
    list,
    gen,
    h('footer', {},
      h('button', { onclick: toggleGen }, 'Generate'),
      h('button', { onclick: () => { chrome.runtime.openOptionsPage(); window.close(); } }, 'Manage passwords')),
  );
  if (!logins.length) search.focus();
}

async function render() {
  const { state } = await send('vault.status');
  if (state === 'uninitialized') viewSetup();
  else if (state === 'locked') viewLocked();
  else await viewUnlocked().catch((e) => (e.locked ? viewLocked() : app.replaceChildren(h('div', { class: 'pad error' }, e.message))));
}

[tab] = await chrome.tabs.query({ active: true, currentWindow: true });
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'bg.locked') render();
});
render();
