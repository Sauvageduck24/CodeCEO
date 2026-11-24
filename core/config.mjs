// Project-level configuration and the on-disk layout of `.codeceo/`.
import fs from 'node:fs';
import path from 'node:path';
import { deepMerge, readJson } from './util.mjs';

export const DIR = '.codeceo';

export const DEFAULT_CONFIG = {
  version: 1,
  auto: true, // CodeCEO mode: route every ordinary message through the zone agents (`codeceo mode off` pauses it)
  include: [],
  exclude: [],
  maxFileBytes: 524288,
  org: {
    maxModuleLoc: 6000, // a module larger than this is split into sub-agents
    minModuleLoc: 300, // a directory smaller than this does not get its own agent
    maxFilesPerModule: 80,
    maxDepth: 4,
    hysteresis: 0.7, // avoids agents flapping in and out of existence
    titles: ['CEO', 'Director', 'Lead', 'Engineer'],
  },
  retrieval: {
    chunkLines: 60,
    topK: 8,
    embeddings: null, // { "module": "./providers/openai-compatible.mjs" } — optional semantic layer
  },
  permissions: {
    strictRead: false, // true: an agent may only read its own files + the modules it depends on
    sharedWritable: [], // globs every agent may write (e.g. "docs/CHANGELOG.md")
  },
  budget: { packetTokens: 6000 },
  public: {}, // { "<agent-id>": ["src/auth/index.ts"] } — declared public entry points
};

export const storePath = (root, ...p) => path.join(root, DIR, ...p);

export function loadConfig(root) {
  return deepMerge(DEFAULT_CONFIG, readJson(storePath(root, 'config.json'), {}));
}

/** Nearest ancestor holding `.codeceo`, else nearest git root, else `start`. */
export function findRoot(start = process.cwd()) {
  const up = (marker) => {
    let dir = path.resolve(start);
    for (;;) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  };
  return up(DIR) ?? up('.git') ?? path.resolve(start);
}

export const isInitialized = (root) => fs.existsSync(storePath(root, 'org.json'));
