// Request baselines: every request a form's chain sends to OA (order, path, headers, each field), compared
// field by field with tests/fixtures/golden/<name>.json. A refactor must leave them unchanged; a deliberate change
// of what is sent is re-recorded with UPDATE_GOLDEN=1 npm test and reviewed in the diff.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const DIR = path.join(__dirname, 'fixtures', 'golden');
/** Values that differ on every run by design. */
const VOLATILE_QUERY = new Set(['_t']);
const ENCRYPTED = new Set(['encryptedPayload']);

/** bpmEncodeURI values are sent percent-encoded twice; decoded here so the baseline reads (and is redacted) as text. */
function decode(value) {
  let text = String(value);
  for (let i = 0; i < 3; i++) {
    let next;
    try { next = decodeURIComponent(text); } catch { break; }
    if (next === text) break;
    text = next;
  }
  if (/^[[{]/.test(text)) { try { return deep(JSON.parse(text)); } catch { /* not JSON */ } }
  return text;
}
const deep = value => (typeof value === 'string' ? decode(value)
  : Array.isArray(value) ? value.map(deep)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item)])) : value);

function headersOf(headers = {}) {
  const entries = headers instanceof Headers ? [...headers] : Object.entries(headers);
  return Object.fromEntries(entries.filter(([key]) => !/^content-length$/i.test(key))
    .map(([key, value]) => [key, /^content-type$/i.test(key) ? String(value).replace(/boundary=.*/, 'boundary=<boundary>') : String(value)])
    .sort(([a], [b]) => a.localeCompare(b)));
}

function multipart(raw, contentType) {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  const text = Buffer.from(raw).toString('latin1');
  return text.split(`--${boundary}`).slice(1, -1).map(part => {
    const [head, ...rest] = part.replace(/^\r\n/, '').split('\r\n\r\n');
    const body = Buffer.from(rest.join('\r\n\r\n').replace(/\r\n$/, ''), 'latin1');
    return { headers: Buffer.from(head, 'latin1').toString('utf8').split('\r\n'), body: body.toString('utf8') };
  });
}

function bodyOf(call) {
  const raw = call.raw;
  if (raw === undefined || raw === null || raw === '') return null;
  const type = Object.entries(headersOf(call.headers)).find(([key]) => /^content-type$/i.test(key))?.[1] ?? '';
  if (/multipart\/form-data/.test(type) || typeof raw !== 'string') {
    const original = call.headers instanceof Headers ? call.headers.get('content-type') : Object.entries(call.headers ?? {})
      .find(([key]) => /^content-type$/i.test(key))?.[1];
    return { multipart: multipart(raw, String(original ?? '')) };
  }
  if (raw.startsWith('{') || raw.startsWith('[')) return { json: deep(JSON.parse(raw)) };
  return { form: [...new URLSearchParams(raw)].map(([key, value]) => [key, ENCRYPTED.has(key) ? '<encrypted>' : decode(value)]) };
}

/** One request as the baseline keeps it. `plain` is the decrypted payload of an encrypted field, when the stub read it. */
function normalize(call) {
  const url = new URL(call.url);
  const query = [...url.searchParams].filter(([key]) => !VOLATILE_QUERY.has(key)).map(([key, value]) => [key, decode(value)]);
  return { method: call.method ?? 'GET', path: url.pathname, ...(query.length ? { query } : {}), headers: headersOf(call.headers),
    body: bodyOf(call), ...(call.plain ? { plain: deep(call.plain) } : {}) };
}

function matchGolden(name, calls) {
  const actual = calls.map(normalize);
  const file = path.join(DIR, `${name}.json`);
  if (process.env.UPDATE_GOLDEN === '1') {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  assert.ok(fs.existsSync(file), `缺少请求基准 ${path.relative(process.cwd(), file)}；确认请求无误后用 UPDATE_GOLDEN=1 npm test 记录。`);
  const expected = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Request by request first, so a difference names the request it is in.
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
    assert.deepEqual(actual[i], expected[i], `请求基准 ${name} 第 ${i + 1} 个请求（${expected[i]?.path ?? actual[i]?.path}）与基准不同`);
  }
}

module.exports = { matchGolden, normalize };
