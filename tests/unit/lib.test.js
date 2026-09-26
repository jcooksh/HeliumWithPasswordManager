import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, loginsFromCsv, toCsv } from '../../extension/src/lib/csv.js';
import { parseSite, matchKey } from '../../extension/src/lib/url.js';
import { generatePassword, estimateBits } from '../../extension/src/lib/generator.js';
import * as c from '../../extension/src/lib/crypto.js';

test('csv parser handles quotes, commas, newlines and BOM', () => {
  const rows = parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","multi\nline"\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x, y', 'say "hi"', 'multi\nline']]);
});

test('imports a Brave/Chrome export', () => {
  const csv = 'name,url,username,password,note\n'
    + 'github.com,https://github.com/login,me@example.com,"p,a""ss",\n'
    + 'app,android://abc@com.example/,u,p,\n'
    + 'empty,https://example.com/,u,,\n';
  const { logins, skipped } = loginsFromCsv(csv);
  assert.equal(logins.length, 1);
  assert.deepEqual(logins[0], { url: 'https://github.com/login', username: 'me@example.com', password: 'p,a"ss', title: 'github.com', notes: '' });
  assert.equal(skipped.length, 2);
});

test('imports Firefox, Bitwarden and Safari exports', () => {
  const ff = loginsFromCsv('"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n"https://a.com","u1","p1",,"https://a.com","{x}","1","1","1"\n');
  assert.equal(ff.logins[0].username, 'u1');
  const bw = loginsFromCsv('folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,Site,note here,,0,https://b.com,u2,p2,\n');
  assert.deepEqual([bw.logins[0].url, bw.logins[0].username, bw.logins[0].password, bw.logins[0].notes], ['https://b.com', 'u2', 'p2', 'note here']);
  const sf = loginsFromCsv('Title,URL,Username,Password,Notes,OTPAuth\nc.com,c.com,u3,p3,,\n');
  assert.equal(sf.logins[0].url, 'https://c.com');
});

test('rejects files that are not password exports', () => {
  assert.throws(() => loginsFromCsv('a,b\n1,2\n'), /password export/);
});

test('csv export round-trips', () => {
  const rows = [{ title: 't', url: 'https://x.com', username: 'u', password: 'p"q,r\ns', notes: '' }];
  const back = loginsFromCsv(toCsv(rows)).logins[0];
  assert.equal(back.password, 'p"q,r\ns');
});

test('site matching: scheme, host (www-insensitive) and port', () => {
  assert.equal(matchKey('https://www.Example.com/login'), 'https://example.com');
  assert.equal(matchKey('https://example.com:8443/'), 'https://example.com:8443');
  assert.notEqual(matchKey('http://example.com'), matchKey('https://example.com'));
  assert.notEqual(matchKey('https://evil-example.com'), matchKey('https://example.com'));
  assert.notEqual(matchKey('https://example.com.evil.net'), matchKey('https://example.com'));
  assert.equal(parseSite('javascript:alert(1)'), null);
  assert.equal(parseSite('file:///etc/passwd'), null);
  assert.equal(parseSite('http://localhost:3000').secure, true);
  assert.equal(parseSite('http://example.com').secure, false);
});

test('generator honours length and character classes', () => {
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword({ length: 16 });
    assert.equal(pw.length, 16);
    assert.match(pw, /[a-z]/);
    assert.match(pw, /[A-Z]/);
    assert.match(pw, /[0-9]/);
    assert.match(pw, /[^a-zA-Z0-9]/);
  }
  assert.doesNotMatch(generatePassword({ length: 30, symbols: false }), /[^a-zA-Z0-9]/);
  assert.ok(estimateBits('correct horse battery staple') > estimateBits('password'));
});

test('AES-GCM rejects wrong AAD (entries cannot be swapped)', async () => {
  const { encKey } = await c.importVaultKey(c.randomBytes(32));
  const box = await c.encryptJSON(encKey, { password: 'x' }, 'secret:a');
  assert.deepEqual(await c.decryptJSON(encKey, box, 'secret:a'), { password: 'x' });
  await assert.rejects(c.decryptJSON(encKey, box, 'secret:b'));
});
