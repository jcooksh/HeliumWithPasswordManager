// "Save password?" prompt. Runs on the extension's origin inside the page.
import { h, send, KEY_ICON } from './dom.js';

const token = location.hash.slice(1);
const root = document.getElementById('root');
const call = (type, extra) => send(type, { token, kind: 'savebar', ...extra });
let lastState = null;

function renderLocked(ctx) {
  root.replaceChildren(h('div', { class: 'savebar' },
    h('h1', {}, `${KEY_ICON} Save password for ${ctx.site}?`),
    h('div', { class: 'muted' }, 'Unlock Helium Vault to save it.'),
    h('div', { class: 'actions' },
      h('button', { onclick: () => call('ui.dismiss') }, 'Not now'),
      h('button', { class: 'primary', onclick: () => call('ui.unlock') }, 'Unlock'))));
}

function renderUnlocked(ctx) {
  const user = h('input', { value: ctx.username, spellcheck: false, autocomplete: 'off', 'aria-label': 'Username' });
  const pass = h('input', { type: 'password', value: ctx.password, spellcheck: false, autocomplete: 'off', 'aria-label': 'Password' });
  const eye = h('button', {
    type: 'button',
    onclick: () => {
      pass.type = pass.type === 'password' ? 'text' : 'password';
      eye.textContent = pass.type === 'password' ? 'Show' : 'Hide';
    },
  }, 'Show');
  const error = h('div', { class: 'error' });
  const save = h('button', { class: 'primary' }, ctx.isUpdate ? 'Update' : 'Save');
  save.onclick = async () => {
    save.disabled = true;
    try {
      await call('ui.save', { username: user.value, password: pass.value });
    } catch (e) {
      error.textContent = e.message;
      save.disabled = false;
    }
  };
  root.replaceChildren(h('div', { class: 'savebar' },
    h('h1', {}, `${KEY_ICON} ${ctx.isUpdate ? 'Update' : 'Save'} password for ${ctx.site}?`),
    ctx.secure ? null : h('div', { class: 'warn' }, 'This site is not using a secure connection.'),
    h('label', {}, 'Username', user),
    h('label', {}, 'Password', h('div', { class: 'pwbox' }, pass, eye)),
    error,
    h('div', { class: 'actions' },
      h('button', { class: 'link', onclick: () => call('ui.never') }, 'Never for this site'),
      h('button', { onclick: () => call('ui.dismiss') }, 'Not now'),
      save)));
}

async function load() {
  let ctx;
  try {
    ctx = await call('ui.context');
  } catch {
    return call('ui.close').catch(() => {});
  }
  if (ctx.gone) return call('ui.close').catch(() => {});
  if (ctx.state === lastState) return; // don't wipe what the user is editing
  lastState = ctx.state;
  if (ctx.state === 'unlocked') renderUnlocked(ctx);
  else renderLocked(ctx);
}

new ResizeObserver(() => {
  call('ui.resize', { height: Math.ceil(root.getBoundingClientRect().height) + 2 }).catch(() => {});
}).observe(root);

setInterval(() => {
  if (lastState === 'locked') load();
}, 1500);
load();
