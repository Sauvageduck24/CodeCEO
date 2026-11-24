// Small dependency-free helpers shared by the whole core.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
export const estTokens = (s) => Math.ceil((s?.length ?? 0) / 3.7);
export const toPosix = (p) => p.split(path.sep).join('/');
export const uniq = (a) => [...new Set(a)];

export function slugify(p) {
  const s = String(p || '')
    .replace(/^\.?\/+|\/+$/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return s || 'root';
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, text);
    fs.rmSync(tmp, { force: true });
  }
}

export const writeJson = (file, data) => writeText(file, JSON.stringify(data, null, 2) + '\n');

export function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

export function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Minimal glob -> RegExp (supports **, *, ?). Matches posix relative paths. */
export function globToRegExp(glob) {
  let g = glob.replace(/^\.\//, '');
  const anchored = g.startsWith('/');
  if (anchored) g = g.slice(1);
  const dirOnly = g.endsWith('/');
  if (dirOnly) g = g.slice(0, -1);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
        if (g[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const prefix = anchored || g.includes('/') ? '^' : '(?:^|/)';
  return new RegExp(`${prefix}${re}${dirOnly ? '(?:/|$)' : '(?:/.*)?$'}`);
}

export function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object'
        ? deepMerge(base[k], v)
        : v;
  }
  return out;
}

export function trimTo(text, maxTokens) {
  const max = Math.floor(maxTokens * 3.7);
  return text.length <= max ? text : text.slice(0, max) + '\n… (trimmed)';
}
