// Helium Vault background service worker: the only place that holds keys and
// decrypts anything. Web pages never talk to it directly; content scripts and
// extension pages do, and every message is checked against who sent it.

import * as vault from './lib/vault.js';
import { parseSite } from './lib/url.js';
import { toCsv } from './lib/csv.js';

const session = chrome.storage.session;
const local = chrome.storage.local;

const DEFAULT_SETTINGS = {
  autoLockMinutes: 15, // 0 = only when the browser closes
  lockOnSystemLock: true,
  clipboardClearSeconds: 30, // 0 = never
  inlineMenu: true,
  offerToSave: true,
};

const EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
const PRIVILEGED_PAGES = new Set(['/src/popup/popup.html', '/src/manager/manager.html']);
const UI_PAGES = new Set(['/src/ui/dropdown.html', '/src/ui/savebar.html']);
const PENDING_TTL = 3 * 60_000;
const TOKEN_TTL = 10 * 60_000;
const COMMAND_WINDOW = 3_000;

// Content scripts only; extension pages already have access to storage.session
// but content scripts must never be able to read the vault key.
session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });

// ---- helpers ---------------------------------------------------------------

let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function getSettings() {
  const { settings } = await local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

function senderKind(sender) {
  if (sender.id !== chrome.runtime.id) return null;
  let url;
  try {
    url = new URL(sender.url);
  } catch {
    return null;
  }
  if (url.origin === EXT_ORIGIN) {
    if (PRIVILEGED_PAGES.has(url.pathname)) return 'privileged';
    if (UI_PAGES.has(url.pathname)) return 'ui';
    return null;
  }
  if (sender.tab && typeof sender.origin === 'string' && /^https?:\/\//.test(sender.origin)) return 'content';
  return null;
}

async function sessionGet(key) {
  return (await session.get(key))[key];
}

let lastTouch = 0;
async function touch() {
  if (Date.now() - lastTouch < 20_000) return;
  lastTouch = Date.now();
  await scheduleAutoLock();
}

async function scheduleAutoLock() {
  const s = await getSettings();
  if (s.autoLockMinutes > 0) await chrome.alarms.create('autolock', { delayInMinutes: s.autoLockMinutes });
  else await chrome.alarms.clear('autolock');
}

async function lockVault() {
  await vault.lock();
  await chrome.alarms.clear('autolock');
  chrome.runtime.sendMessage({ type: 'bg.locked' }).catch(() => {});
}

async function openUnlock() {
  try {
    await chrome.action.openPopup();
  } catch {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/manager/manager.html') });
  }
}

// ---- frame registry & UI tokens ------------------------------------------

function registerFrame(sender) {
  return serial(async () => {
    const key = 'frames.' + sender.tab.id;
    const frames = (await sessionGet(key)) ?? {};
    frames[sender.frameId] = { documentId: sender.documentId, origin: sender.origin };
    await session.set({ [key]: frames });
  });
}

async function createToken(ctx) {
  const token = crypto.randomUUID();
  await session.set({ ['ui.' + token]: { ...ctx, expires: Date.now() + TOKEN_TTL } });
  return token;
}

async function readToken(token, sender, kind) {
  if (typeof token !== 'string') throw new Error('Bad request.');
  const ctx = await sessionGet('ui.' + token);
  if (!ctx || ctx.kind !== kind || ctx.expires < Date.now()) throw new Error('This prompt has expired.');
  // The UI frame must live in the same tab the token was issued for.
  if (!sender.tab || sender.tab.id !== ctx.tabId) throw new Error('Bad request.');
  return ctx;
}

function sendToFrame(ctx, msg) {
  const target = ctx.documentId ? { documentId: ctx.documentId } : { frameId: ctx.frameId ?? 0 };
  return chrome.tabs.sendMessage(ctx.tabId, msg, target);
}

async function closeUi(token, ctx) {
  await session.remove('ui.' + token);
  await sendToFrame(ctx, { type: 'bg.closeUi', token }).catch(() => {});
}

// Sends a password to exactly one document, and only if that document's
// origin matches the site the login was saved for.
async function fillFrame(ctx, login) {
  const want = parseSite(login.url)?.matchKey;
  if (!want || want !== parseSite(ctx.origin)?.matchKey) throw new Error('This login belongs to a different site.');
  await sendToFrame(ctx, { type: 'bg.fill', username: login.username, password: login.password });
  vault.markUsed(login.id).catch(() => {});
}

// ---- save prompts ---------------------------------------------------------

async function getPending(tabId) {
  const p = await sessionGet('pending.' + tabId);
  if (p && p.createdAt + PENDING_TTL > Date.now()) return p;
  if (p) await session.remove('pending.' + tabId);
  return null;
}

// Re-checks a pending save against the (now unlocked) vault. Returns null if
// nothing should be offered any more.
async function resolvePending(tabId, p) {
  if ((await vault.status()) !== 'unlocked') return p;
  if (await vault.isNeverSave(p.origin)) {
    await session.remove('pending.' + tabId);
    return null;
  }
  const same = (await vault.findLogins(p.origin)).find((m) => m.username === p.username);
  if (same) {
    const full = await vault.getLogin(same.id);
    if (full.password === p.password) {
      await session.remove('pending.' + tabId);
      vault.markUsed(same.id).catch(() => {});
      return null;
    }
    return { ...p, existingId: same.id };
  }
  return { ...p, existingId: null };
}

async function pushSavebar(tabId) {
  const token = await createToken({ kind: 'savebar', tabId, frameId: 0 });
  await chrome.tabs.sendMessage(tabId, { type: 'bg.showSavebar', token }, { frameId: 0 }).catch(() => {});
}

// ---- handlers ------------------------------------------------------------

const commandAt = new Map();

const contentHandlers = {
  async 'cs.hello'(msg, sender) {
    await registerFrame(sender);
    return {};
  },

  async 'cs.pageReady'(msg, sender) {
    await registerFrame(sender);
    if (sender.frameId !== 0) return {};
    const pending = await getPending(sender.tab.id);
    if (!pending) return {};
    return { savebar: await createToken({ kind: 'savebar', tabId: sender.tab.id, frameId: 0 }) };
  },

  async 'cs.focus'(msg, sender) {
    const settings = await getSettings();
    const site = parseSite(sender.origin);
    if (!settings.inlineMenu || !site) return { show: false };
    await registerFrame(sender);
    const state = await vault.status();
    if (state === 'uninitialized') return { show: false };
    const fieldKind = ['username', 'password', 'new-password'].includes(msg.fieldKind) ? msg.fieldKind : 'password';
    let show = state === 'locked';
    if (state === 'unlocked') {
      show = fieldKind === 'new-password' || (await vault.findLogins(sender.origin)).length > 0;
    }
    if (!show) return { show: false };
    const token = await createToken({
      kind: 'dropdown', tabId: sender.tab.id, frameId: sender.frameId,
      documentId: sender.documentId, origin: sender.origin, fieldKind,
    });
    return { show: true, token };
  },

  async 'cs.capture'(msg, sender) {
    const settings = await getSettings();
    const site = parseSite(sender.origin);
    const { username, password } = msg;
    if (!settings.offerToSave || !site) return {};
    if (typeof password !== 'string' || !password || password.length > 1000) return {};
    if (typeof username !== 'string' || username.length > 500) return {};
    const state = await vault.status();
    if (state === 'uninitialized') return {};
    const tabId = sender.tab.id;
    const pending = await resolvePending(tabId, {
      origin: sender.origin, url: sender.url, username, password, createdAt: Date.now(),
    });
    if (!pending) return {};
    await session.set({ ['pending.' + tabId]: pending });
    await pushSavebar(tabId);
    return {};
  },

  // Keyboard shortcut: the focused frame asks to be filled.
  async 'cs.requestFill'(msg, sender) {
    const at = commandAt.get(sender.tab.id);
    if (!at || Date.now() - at > COMMAND_WINDOW) return {};
    commandAt.delete(sender.tab.id);
    const ctx = {
      kind: 'dropdown', tabId: sender.tab.id, frameId: sender.frameId,
      documentId: sender.documentId, origin: sender.origin, fieldKind: 'password',
    };
    const state = await vault.status();
    if (state === 'uninitialized') return {};
    if (state === 'unlocked') {
      const matches = await vault.findLogins(sender.origin);
      if (!matches.length) return {};
      if (matches.length === 1) {
        await fillFrame(ctx, await vault.getLogin(matches[0].id));
        return { filled: true };
      }
    }
    return { dropdown: await createToken(ctx) };
  },
};

const uiHandlers = {
  async 'ui.context'(msg, sender) {
    const kind = msg.kind === 'savebar' ? 'savebar' : 'dropdown';
    const ctx = await readToken(msg.token, sender, kind);
    const state = await vault.status();
    if (kind === 'dropdown') {
      const site = parseSite(ctx.origin);
      const logins = state === 'unlocked'
        ? (await vault.findLogins(ctx.origin)).map(({ id, username, title }) => ({ id, username, title }))
        : [];
      return { state, site: site.displayHost, secure: site.secure, logins, canGenerate: ctx.fieldKind === 'new-password' };
    }
    const raw = await getPending(ctx.tabId);
    const pending = raw && (await resolvePending(ctx.tabId, raw));
    if (!pending) return { gone: true };
    const site = parseSite(pending.origin);
    return {
      state, site: site.displayHost, secure: site.secure,
      username: pending.username, password: pending.password, isUpdate: !!pending.existingId,
    };
  },

  async 'ui.fill'(msg, sender) {
    const ctx = await readToken(msg.token, sender, 'dropdown');
    await fillFrame(ctx, await vault.getLogin(msg.id));
    await closeUi(msg.token, ctx);
    return {};
  },

  async 'ui.useGenerated'(msg, sender) {
    const ctx = await readToken(msg.token, sender, 'dropdown');
    if (typeof msg.password !== 'string' || msg.password.length < 8 || msg.password.length > 128) {
      throw new Error('Bad request.');
    }
    await sendToFrame(ctx, { type: 'bg.fillGenerated', password: msg.password });
    await closeUi(msg.token, ctx);
    return {};
  },

  async 'ui.resize'(msg, sender) {
    const kind = msg.kind === 'savebar' ? 'savebar' : 'dropdown';
    const ctx = await readToken(msg.token, sender, kind);
    const height = Math.max(20, Math.min(600, Number(msg.height) || 0));
    await sendToFrame(ctx, { type: 'bg.resizeUi', token: msg.token, height }).catch(() => {});
    return {};
  },

  async 'ui.close'(msg, sender) {
    const kind = msg.kind === 'savebar' ? 'savebar' : 'dropdown';
    const ctx = await readToken(msg.token, sender, kind);
    await closeUi(msg.token, ctx);
    return {};
  },

  async 'ui.unlock'(msg, sender) {
    await readToken(msg.token, sender, msg.kind === 'savebar' ? 'savebar' : 'dropdown');
    await openUnlock();
    return {};
  },

  async 'ui.openManager'(msg, sender) {
    await readToken(msg.token, sender, 'dropdown');
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/manager/manager.html') });
    return {};
  },

  async 'ui.save'(msg, sender) {
    const ctx = await readToken(msg.token, sender, 'savebar');
    const raw = await getPending(ctx.tabId);
    const pending = raw && (await resolvePending(ctx.tabId, raw));
    if (pending) {
      const username = typeof msg.username === 'string' ? msg.username : pending.username;
      const password = typeof msg.password === 'string' && msg.password ? msg.password : pending.password;
      if (pending.existingId && username === pending.username) {
        await vault.updateLogin(pending.existingId, { password });
      } else {
        await vault.addLogin({ url: pending.origin, username, password });
      }
      await session.remove('pending.' + ctx.tabId);
    }
    await closeUi(msg.token, ctx);
    return {};
  },

  async 'ui.never'(msg, sender) {
    const ctx = await readToken(msg.token, sender, 'savebar');
    const pending = await getPending(ctx.tabId);
    if (pending) {
      await vault.addNeverSave(pending.origin);
      await session.remove('pending.' + ctx.tabId);
    }
    await closeUi(msg.token, ctx);
    return {};
  },

  async 'ui.dismiss'(msg, sender) {
    const ctx = await readToken(msg.token, sender, 'savebar');
    await session.remove('pending.' + ctx.tabId);
    await closeUi(msg.token, ctx);
    return {};
  },
};

const privilegedHandlers = {
  async 'vault.status'() {
    return { state: await vault.status(), settings: await getSettings() };
  },
  async 'vault.create'(msg) {
    await vault.create(msg.password);
    await scheduleAutoLock();
    return {};
  },
  async 'vault.unlock'(msg) {
    await vault.unlock(msg.password);
    await scheduleAutoLock();
    return {};
  },
  async 'vault.lock'() {
    await lockVault();
    return {};
  },

  // Logins for whatever sites are open in the given tab (top page + frames).
  async 'vault.tabLogins'(msg) {
    const frames = (await sessionGet('frames.' + msg.tabId)) ?? {};
    const seen = new Map();
    const top = frames[0] && parseSite(frames[0].origin);
    for (const f of Object.values(frames)) {
      const site = parseSite(f.origin);
      if (site && !seen.has(site.matchKey)) seen.set(site.matchKey, f.origin);
    }
    const logins = [];
    for (const origin of seen.values()) {
      for (const l of await vault.findLogins(origin)) logins.push({ id: l.id, username: l.username, title: l.title, url: l.url });
    }
    return { site: top?.displayHost ?? null, secure: top?.secure ?? true, logins };
  },

  async 'vault.fillTab'(msg) {
    const login = await vault.getLogin(msg.id);
    const want = parseSite(login.url)?.matchKey;
    const frames = (await sessionGet('frames.' + msg.tabId)) ?? {};
    let sent = 0;
    for (const [frameId, f] of Object.entries(frames)) {
      if (parseSite(f.origin)?.matchKey !== want) continue;
      const ctx = { tabId: msg.tabId, frameId: Number(frameId), documentId: f.documentId, origin: f.origin };
      try {
        await fillFrame(ctx, login);
        sent++;
      } catch {
        // frame navigated away or closed
      }
    }
    if (!sent) throw new Error('No login form found on this page.');
    return {};
  },

  async 'vault.list'() {
    return { logins: await vault.listLogins() };
  },
  async 'vault.get'(msg) {
    return { login: await vault.getLogin(msg.id) };
  },
  async 'vault.add'(msg) {
    return { id: await vault.addLogin(msg.login) };
  },
  async 'vault.update'(msg) {
    await vault.updateLogin(msg.id, msg.changes);
    return {};
  },
  async 'vault.delete'(msg) {
    await vault.deleteLogin(msg.id);
    return {};
  },
  async 'vault.import'(msg) {
    if (!Array.isArray(msg.logins)) throw new Error('Bad request.');
    return { result: await vault.importLogins(msg.logins, { overwrite: !!msg.overwrite }) };
  },
  async 'vault.exportCsv'(msg) {
    await vault.verify(msg.password);
    return { csv: toCsv(await vault.exportLogins()) };
  },
  async 'vault.exportBackup'(msg) {
    await vault.verify(msg.password);
    return { backup: await vault.exportBackup() };
  },
  async 'vault.restoreBackup'(msg) {
    await vault.restoreBackup(msg.backup, msg.password);
    await scheduleAutoLock();
    return {};
  },
  async 'vault.neverList'() {
    return { sites: await vault.neverSites() };
  },
  async 'vault.neverRemove'(msg) {
    await vault.removeNeverSave(msg.site);
    return {};
  },
  async 'vault.changePassword'(msg) {
    await vault.changeMasterPassword(msg.current, msg.next);
    return {};
  },
  async 'vault.destroy'(msg) {
    await vault.destroy(msg.password);
    await chrome.alarms.clearAll();
    return {};
  },
  async 'settings.set'(msg) {
    const next = { ...(await getSettings()) };
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (k in msg.settings && typeof msg.settings[k] === typeof DEFAULT_SETTINGS[k]) next[k] = msg.settings[k];
    }
    await local.set({ settings: next });
    if ((await vault.status()) === 'unlocked') await scheduleAutoLock();
    return { settings: next };
  },
  async 'clipboard.clearLater'() {
    const { clipboardClearSeconds } = await getSettings();
    if (clipboardClearSeconds > 0) {
      await chrome.alarms.create('clipboard', { delayInMinutes: Math.max(clipboardClearSeconds, 30) / 60 });
    }
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  const kind = senderKind(sender);
  const table = kind === 'content' ? contentHandlers
    : kind === 'ui' ? uiHandlers
      : kind === 'privileged' ? privilegedHandlers
        : null;
  const handler = table && Object.hasOwn(table, msg.type) ? table[msg.type] : null;
  if (!handler) return false;
  handler(msg, sender)
    .then(async (res) => {
      if (kind !== 'content') await touch();
      sendResponse({ ok: true, ...res });
    })
    .catch((err) => sendResponse({ ok: false, error: err?.message ?? String(err), locked: !!err?.locked }));
  return true;
});

// ---- locking, clipboard, shortcuts, cleanup -------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'autolock') await lockVault();
  if (alarm.name === 'clipboard') await clearClipboard();
});

chrome.idle.onStateChanged.addListener(async (state) => {
  if (state === 'locked' && (await getSettings()).lockOnSystemLock) await lockVault();
});

async function clearClipboard() {
  try {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!existing.length) {
      await chrome.offscreen.createDocument({
        url: 'src/offscreen/clipboard.html',
        reasons: ['CLIPBOARD'],
        justification: 'Clear a copied password from the clipboard.',
      });
    }
    await chrome.runtime.sendMessage({ type: 'offscreen.clearClipboard' });
    await chrome.offscreen.closeDocument();
  } catch {
    // best effort
  }
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'fill-login' || !tab?.id) return;
  commandAt.set(tab.id, Date.now());
  chrome.tabs.sendMessage(tab.id, { type: 'bg.fillFocused' }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const all = await session.get(null);
  const stale = Object.entries(all)
    .filter(([k, v]) => k === 'frames.' + tabId || k === 'pending.' + tabId || (k.startsWith('ui.') && v.tabId === tabId))
    .map(([k]) => k);
  await session.remove(stale);
  commandAt.delete(tabId);
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') await chrome.tabs.create({ url: chrome.runtime.getURL('src/manager/manager.html') });
});
