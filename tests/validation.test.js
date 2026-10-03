const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validIsoDate, money, count, importNetAmount } = require('../validation');

test('calendar validation rejects impossible dates while retaining leap days', () => {
  assert.equal(validIsoDate('2024-02-29'), '2024-02-29');
  for (const value of ['2025-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '2026-01-01junk']) assert.equal(validIsoDate(value), null);
});

test('money parsing preserves formatted values and refuses silent corruption', () => {
  assert.equal(money('RM 1,250.50'), 1250.5);
  assert.equal(money('0'), 0);
  assert.equal(money('-25.50'), -25.5);
  for (const value of ['1e3', 'abc', '1,2', 'NaN', '12.3.4', '10000000000']) assert.throws(() => money(value), { status: 400 });
});

test('card counts reject rounding, negative counts and overflow', () => {
  assert.equal(count('25'), 25);
  assert.equal(count(''), 0);
  for (const value of [-1, '1.5', '1e3', '2000000000']) assert.throws(() => count(value), { status: 400 });
});

test('finance imports retain explicit zero and derive only missing net amounts', () => {
  assert.equal(importNetAmount('0', 100, 20), 0);
  assert.equal(importNetAmount('', 100, 20), 80);
  assert.equal(importNetAmount(null, 100, 20), 80);
});
