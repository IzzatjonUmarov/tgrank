// Каждая строка t('…') в пользовательских шаблонах должна иметь узбекский перевод
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const uz = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'locales', 'uz.json'), 'utf8'));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const missing = [];
const files = [...walk(path.join(__dirname, '..', 'views')), path.join(__dirname, '..', 'src', 'bot.js')];
for (const f of files) {
  if (f.includes(`${path.sep}admin${path.sep}`)) continue;
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) {
    const key = m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n');
    if (/[А-Яа-яЁё]/.test(key) && !uz[key]) missing.push(`${path.relative(process.cwd(), f)}: ${key}`);
  }
}
for (const [k, v] of Object.entries(uz)) {
  const params = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  assert.equal(params(v), params(k), `параметры перевода не совпадают: ${k}`);
  assert.ok(!v.includes("'"), `обычный апостроф ломает строки, используйте ʻ или ʼ: ${v}`);
}
assert.deepEqual(missing, [], 'нет перевода:\n' + missing.join('\n'));
console.log(`i18n OK: ${Object.keys(uz).length} переводов`);
