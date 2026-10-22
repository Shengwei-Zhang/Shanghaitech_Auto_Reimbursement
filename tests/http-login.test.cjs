const test = require('node:test');
const assert = require('node:assert/strict');
const { createDecipheriv } = require('node:crypto');
const login = require('../dist/automation/http-login.js');

const SALT = 'DfvHP2NfLyYy5OfO';
const LOGIN_HTML = `<form class="loginFromClass" method="post" id="phoneFromId" action="/authserver/login">
<input type="hidden" id="cllt" name="cllt" value="dynamicLogin"><input type="hidden" id="execution" name="execution" value="e1s1" /></form>
<form class="loginFromClass" method="post" id="pwdFromId" action="/authserver/login">
<input id="username" name="username" type="text"><input id="password" name="passwordText" type="password">
<input id="saltPassword" name="password" type="hidden">
<span id="showErrorTip" class="form-error"></span>
<input type="hidden" id="_eventId" name="_eventId" value="submit" /><input type="hidden" id="cllt" name="cllt" value="userNameLogin">
<input type="hidden" id="dllt" name="dllt" value="generalLogin"><input type="hidden" name="lt" id="lt" value="" />
<input type="hidden" id="pwdEncryptSalt" value="${SALT}" /><input type="hidden" id="execution" name="execution" value="e1s1" /></form>`;
const BPM_HTML = '<form id="queryMainForm"></form><input type="hidden" id="csrfTokenElement" value="159BB12842D0416DB2346681665A567F">';

function decrypt(cipherText, salt = SALT, iv) {
  const decipher = createDecipheriv('aes-128-cbc', Buffer.from(salt), Buffer.from(iv));
  return Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64')), decipher.final()]).toString('utf8');
}

function response(status, { body = '', location, cookies = [], type = 'text/html' } = {}) {
  const headers = new Headers({ 'content-type': type });
  if (location) headers.set('location', location);
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(status >= 300 && status < 400 ? null : body, { status, headers });
}

/** Replays the shape of the live 2026-10-15 capture. */
function fakeServer({ captcha = false, reject, mfa = false, account = '900001' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { host, pathname, searchParams } = new URL(url);
    calls.push({ url, method: init.method, cookie: init.headers.cookie, body: init.body, redirect: init.redirect });
    if (host === 'ids.shanghaitech.edu.cn' && pathname === '/authserver/login' && init.method === 'GET') {
      if (init.headers.cookie?.includes('CASTGC=tgc')) {
        return response(302, { location: `${decodeURIComponent(searchParams.get('service'))}?ticket=ST-2-bpm` });
      }
      return response(200, { body: LOGIN_HTML, cookies: ['JSESSIONID=ids1; Path=/authserver; Secure; HttpOnly', 'route=r1; Path=/authserver'] });
    }
    if (pathname === '/authserver/checkNeedCaptcha.htl') return response(200, { body: JSON.stringify({ isNeed: captcha }), type: 'application/json' });
    if (pathname === '/authserver/getCaptcha.htl') return response(200, { body: Buffer.from([0xff, 0xd8, 0x00, 0x81]), type: 'image/jpeg' });
    if (pathname === '/authserver/login' && init.method === 'POST') {
      if (reject) return response(401, { body: LOGIN_HTML.replace('<span id="showErrorTip" class="form-error"></span>', `<span id="showErrorTip" class="form-error"><span>${reject}</span></span>`) });
      if (mfa) return response(200, { body: '<div id="reAuthCheck">二次认证</div>' });
      return response(302, { location: 'https://egate-new.shanghaitech.edu.cn/login?ticket=ST-1-egate',
        cookies: ['CASTGC=tgc; Path=/authserver; secure; SameSite=None; HttpOnly', 'platformMultilingual=zh_CN; Domain=edu.cn; Path=/; HttpOnly'] });
    }
    if (host === 'egate-new.shanghaitech.edu.cn' && pathname === '/login' && searchParams.get('ticket')) {
      return response(302, { location: 'https://egate-new.shanghaitech.edu.cn/login', cookies: ['WISCPSID=portal; Path=/; Secure; HttpOnly; SameSite=Lax', 'Secure'] });
    }
    if (host === 'egate-new.shanghaitech.edu.cn' && pathname === '/login') return response(303, { location: '/index.html' });
    if (pathname === '/index.html') return response(200, { body: '<html></html>' });
    if (pathname === '/getLoginUser') {
      return response(200, { type: 'application/json', body: JSON.stringify(init.headers.cookie?.includes('WISCPSID=portal')
        ? { errcode: '0', data: { userAccount: account } } : { errcode: '1' }) });
    }
    if (host === 'sapbpm-new.shanghaitech.edu.cn:9091' && pathname === '/bpm-new/rbReimbursementQuery/forwardRbReimbursementOwnerQuery.do') {
      return response(302, { location: 'https://ids.shanghaitech.edu.cn/authserver/login?service=https%3A%2F%2Fsapbpm-new.shanghaitech.edu.cn%3A9091%2Fbpm-new%2F%2FrbReimbursementQuery%2FforwardRbReimbursementOwnerQuery.do%3Fnull',
        cookies: ['ShanghaiTech=bpm; Path=/bpm-new; Secure; HttpOnly'] });
    }
    if (host === 'sapbpm-new.shanghaitech.edu.cn:9091' && pathname === '/bpm-new//rbReimbursementQuery/forwardRbReimbursementOwnerQuery.do') {
      return init.headers.cookie?.includes('ShanghaiTech=bpm') ? response(200, { body: BPM_HTML }) : response(403);
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
  return { calls, client: new login.OaHttpClient(fetchImpl) };
}

test('encryptPassword follows encrypt.js: AES-CBC(random64 + password, salt, random16)', () => {
  let n = 0;
  const random = length => (n++ === 0 ? 'I'.repeat(length) : 'P'.repeat(length));
  const cipherText = login.encryptPassword('secret', SALT, random);
  assert.equal(cipherText.length, 108);
  assert.equal(decrypt(cipherText, SALT, 'I'.repeat(16)), `${'P'.repeat(64)}secret`);
  assert.throws(() => login.encryptPassword('x', 'short'), { code: 'login_page_unrecognized' });
});

test('parsePasswordLoginForm reads only the account/password form', () => {
  const form = login.parsePasswordLoginForm(LOGIN_HTML);
  assert.deepEqual(form, { salt: SALT, fields: { _eventId: 'submit', cllt: 'userNameLogin', dllt: 'generalLogin', lt: '', execution: 'e1s1' } });
  assert.equal(login.parsePasswordLoginForm(LOGIN_HTML.replace(SALT, '')), undefined);
  assert.equal(login.parsePasswordLoginForm('<form id="phoneFromId"></form>'), undefined);
});

test('CookieJar scopes cookies by host, path and secure, and rejects foreign domains', () => {
  const jar = new login.CookieJar();
  jar.store('https://ids.shanghaitech.edu.cn/authserver/login', ['CASTGC=t; Path=/authserver; Secure', 'Secure', 'x=1; Domain=edu.cn', 'y=2; Domain=example.com']);
  jar.store('https://egate-new.shanghaitech.edu.cn/login', ['WISCPSID=w; Path=/', 'shared=s; Domain=shanghaitech.edu.cn; Path=/']);
  assert.equal(jar.header('https://ids.shanghaitech.edu.cn/authserver/login?service=x'), 'CASTGC=t; shared=s');
  assert.equal(jar.header('https://ids.shanghaitech.edu.cn/other'), 'shared=s');
  assert.equal(jar.header('https://egate-new.shanghaitech.edu.cn/index.html'), 'WISCPSID=w; shared=s');
  jar.store('https://egate-new.shanghaitech.edu.cn/', ['WISCPSID=; Path=/; Max-Age=0']);
  assert.equal(jar.header('https://egate-new.shanghaitech.edu.cn/index.html'), 'shared=s');
  const state = jar.toStorageState();
  assert.deepEqual(state.cookies.map(c => [c.name, c.domain]), [['CASTGC', 'ids.shanghaitech.edu.cn'], ['shared', '.shanghaitech.edu.cn']]);
});

test('loginWithPassword completes CAS, egate and BPM SSO without a browser', async () => {
  const { calls, client } = fakeServer();
  await login.loginWithPassword({ username: '900001', password: 'secret', client });
  const post = calls.find(call => call.method === 'POST');
  const body = new URLSearchParams(post.body);
  assert.deepEqual([...body.keys()], ['username', 'password', 'captcha', '_eventId', 'cllt', 'dllt', 'lt', 'execution']);
  assert.equal(body.get('cllt'), 'userNameLogin');
  assert.equal(body.get('execution'), 'e1s1');
  assert.equal(body.get('password').length, 108);
  assert.notEqual(body.get('password'), 'secret');
  assert.match(post.cookie, /JSESSIONID=ids1/);
  assert.ok(calls.every(call => call.redirect === 'manual'));
  const bpm = await login.establishBpmSession(client);
  assert.equal(bpm.csrfToken, '159BB12842D0416DB2346681665A567F');
  const ticketHop = calls.find(call => call.url.includes('ST-2-bpm'));
  assert.ok(ticketHop, 'BPM ticket issued from CASTGC');
  assert.ok(!client.jar.names().includes('platformMultilingual'), 'public-suffix domain cookie rejected');
});

test('loginWithPassword asks for a captcha only when the server requires it', async () => {
  const { calls, client } = fakeServer({ captcha: true });
  await assert.rejects(login.loginWithPassword({ username: '900001', password: 'secret', client }), { code: 'captcha_required' });
  assert.ok(!calls.some(call => call.method === 'POST'), 'password not submitted');
  const second = fakeServer({ captcha: true });
  let image;
  await login.loginWithPassword({ username: '900001', password: 'secret', client: second.client,
    solveCaptcha: async bytes => { image = bytes; return ' ab12 '; } });
  assert.deepEqual([...image], [0xff, 0xd8, 0x00, 0x81]);
  assert.equal(new URLSearchParams(second.calls.find(call => call.method === 'POST').body).get('captcha'), 'ab12');
});

test('loginWithPassword fails closed on rejection, MFA and account mismatch', async () => {
  await assert.rejects(login.loginWithPassword({ username: '900001', password: 'bad', client: fakeServer({ reject: '您提供的用户名或者密码有误' }).client }),
    error => error.code === 'credentials_rejected' && error.message.includes('您提供的用户名或者密码有误'));
  await assert.rejects(login.loginWithPassword({ username: '900001', password: 'x', client: fakeServer({ mfa: true }).client }),
    { code: 'additional_verification_required' });
  await assert.rejects(login.loginWithPassword({ username: '900001', password: 'x', client: fakeServer({ account: 'other' }).client }),
    { code: 'portal_unverified' });
});

test('OaHttpClient refuses redirects that leave the OA hosts', async () => {
  const client = new login.OaHttpClient(async () => response(302, { location: 'https://open.weixin.qq.com/connect/qrconnect?appid=x' }));
  await assert.rejects(client.request('https://ids.shanghaitech.edu.cn/authserver/login'),
    error => error.code === 'unexpected_redirect' && !error.message.includes('appid'));
});
