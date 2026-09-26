import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './chrome-mock.js';

const chrome = installChromeMock();
const vault = await import('../../extension/src/lib/vault.js');
const MASTER = 'correct horse battery staple';

function diskText() {
  return JSON.stringify(chrome.storage.local._data());
}

before(async () => {
  await vault.create(MASTER);
});

test('create -> unlocked, add and find logins', async () => {
  assert.equal(await vault.status(), 'unlocked');
  const id = await vault.addLogin({ url: 'https://github.com/login', username: 'octo', password: 'hunter2-secret' });
  await vault.addLogin({ url: 'https://gitlab.com', username: 'other', password: 'x' });
  const found = await vault.findLogins('https://www.github.com/session');
  assert.equal(found.length, 1);
  assert.equal(found[0].id, id);
  assert.equal(found[0].password, undefined, 'suggestions must not contain passwords');
  assert.equal((await vault.getLogin(id)).password, 'hunter2-secret');
  assert.equal((await vault.findLogins('http://github.com')).length, 0, 'https login not offered on http');
});

test('nothing sensitive is stored on disk in plaintext', async () => {
  const text = diskText();
  for (const secret of ['hunter2-secret', 'octo', 'github', MASTER]) {
    assert.ok(!text.includes(secret), `"${secret}" leaked to disk`);
  }
});

test('lock wipes the key; wrong password is rejected and throttled', async () => {
  await vault.lock();
  assert.equal(await vault.status(), 'locked');
  assert.deepEqual(chrome.storage.session._data(), {});
  await assert.rejects(vault.findLogins('https://github.com'), /locked/);
  await assert.rejects(vault.unlock('wrong password 1'), /Wrong/);
  await assert.rejects(vault.unlock('wrong password 2'), /Wrong/);
  await assert.rejects(vault.unlock('wrong password 3'), /Wrong/);
  await assert.rejects(vault.unlock(MASTER), /Too many/);
  await chrome.storage.local.set({ 'vault.failures': { count: 3, until: 0 } });
  await vault.unlock(MASTER);
  assert.equal(await vault.status(), 'unlocked');
  assert.equal((await vault.findLogins('https://github.com')).length, 1);
});

test('tampered ciphertext is detected', async () => {
  const [id] = Object.keys(chrome.storage.local._data()['vault.index']);
  const entry = chrome.storage.local._data()['entry.' + id];
  const original = entry.secret;
  const other = Object.keys(chrome.storage.local._data()['vault.index'])[1];
  entry.secret = chrome.storage.local._data()['entry.' + other].secret; // swap blobs
  await assert.rejects(vault.getLogin(id));
  entry.secret = original;
});

test('import de-duplicates and respects overwrite', async () => {
  const r1 = await vault.importLogins([
    { url: 'https://github.com', username: 'octo', password: 'hunter2-secret' },
    { url: 'https://github.com', username: 'octo', password: 'changed' },
    { url: 'https://new.example', username: 'n', password: 'p' },
    { url: 'not a url', username: 'n', password: 'p' },
  ]);
  assert.deepEqual(r1, { added: 1, updated: 0, duplicates: 1, conflicts: 1, invalid: 1 });
  const r2 = await vault.importLogins([{ url: 'https://github.com', username: 'octo', password: 'changed' }], { overwrite: true });
  assert.equal(r2.updated, 1);
  const [gh] = await vault.findLogins('https://github.com');
  assert.equal((await vault.getLogin(gh.id)).password, 'changed');
});

test('never-save list is encrypted', async () => {
  await vault.addNeverSave('https://bank.example/login');
  assert.ok(await vault.isNeverSave('https://www.bank.example/other'));
  assert.ok(!diskText().includes('bank.example'));
  await vault.removeNeverSave('https://bank.example');
  assert.ok(!(await vault.isNeverSave('https://bank.example')));
});

test('change master password keeps data', async () => {
  await assert.rejects(vault.changeMasterPassword('nope nope nope', 'another long passphrase'), /wrong/);
  await chrome.storage.local.remove('vault.failures');
  await vault.changeMasterPassword(MASTER, 'another long passphrase');
  await vault.lock();
  await assert.rejects(vault.unlock(MASTER));
  await chrome.storage.local.remove('vault.failures');
  await vault.unlock('another long passphrase');
  assert.equal((await vault.listLogins()).length, 3);
});

test('encrypted backup restores', async () => {
  const backup = await vault.exportBackup();
  assert.ok(!JSON.stringify(backup).includes('octo'));
  await vault.deleteLogin((await vault.listLogins())[0].id);
  await assert.rejects(vault.restoreBackup(backup, 'bad password here'), /Wrong/);
  await vault.restoreBackup(backup, 'another long passphrase');
  assert.equal((await vault.listLogins()).length, 3);
});
