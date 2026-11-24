// Repository scanning: list text files (git-aware), read them, hash them.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { globToRegExp, sha1, toPosix } from './util.mjs';
import { isTextFile, langOf } from './lang.mjs';
import { storePath } from './config.mjs';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.codeceo', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.venv',
  'venv', '__pycache__', '.idea', '.vscode', 'coverage', '.gradle', 'vendor', '.cache', '.turbo', 'obj',
]);
const SKIP_FILES = /(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|\.min\.(?:js|css)|\.map)$/;

function walk(root) {
  const out = [];
  const rec = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) rec(path.join(dir, e.name));
      } else if (e.isFile()) out.push(toPosix(path.relative(root, path.join(dir, e.name))));
    }
  };
  rec(root);
  return out;
}

export function listFiles(root, cfg) {
  let list = null;
  if (fs.existsSync(path.join(root, '.git'))) {
    try {
      list = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
    } catch {
      list = null;
    }
  }
  list ??= walk(root);

  let ignoreFile = [];
  try {
    ignoreFile = fs.readFileSync(path.join(root, '.codeceoignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch {}
  const excl = [...cfg.exclude, ...ignoreFile].map(globToRegExp);
  const incl = cfg.include.map(globToRegExp);

  return list
    .filter((f) => !f.split('/').some((s) => SKIP_DIRS.has(s)))
    .filter((f) => isTextFile(f) && !SKIP_FILES.test(f))
    .filter((f) => !excl.some((r) => r.test(f)))
    .filter((f) => !incl.length || incl.some((r) => r.test(f)))
    .sort();
}

const manifestFile = (root) => storePath(root, 'manifest.json');

function loadManifest(root) {
  try {
    return JSON.parse(fs.readFileSync(manifestFile(root), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Scan the repo. `text: false` skips reading unchanged files (mtime+size cache) — used for
 * cheap staleness checks. With `text: true` every file's content is returned (for indexing).
 */
export function scan(root, cfg, { text = true } = {}) {
  const cache = loadManifest(root);
  const next = {};
  const files = [];
  for (const rel of listFiles(root, cfg)) {
    const abs = path.join(root, rel);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > cfg.maxFileBytes) continue;
    const c = cache[rel];
    let hash;
    let loc;
    let body;
    if (!text && c && c.m === st.mtimeMs && c.s === st.size) {
      ({ h: hash, l: loc } = c);
    } else {
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) continue; // binary
      body = buf.toString('utf8');
      hash = sha1(body);
      loc = body.split('\n').reduce((n, l) => n + (l.trim() ? 1 : 0), 0);
    }
    next[rel] = { m: st.mtimeMs, s: st.size, h: hash, l: loc };
    files.push({ path: rel, lang: langOf(rel), loc, size: st.size, hash, ...(text ? { text: body ?? fs.readFileSync(abs, 'utf8') } : {}) });
  }
  try {
    fs.mkdirSync(path.dirname(manifestFile(root)), { recursive: true });
    fs.writeFileSync(manifestFile(root), JSON.stringify(next));
  } catch {}
  return files;
}
