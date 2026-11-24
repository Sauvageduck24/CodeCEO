// Language support: import extraction, import resolution and public-symbol extraction.
// Deliberately regex-based and dependency-free: good enough to build a useful dependency
// graph and contract surface for most repos. Swap in tree-sitter later behind the same API.
import path from 'node:path';
import { sha1 } from './util.mjs';

const px = path.posix;

const LANGS = {
  js: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte'],
  py: ['.py'],
  go: ['.go'],
  rs: ['.rs'],
  java: ['.java'],
  kt: ['.kt', '.kts'],
  c: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh'],
  rb: ['.rb'],
  php: ['.php'],
  cs: ['.cs'],
};
const EXT_LANG = Object.fromEntries(Object.entries(LANGS).flatMap(([l, es]) => es.map((e) => [e, l])));

export const DOC_EXTS = new Set([
  '.md', '.mdx', '.rst', '.txt', '.json', '.yaml', '.yml', '.toml', '.sql', '.sh', '.css',
  '.scss', '.html', '.proto', '.graphql', '.gradle', '.xml', '.ini', '.cfg',
]);

export const langOf = (file) => EXT_LANG[px.extname(file).toLowerCase()] ?? null;
export const isTextFile = (file) => {
  const e = px.extname(file).toLowerCase();
  return e in EXT_LANG || DOC_EXTS.has(e);
};

const norm = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 160);

// ───────────────────────────── imports ─────────────────────────────
const IMPORTS = {
  js(t) {
    const out = [];
    const res = [
      /\b(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"\n]+)['"]/g,
      /\bimport\s*['"]([^'"\n]+)['"]/g,
      /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
      /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    ];
    for (const r of res) for (const m of t.matchAll(r)) out.push({ spec: m[1] });
    return out;
  },
  py(t) {
    const out = [];
    for (const m of t.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]+)/gm)) {
      const names = m[2]
        .replace(/[()\\]/g, ' ')
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      out.push({ spec: m[1], names });
    }
    for (const m of t.matchAll(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm))
      for (const part of m[1].split(',')) out.push({ spec: part.trim().split(/\s+as\s+/)[0] });
    return out;
  },
  go(t) {
    const out = [];
    for (const m of t.matchAll(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) out.push({ spec: m[1] });
    for (const b of t.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm))
      for (const m of b[1].matchAll(/"([^"]+)"/g)) out.push({ spec: m[1] });
    return out;
  },
  rs(t) {
    const out = [];
    for (const m of t.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+((?:crate|super|self)(?:::\w+)*)/gm)) out.push({ spec: m[1] });
    for (const m of t.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) out.push({ spec: `mod::${m[1]}` });
    return out;
  },
  java(t) {
    return [...t.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm)].map((m) => ({ spec: m[1] }));
  },
  kt(t) {
    return [...t.matchAll(/^\s*import\s+([\w.]+(?:\.\*)?)/gm)].map((m) => ({ spec: m[1] }));
  },
  c(t) {
    return [...t.matchAll(/^\s*#\s*include\s+"([^"]+)"/gm)].map((m) => ({ spec: m[1] }));
  },
  rb(t) {
    const out = [];
    for (const m of t.matchAll(/^\s*require_relative\s+['"]([^'"]+)['"]/gm)) out.push({ spec: `./${m[1]}` });
    for (const m of t.matchAll(/^\s*require\s+['"]([^'"]+)['"]/gm)) out.push({ spec: m[1] });
    return out;
  },
  php(t) {
    const out = [];
    for (const m of t.matchAll(/\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g)) out.push({ spec: m[1] });
    for (const m of t.matchAll(/^\s*use\s+([\w\\]+)\s*(?:as\s+\w+)?\s*;/gm)) out.push({ spec: m[1].replace(/\\/g, '/') });
    return out;
  },
  cs() {
    return [];
  },
};

export function extractImports(lang, text) {
  return IMPORTS[lang]?.(text) ?? [];
}

// ───────────────────────────── resolution ─────────────────────────────
export function makeResolver(filePaths) {
  const set = new Set(filePaths);
  const suffix = new Map();
  const dirs = new Map();
  const push = (m, k, v) => {
    const a = m.get(k);
    if (a) a.push(v);
    else m.set(k, [v]);
  };
  for (const f of filePaths) {
    const segs = f.split('/');
    for (let i = 0; i < segs.length; i++) push(suffix, segs.slice(i).join('/'), f);
    push(dirs, px.dirname(f), f);
  }
  return { set, suffix, dirs };
}

function pick(cands, from) {
  if (cands.length === 1) return cands[0];
  const fs = from.split('/');
  const score = (c) => {
    const cs = c.split('/');
    let i = 0;
    while (i < fs.length - 1 && i < cs.length - 1 && fs[i] === cs[i]) i++;
    return i * 1000 - c.length;
  };
  return [...cands].sort((a, b) => score(b) - score(a))[0];
}

const JS_TRY = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.json'];

function resolveJs(spec, from, R) {
  const bases = [];
  if (spec.startsWith('.')) {
    const b = px.normalize(px.join(px.dirname(from), spec));
    if (b.startsWith('..')) return [];
    bases.push(b);
  } else if (/^[@~]\//.test(spec)) {
    const rest = spec.slice(2);
    bases.push(`src/${rest}`, `app/${rest}`, rest);
  } else return [];
  for (let b of bases) {
    const stripped = b.replace(/\.(?:m|c)?jsx?$/, '');
    for (const base of new Set([b, stripped])) {
      for (const e of JS_TRY) if (R.set.has(base + e) && px.extname(base + e)) return [base + e];
      for (const e of JS_TRY.slice(1)) if (R.set.has(`${base}/index${e}`)) return [`${base}/index${e}`];
    }
  }
  return [];
}

function resolvePy({ spec, names = [] }, from, R) {
  const out = [];
  const tryBase = (base) => [`${base}.py`, `${base}/__init__.py`].find((c) => R.set.has(c)) ?? null;
  const dots = spec.match(/^\.*/)[0].length;
  const rest = spec.slice(dots).split('.').filter(Boolean);
  if (dots) {
    let dir = px.dirname(from);
    for (let i = 1; i < dots; i++) dir = px.dirname(dir);
    const base = rest.length ? px.join(dir, ...rest) : dir;
    const hit = rest.length ? tryBase(base) : R.set.has(px.join(dir, '__init__.py')) ? px.join(dir, '__init__.py') : null;
    if (hit) out.push(hit);
    for (const n of names) {
      const h = tryBase(px.join(base, n));
      if (h) out.push(h);
    }
    return out;
  }
  for (let k = rest.length; k >= 1; k--) {
    const p = rest.slice(0, k).join('/');
    const cands = [`${p}.py`, `${p}/__init__.py`].flatMap((c) => R.suffix.get(c) ?? []);
    if (cands.length) {
      out.push(pick(cands, from));
      break;
    }
  }
  for (const n of names) {
    const p = [...rest, n].join('/');
    const cands = [`${p}.py`, `${p}/__init__.py`].flatMap((c) => R.suffix.get(c) ?? []);
    if (cands.length) out.push(pick(cands, from));
  }
  return out;
}

function resolveGo({ spec }, from, R) {
  if (!spec.split('/')[0].includes('.')) return []; // stdlib-looking
  const segs = spec.split('/');
  for (let i = 0; i < segs.length; i++) {
    const suffix = segs.slice(i).join('/');
    const hits = [];
    for (const [dir, files] of R.dirs) if (dir === suffix || dir.endsWith(`/${suffix}`)) hits.push(...files);
    const go = hits.filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'));
    if (go.length) return go.filter((f) => px.dirname(f) !== px.dirname(from));
  }
  return [];
}

function resolveRs({ spec }, from, R) {
  if (spec.startsWith('mod::')) {
    const name = spec.slice(5);
    const dir = px.dirname(from);
    const stem = px.basename(from, '.rs');
    const bases = ['mod', 'lib', 'main'].includes(stem) ? [dir] : [px.join(dir, stem), dir];
    for (const b of bases) for (const c of [`${b}/${name}.rs`, `${b}/${name}/mod.rs`]) if (R.set.has(c)) return [c];
    return [];
  }
  const parts = spec.split('::').slice(1);
  for (let k = parts.length; k >= 1; k--) {
    const p = parts.slice(0, k).join('/');
    const cands = [`${p}.rs`, `${p}/mod.rs`].flatMap((c) => R.suffix.get(c) ?? []);
    if (cands.length) return [pick(cands, from)];
  }
  return [];
}

function resolveJvm({ spec }, from, R, exts) {
  const p = spec.replace(/\./g, '/');
  if (p.endsWith('/*')) {
    const dir = p.slice(0, -2);
    const out = [];
    for (const [d, files] of R.dirs) if (d === dir || d.endsWith(`/${dir}`)) out.push(...files.filter((f) => exts.some((e) => f.endsWith(e))));
    return out;
  }
  for (const e of exts) {
    const hits = R.suffix.get(p + e);
    if (hits) return [pick(hits, from)];
  }
  const parent = p.split('/').slice(0, -1).join('/'); // static member import
  if (parent) for (const e of exts) if (R.suffix.get(parent + e)) return [pick(R.suffix.get(parent + e), from)];
  return [];
}

function resolveC({ spec }, from, R) {
  const rel = px.normalize(px.join(px.dirname(from), spec));
  if (R.set.has(rel)) return [rel];
  const hits = R.suffix.get(px.normalize(spec));
  return hits ? [pick(hits, from)] : [];
}

function resolveSuffix({ spec }, from, R, exts) {
  if (spec.startsWith('.')) {
    const b = px.normalize(px.join(px.dirname(from), spec));
    for (const e of ['', ...exts]) if (R.set.has(b + e) && px.extname(b + e)) return [b + e];
    return [];
  }
  for (const e of exts) {
    const hits = R.suffix.get(spec + e);
    if (hits) return [pick(hits, from)];
  }
  return [];
}

export function resolveImport(lang, imp, from, R) {
  switch (lang) {
    case 'js': return resolveJs(imp.spec, from, R);
    case 'py': return resolvePy(imp, from, R);
    case 'go': return resolveGo(imp, from, R);
    case 'rs': return resolveRs(imp, from, R);
    case 'java': return resolveJvm(imp, from, R, ['.java']);
    case 'kt': return resolveJvm(imp, from, R, ['.kt', '.java']);
    case 'c': return resolveC(imp, from, R);
    case 'rb': return resolveSuffix(imp, from, R, ['.rb']);
    case 'php': return resolveSuffix(imp, from, R, ['.php']);
    default: return [];
  }
}

// ───────────────────────────── exports (public surface) ─────────────────────────────
function braceBlock(text, from) {
  const i = text.indexOf('{', from);
  if (i < 0 || i - from > 200) return '';
  let depth = 0;
  for (let j = i; j < Math.min(text.length, i + 6000); j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}' && --depth === 0) return text.slice(i, j + 1);
  }
  return '';
}

const EXPORTS = {
  js(t) {
    const out = [];
    const re = /^export\s+(default\s+)?(?:declare\s+)?(async\s+)?(function\*?|class|abstract\s+class|interface|type|enum|const\s+enum|const|let|var)\s+([A-Za-z_$][\w$]*)([^\n{;]*)/gm;
    for (const m of t.matchAll(re)) {
      const kind = m[3].replace(/\s+/g, ' ');
      let rest = m[5];
      if (/^(const|let|var)$/.test(kind) && !/=>|function/.test(rest)) rest = '';
      let sig = norm(`${m[2] ?? ''}${kind} ${m[4]}${rest}`);
      if (/^(interface|type|enum|const enum)$/.test(kind)) {
        const body = braceBlock(t, m.index + m[0].length - m[5].length);
        if (body) sig += ` #${sha1(body.replace(/\s+/g, ' ')).slice(0, 8)}`;
      }
      out.push({ name: m[4], kind, sig });
    }
    for (const m of t.matchAll(/^export\s*\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/gm))
      for (const part of m[1].split(',')) {
        const n = part.trim().split(/\s+as\s+/).pop().trim();
        if (n) out.push({ name: n, kind: 're-export', sig: `export ${n}${m[2] ? ` from ${m[2]}` : ''}` });
      }
    for (const m of t.matchAll(/^export\s+\*(?:\s+as\s+(\w+))?\s+from\s+['"]([^'"]+)['"]/gm))
      out.push({ name: m[1] ?? `*:${m[2]}`, kind: 're-export', sig: `export * from ${m[2]}` });
    for (const m of t.matchAll(/^export\s+default\s+(?!async\b|function\b|class\b)([A-Za-z_$][\w$]*)/gm))
      out.push({ name: 'default', kind: 'default', sig: `default ${m[1]}` });
    for (const m of t.matchAll(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm))
      out.push({ name: m[1], kind: 'cjs', sig: `exports.${m[1]}` });
    for (const m of t.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g))
      for (const part of m[1].split(',')) {
        const n = part.split(':')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(n)) out.push({ name: n, kind: 'cjs', sig: `exports.${n}` });
      }
    return out;
  },
  py(t) {
    const out = [];
    for (const m of t.matchAll(/^(async\s+def|def)\s+([A-Za-z]\w*)\s*\(([^)]*)\)\s*(->\s*[^:\n]+)?:/gm))
      out.push({ name: m[2], kind: 'def', sig: norm(`def ${m[2]}(${m[3]})${m[4] ? ' ' + m[4] : ''}`) });
    for (const m of t.matchAll(/^class\s+([A-Za-z]\w*)\s*(\([^)]*\))?:/gm))
      out.push({ name: m[1], kind: 'class', sig: norm(`class ${m[1]}${m[2] ?? ''}`) });
    for (const m of t.matchAll(/^([A-Z][A-Z0-9_]+)\s*(?::[^=\n]+)?=/gm)) out.push({ name: m[1], kind: 'const', sig: m[1] });
    return out;
  },
  go(t) {
    const out = [];
    for (const m of t.matchAll(/^func\s+(\([^)]*\)\s*)?([A-Z]\w*)\s*(\([^)]*\))\s*([^{\n]*)/gm))
      out.push({ name: m[2], kind: 'func', sig: norm(`func ${m[1] ?? ''}${m[2]}${m[3]} ${m[4]}`) });
    for (const m of t.matchAll(/^type\s+([A-Z]\w*)\s+(struct|interface|\w[^\n{]*)/gm)) {
      let sig = `type ${m[1]} ${m[2].trim()}`;
      if (/^(struct|interface)/.test(m[2])) {
        const body = braceBlock(t, m.index);
        if (body) sig += ` #${sha1(body.replace(/\s+/g, ' ')).slice(0, 8)}`;
      }
      out.push({ name: m[1], kind: 'type', sig: norm(sig) });
    }
    return out;
  },
  rs(t) {
    const out = [];
    for (const m of t.matchAll(/^[ \t]*pub(?:\([^)]*\))?\s+(?:async\s+|unsafe\s+|const\s+)*(fn|struct|enum|trait|type|const|static|mod)\s+(\w+)([^\n{;]*)/gm))
      out.push({ name: m[2], kind: m[1], sig: norm(`${m[1]} ${m[2]}${m[3]}`) });
    return out;
  },
  java(t) {
    const out = [];
    for (const m of t.matchAll(/^\s*public\s+(?:static\s+|final\s+|abstract\s+|sealed\s+)*(class|interface|enum|record)\s+(\w+)([^\n{]*)/gm))
      out.push({ name: m[2], kind: m[1], sig: norm(`${m[1]} ${m[2]}${m[3]}`) });
    for (const m of t.matchAll(/^\s*public\s+(?:static\s+|final\s+|abstract\s+|synchronized\s+)*([\w<>\[\],.? ]+?)\s+(\w+)\s*\(([^)]*)\)/gm))
      if (!['class', 'interface', 'enum', 'record', 'new', 'return'].includes(m[1].trim()))
        out.push({ name: m[2], kind: 'method', sig: norm(`${m[1]} ${m[2]}(${m[3]})`) });
    return out;
  },
  kt(t) {
    const out = [];
    for (const m of t.matchAll(/^\s*(?:public\s+)?(?:suspend\s+|inline\s+|data\s+|sealed\s+|open\s+|abstract\s+)*(fun|class|interface|object)\s+(?:<[^>]*>\s*)?(\w+)([^\n{=]*)/gm)) {
      const line = t.slice(t.lastIndexOf('\n', m.index) + 1, m.index + m[0].length);
      if (/\b(private|internal|protected)\b/.test(line)) continue;
      out.push({ name: m[2], kind: m[1], sig: norm(`${m[1]} ${m[2]}${m[3]}`) });
    }
    return out;
  },
  c(t) {
    const out = [];
    for (const m of t.matchAll(/^(?!\s*(?:static|#|\/\/|return|typedef))[A-Za-z_][\w\s\*&:<>,]*?\s\**(\w+)\s*\(([^;{)]*)\)\s*(?:const\s*)?;/gm))
      out.push({ name: m[1], kind: 'decl', sig: norm(m[0].replace(/;$/, '')) });
    for (const m of t.matchAll(/^(?:class|struct)\s+(\w+)/gm)) out.push({ name: m[1], kind: 'type', sig: m[0] });
    return out;
  },
  rb(t) {
    return [...t.matchAll(/^\s*(def|class|module)\s+(self\.)?([A-Za-z]\w*[?!]?)([^\n]*)/gm)].map((m) => ({
      name: m[3], kind: m[1], sig: norm(`${m[1]} ${m[2] ?? ''}${m[3]}${m[1] === 'def' ? m[4] : ''}`),
    }));
  },
  php(t) {
    const out = [];
    for (const m of t.matchAll(/^\s*(?:abstract\s+|final\s+)?(class|interface|trait)\s+(\w+)/gm)) out.push({ name: m[2], kind: m[1], sig: norm(m[0]) });
    for (const m of t.matchAll(/^\s*public\s+(?:static\s+)?function\s+(\w+)\s*\(([^)]*)\)/gm)) out.push({ name: m[1], kind: 'method', sig: norm(`function ${m[1]}(${m[2]})`) });
    return out;
  },
  cs(t) {
    const out = [];
    for (const m of t.matchAll(/^\s*public\s+(?:static\s+|sealed\s+|abstract\s+|partial\s+)*(class|interface|enum|struct|record)\s+(\w+)/gm))
      out.push({ name: m[2], kind: m[1], sig: norm(m[0]) });
    return out;
  },
};

export function extractExports(lang, text) {
  const seen = new Set();
  return (EXPORTS[lang]?.(text) ?? []).filter((e) => {
    const k = `${e.name}|${e.sig}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

export const ENTRY_RE = /(?:^|\/)(?:index\.(?:[mc]?[jt]sx?)|__init__\.py|mod\.rs|lib\.rs|main\.(?:rs|go|py)|mod\.go)$/;
