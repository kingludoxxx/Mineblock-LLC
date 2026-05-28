import { execSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import Database from 'better-sqlite3';

const safePw = execSync('security find-generic-password -wa "Chrome" -s "Chrome Safe Storage"').toString().trim();
const key = pbkdf2Sync(safePw, 'saltysalt', 1003, 16, 'sha1');
const iv  = Buffer.alloc(16, ' '.charCodeAt(0));

function decrypt(encrypted) {
  if (!encrypted || encrypted.length < 4) return null;
  const prefix = encrypted.slice(0, 3).toString();
  if (prefix !== 'v10' && prefix !== 'v11') return null;
  const ciphertext = encrypted.slice(3);
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  // Recent Chrome versions prepend SHA256(host) (32 bytes) to mitigate cookie swapping.
  // Strip if first 32 bytes are non-printable.
  if (out.length > 32 && out[0] < 32) return out.subarray(32).toString('utf8');
  return out.toString('utf8');
}

const db = new Database('/tmp/chrome-test-profile/Default/Cookies', { readonly: true });
const rows = db.prepare("SELECT host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies WHERE host_key LIKE '%mineblock-dashboard%'").all();
const out = rows.map(r => ({
  name: r.name,
  value: decrypt(r.encrypted_value),
  domain: r.host_key,
  path: r.path,
  expires: r.expires_utc ? Math.floor((r.expires_utc - 11644473600000000) / 1000000) : -1,
  httpOnly: !!r.is_httponly,
  secure: !!r.is_secure,
  sameSite: ['Strict','Lax','None'][r.samesite] || 'Lax',
}));
console.log(JSON.stringify(out, null, 2));
