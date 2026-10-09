const { test } = require('node:test');
const assert = require('node:assert/strict');
const { referenceFormHtml, printedDate, cardNumber, displayDate } = require('../print-form');

test('card prefix and print date use the requested format in Kuala Lumpur', () => {
  assert.equal(cardNumber('MRO-54203'), '54203');
  assert.equal(cardNumber('mro-54203'), '54203');
  assert.equal(printedDate(new Date('2026-10-08T17:00:00Z')), '10/09/2026');
  assert.equal(displayDate(new Date('2026-06-26T16:00:00Z')), '27/06/2026');
});

test('the registration PDF uses the requested document text and date-only header', () => {
  const html = referenceFormHtml({ reference: 'MRO-54203', reference_number: '55022', unhcr_status: 'No', fullname: 'Sample Member',
    phone: '0123456789', country: 'Myanmar', ethnicity: 'Mon', religion: 'Buddhism', gender: 'Male',
    dob: '2007-05-27', arrival: '2026-06-27', consent: 'yes' }, { printedAt: new Date('2026-10-09T07:52:00Z') });
  assert.match(html, /class="printed-date">10\/09\/2026<\/span>/);
  assert.doesNotMatch(html, /Printed:/);
  assert.match(html, /class="card-number">54203/);
  assert.match(html, /Reference number<\/td><\/tr><tr class="value"><td>55022/);
  assert.match(html, /27\/05\/2007/);
  assert.match(html, /Number of additional family members to be registered<\/td><\/tr><tr class="value"><td>0/);
  assert.match(html, /Consent \(Consent\)<\/td><\/tr><tr class="value"><td>Checked/);
  assert.doesNotMatch(html, /Secondary phone number/);
  assert.doesNotMatch(html, /Upload a copy of your passport size photo/);
  assert.equal((html.match(/<td>Other identity documents<\/td>/g) || []).length, 2);
});

test('family members and optional rows are included and escaped', () => {
  const html = referenceFormHtml({ reference_number: '55023', unhcr_status: 'No', fullname: 'Sample <Member>',
    phone2: '0987654321', photo_path: '/private/photos/member.jpg', family_members: 1,
    family_members_in_malaysia: 'Yes', family_members_data: [{ fullname: 'Family & Friend',
      country: 'Myanmar', relationship: 'Wife', dob: '2004-08-04', identity_documents: 'Other identity documents' }],
    identity_documents: 'Other identity documents', consent: 'yes' });
  assert.match(html, /Sample &lt;Member&gt;/);
  assert.match(html, /Family &amp; Friend/);
  assert.match(html, /Secondary phone number \(optional\)/);
  assert.match(html, /member\.jpg/);
  assert.match(html, /1\. Relationship/);
  assert.match(html, /04\/08\/2004/);
  assert.match(html, /Are all family member\(s\) listed here in Malaysia\?/);
  assert.equal((html.match(/<td>Other identity documents<\/td>/g) || []).length, 4);
});
