const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fillPaymentAmount, paymentAmountCents } = require('../dist/automation/payment-amount');

function fixture(values, editable = true) {
  const actions = [];
  let reads = 0;
  const field = {
    filter: () => field, first: () => field, waitFor: async () => {}, count: async () => 1,
    isEditable: async () => editable,
    click: async () => actions.push('click'),
    fill: async text => actions.push(['fill', text]),
    blur: async () => actions.push('blur'),
    inputValue: async () => values[Math.min(reads++, values.length - 1)],
  };
  const ctx = { page: { waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, ms)) } };
  return { field, ctx, actions };
}

test('money comparison tolerates normal display formatting but rejects masks and malformed amounts', () => {
  for (const value of ['200', '200.0', ' 200.00 ']) assert.equal(paymentAmountCents(value), 20000);
  assert.equal(paymentAmountCents('1,200.10'), 120010);
  for (const value of ['', '__________.__', '200.__', '200.', '20,0.00', '200.001', '200元', '0.00']) {
    assert.equal(paymentAmountCents(value), null, value);
  }
});

test('amount is filled directly once and waits for delayed blur formatting', async () => {
  const f = fixture(['0.00', '200.00']);
  await fillPaymentAmount(f.ctx, f.field, '200.00', 1000);
  assert.deepEqual(f.actions, ['click', ['fill', '200.00'], 'blur']);
});

test('fractional money is preserved and thousands grouping accepted', async () => {
  for (const [amount, typed, display] of [
    ['200', '200.00', '200.00'],
    ['200.5', '200.50', '200.50'],
    ['200.05', '200.05', '200.05'],
    ['1200.10', '1200.10', '1,200.10'],
  ]) {
    const f = fixture([display]);
    await fillPaymentAmount(f.ctx, f.field, amount, 1000);
    assert.deepEqual(f.actions[1], ['fill', typed]);
  }
});

test('wrong or unaccepted amounts stop after one input attempt with specific errors', async () => {
  for (const [value, code] of [
    ['20.00', 'payment_amount_mismatch'], ['__________.__', 'payment_amount_input_failed'],
    ['0.00', 'payment_amount_input_failed'],
  ]) {
    const f = fixture([value]);
    await assert.rejects(fillPaymentAmount(f.ctx, f.field, '200.00', 20), { code });
    assert.equal(f.actions.filter(action => Array.isArray(action)).length, 1);
  }
});

test('read-only payment fields are not modified', async () => {
  const f = fixture([''], false);
  await assert.rejects(fillPaymentAmount(f.ctx, f.field, '200.00', 20), { code: 'payment_amount_input_failed' });
  assert.deepEqual(f.actions, []);
});
