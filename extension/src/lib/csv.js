// CSV import for password exports from other browsers / managers.
//
// Supported (auto-detected from the header row):
//   Brave, Chrome, Edge, Opera, Vivaldi, Helium  name,url,username,password,note
//   Firefox                                      url,username,password,httpRealm,...
//   Safari                                       Title,URL,Username,Password,Notes,OTPAuth
//   Bitwarden                                    ...,name,notes,login_uri,login_username,login_password,...
//   1Password                                    Title,Url,Username,Password,Notes,...
//   LastPass                                     url,username,password,totp,extra,name,grouping,fav

import { parseSite } from './url.js';

// RFC 4180 parser: quoted fields, escaped quotes, CRLF/LF, newlines inside quotes.
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

const COLUMNS = {
  url: ['url', 'login_uri', 'website', 'web site', 'login url', 'uri', 'origin', 'hostname'],
  username: ['username', 'login_username', 'login', 'user', 'email', 'user name', 'login name'],
  password: ['password', 'login_password', 'pass'],
  title: ['name', 'title'],
  notes: ['note', 'notes', 'extra', 'comments'],
};

function findColumn(header, names) {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i !== -1) return i;
  }
  return -1;
}

// Returns { logins: [{url, username, password, title, notes}], skipped: [{row, reason}] }
export function loginsFromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 1) throw new Error('The file is empty.');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, findColumn(header, names)]));
  if (col.url === -1 || col.password === -1) {
    throw new Error('This does not look like a password export (needs "url" and "password" columns).');
  }

  const logins = [];
  const skipped = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const get = (k) => (col[k] === -1 ? '' : (cells[col[k]] ?? '').trim());
    const password = col.password === -1 ? '' : cells[col.password] ?? '';
    const rawUrl = get('url');
    const site = parseSite(rawUrl, { assumeHttps: true });
    if (!password) {
      skipped.push({ row: r + 1, reason: 'no password' });
    } else if (!site) {
      skipped.push({ row: r + 1, reason: `not a website (${rawUrl.slice(0, 40) || 'empty'})` });
    } else {
      logins.push({
        url: /^https?:\/\//i.test(rawUrl) ? rawUrl : site.origin,
        username: get('username'),
        password,
        title: get('title'),
        notes: get('notes'),
      });
    }
  }
  return { logins, skipped };
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Chrome/Brave-compatible export so the file can be imported anywhere.
export function toCsv(logins) {
  const lines = ['name,url,username,password,note'];
  for (const l of logins) {
    lines.push([l.title, l.url, l.username, l.password, l.notes].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}
