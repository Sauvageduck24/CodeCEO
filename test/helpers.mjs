// Builds a small multi-module repo on disk for tests. Thresholds are lowered via config so that a
// handful of files is enough to make the org split.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pad = (n, tag) => Array.from({ length: n }, (_, i) => `// ${tag} filler line ${i}`).join('\n');

export function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeceo-'));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };

  w('.codeceo/config.json', JSON.stringify({ org: { minModuleLoc: 20, maxModuleLoc: 60, maxFilesPerModule: 40 } }));
  w('package.json', '{"name":"shop"}');
  w('src/shared/money.js', `export function formatMoney(cents, currency) { return (cents / 100).toFixed(2) + currency; }\nexport const CURRENCIES = ['EUR', 'USD'];\n${pad(25, 'money')}`);
  w('src/auth/index.js', `export { login } from './login.js';\nexport { hashPassword } from './crypto.js';\n${pad(10, 'auth-index')}`);
  w('src/auth/login.js', `import { hashPassword } from './crypto.js';\nexport async function login(user, password) { return hashPassword(password) === user.hash; }\n${pad(25, 'login')}`);
  w('src/auth/crypto.js', `export function hashPassword(pw) { return 'x' + pw; }\n${pad(25, 'crypto')}`);
  w('src/billing/index.js', `export { charge } from './charge.js';\n${pad(10, 'billing-index')}`);
  w('src/billing/charge.js', `import { formatMoney } from '../shared/money.js';\nimport { login } from '../auth/index.js';\nexport function charge(user, cents) { return formatMoney(cents, 'EUR'); }\n${pad(30, 'invoice stripe payment')}`);
  w('src/catalog/index.js', `export { listProducts } from './products.js';\n${pad(10, 'catalog-index')}`);
  w('src/catalog/products.js', `import { formatMoney } from '../shared/money.js';\nexport function listProducts() { return [{ name: 'Mug', price: formatMoney(900, 'EUR') }]; }\n${pad(30, 'product inventory sku')}`);
  w('README.md', '# shop\n');
  return { root, w, rm: () => fs.rmSync(root, { recursive: true, force: true }) };
}
