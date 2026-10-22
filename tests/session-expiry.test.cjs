const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isLoginTimeoutPage } = require('../dist/automation/auth');
const { createPaymentApplication } = require('../dist/automation/recorded-create');

function textRoot(text, visible = true) {
  return { getByText: pattern => ({ filter: () => ({ count: async () => visible && pattern.test(text) ? 1 : 0 }) }) };
}

test('expiry includes visible iframe prompts and both Chinese login spellings', async () => {
  for (const text of ['登录超时，请重新登录', '登陆超时', '会话已过期']) {
    const main = textRoot('用款申请单'), child = textRoot(text);
    const page = { ...main, url: () => 'https://sapbpm-new.shanghaitech.edu.cn/menu',
      frames: () => [main, child], mainFrame: () => main };
    assert.equal(await isLoginTimeoutPage(page), true);
  }
});

test('hidden timeout templates and generic errors are not authentication failures', async () => {
  const main = textRoot('出现错误：请选择预算项目'), child = textRoot('登录超时', false);
  const page = { ...main, url: () => 'https://sapbpm-new.shanghaitech.edu.cn/menu',
    frames: () => [main, child], mainFrame: () => main };
  assert.equal(await isLoginTimeoutPage(page), false);
});

test('expiry after create or confirmation stops before further creation actions', async () => {
  for (const expireAfter of ['create', 'confirm']) {
    let phase = 'initial';
    const actions = [];
    function control(name) {
      const node = { filter: () => node, first: () => node, waitFor: async () => {},
        count: async () => 1,
        click: async () => { actions.push(name); phase = name; },
        getByRole: () => control('create'), locator: () => control('confirm') };
      return node;
    }
    const page = { url: () => 'https://sapbpm-new.shanghaitech.edu.cn/menu',
      frames: () => [], mainFrame: () => page,
      getByText: pattern => ({ filter: () => ({ count: async () => phase === expireAfter && pattern.test('登录超时') ? 1 : 0 }) }),
      getByRole: () => control('row'), locator: () => control('dialog'),
      waitForTimeout: async () => { throw Error('expiry should stop immediately'); } };
    const ctx = { page, state: {}, setActiveFrame: () => { throw Error('must not adopt editor after expiry'); } };
    await assert.rejects(createPaymentApplication(ctx, 1000), { code: 'authentication' });
    assert.deepEqual(actions, expireAfter === 'create' ? ['create'] : ['create', 'confirm']);
    assert.equal(ctx.state.creationAttempted, true);
  }
});
