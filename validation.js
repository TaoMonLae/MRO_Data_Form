function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function validIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match || Number(match[1]) < 1) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function money(value) {
  let text = String(value ?? '').trim();
  if (!text) return 0;
  text = text.replace(/^RM\s*/i, '');
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) {
    throw invalid('Enter a valid amount, such as 130.00.');
  }
  const number = Number(text.replaceAll(',', ''));
  const rounded = Math.round((number + Math.sign(number) * Number.EPSILON) * 100) / 100;
  if (!Number.isFinite(number) || Math.abs(rounded) > 9999999999.99) throw invalid('The amount is too large.');
  return rounded;
}

function count(value) {
  const text = String(value ?? '').trim();
  if (!text) return 0;
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) > 1000000) {
    throw invalid('Card counts must be whole numbers between 0 and 1,000,000.');
  }
  return Number(text);
}

function importNetAmount(value, amount, deduction) {
  return value == null || String(value).trim() === '' ? money(amount - deduction) : money(value);
}

module.exports = { invalid, validIsoDate, money, count, importNetAmount };
