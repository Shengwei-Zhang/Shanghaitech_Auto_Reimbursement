#!/usr/bin/env node
// Skeleton of a new 报销类型 (see docs/architecture.md “新增报销类型”):
//   node scripts/new-form.mjs <slug> <中文名> <OA reimbursementKind>
//   e.g. node scripts/new-form.mjs vehicle 用车报销单 vehicleUse
// Writes four new files and changes nothing else: the type is switched on only by the three lines it prints,
// so the existing 报销类型 cannot be affected by running it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [slug, name, kind] = process.argv.slice(2);
if (!/^[a-z][a-z0-9-]{1,30}$/.test(slug ?? '') || !/^[一-龥（）()]{2,20}$/.test(name ?? '') || !/^[A-Za-z][A-Za-z0-9]{1,40}$/.test(kind ?? '')) {
  console.error('用法：node scripts/new-form.mjs <slug，小写英文> <中文名> <OA 的 reimbursementKind>\n例如：node scripts/new-form.mjs vehicle 用车报销单 vehicleUse');
  process.exit(1);
}
const camel = slug.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const Pascal = camel[0].toUpperCase() + camel.slice(1);
const files = {
  [`src/automation/${slug}/index.ts`]: `/** ${name} over HTTP (OA reimbursementKind ${kind}). Nothing here is shared with another 报销类型; like
 * src/automation/travel/, it uses only the generic OA access (http-login, http-bpm, invoice-claim, http-payee).
 * Build it from a browser recording of the form, one request per function, each write read back. */
import type { OaHttpClient } from '../http-login';
import type { HttpForm } from '../http-bpm';

export const ${camel.toUpperCase().replace(/-/g, '_')}_KIND = '${kind}';

export interface Http${Pascal}Input {
  fundingCode: string;
  attachmentCount: number;
  reason: string;
}

export interface Http${Pascal}Result {
  /** What OA's save answered (saveBizData's bizData), checked against the input. */
  bizData: Record<string, unknown>;
}

export class Http${Pascal}Error extends Error {
  constructor(readonly code: 'not_implemented' | 'invalid_input' | 'authentication' | 'request_failed', message?: string) {
    super(message ?? (code === 'not_implemented' ? '${name}的请求链尚未实现。' : '${name}填写失败。'));
  }
}

/** Fills and saves a blank, opened ${name}; never submits. */
export async function fill${Pascal}FormHttp(_client: OaHttpClient, _form: HttpForm, _input: Http${Pascal}Input): Promise<Http${Pascal}Result> {
  throw new Http${Pascal}Error('not_implemented');
}
`,
  [`src/server/${slug}-api.ts`]: `import { AppError } from '../domain/job';
import { Created, type FormType } from './form-routes';
import type { FormHost } from './oa-session';

/** ${name} on the server: it borrows only the school login (FormHost), like travel-api.ts. Switched on by
 * adding \`${camel}Type(new ${Pascal}Api(this))\` to OaApi.types in oa-api.ts. */
export class ${Pascal}Api {
  constructor(private readonly host: FormHost) {}

  status() {
    return { run: null };
  }

  start(_input: unknown): never {
    void this.host;
    throw new AppError(501, '${name}尚未实现。');
  }
}

/** Routes under /api/oa/${slug}. */
export function ${camel}Type(api: ${Pascal}Api): FormType {
  return { name: '${name}', route: async (method, url, body, context) => {
    switch (\`\${method} \${url.pathname}\`) {
      case 'GET /api/oa/${slug}': return api.status();
      case 'POST /api/oa/${slug}': {
        if (!context.liveEnabled) throw new AppError(403, '真实 OA 执行未启用，请在 .env 中设置 OA_LIVE_ENABLED=true 并重启服务。');
        return new Created(api.start(await body()));
      }
      default: return undefined;
    }
  } };
}
`,
  [`public/js/${slug}.js`]: `/** ${name}: its own fields, checks and submission; shared parts come from core.js, funding.js and invoices.js.
 * Switched on by importing init${Pascal} in main.js and calling it next to the other init calls. */
import { $, api, registerForm, showProblems } from './core.js';

const TYPE = '${name}';

function reset${Pascal}() {}

/** The page's ${name} as POST /api/oa/${slug} takes it, or the problems found. */
function collect${Pascal}() {
  const problems = [];
  if (!$('fund-select').value) problems.push({ text: '请选择经费。', field: 'fund-select' });
  return problems.length ? { problems } : { input: { fundingCode: $('fund-select').value } };
}

async function submit${Pascal}() {
  const claim = collect${Pascal}();
  if (claim.problems) return showProblems(claim.problems);
  await api('POST', '/api/oa/${slug}', { confirmed: true, input: claim.input });
}

function init${Pascal}() {
  registerForm(TYPE, {
    title: \`填写\${TYPE}\`, budgetsPath: '/api/oa/budgets', reset: reset${Pascal}, submit: () => submit${Pascal}(),
    overview: () => ({ eyebrow: \`\${TYPE} · 新建\`, stats: [], checks: [] }),
  });
}

export { init${Pascal} };
`,
  [`tests/${slug}.test.cjs`]: `const test = require('node:test');

// ${name}: before it is switched on, record its requests in a browser, then pin them like the other types:
// a stub of each OA endpoint (see tests/http-travel.test.cjs) and matchGolden('${slug}-…', calls) from ./golden.cjs.
test.todo('请求基准 ${name}: fill and submit send exactly the recorded requests');
test.todo('${name}: a form that is not blank, or input that does not add up, stops before anything is written');
`,
};

const existing = Object.keys(files).filter(file => fs.existsSync(path.join(root, file)));
if (existing.length) {
  console.error(`已存在，未改动任何文件：\n  ${existing.join('\n  ')}`);
  process.exit(1);
}
for (const [file, text] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
  console.log(`  新建 ${file}`);
}
console.log(`
${name}的骨架已生成，尚未启用（现有报销类型不受影响）。实现并测试后，用这三处启用：
  1. src/server/oa-api.ts：import { ${camel}Type, ${Pascal}Api } from './${slug}-api';
     OaApi.types 中加入 ${camel}Type(new ${Pascal}Api(this))
  2. public/js/main.js：import { init${Pascal} } from './${slug}.js'; 并在 initTravel() 之后调用 init${Pascal}()
  3. public/easy-v2.html：把 #claim-type 中“${name}（暂未开放）”改为 <option value="${name}">${name}</option>
然后在 tests/easy-page.spec.ts 中加一条页面流程，运行 npm test。`);
