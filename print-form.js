const fs = require('node:fs');
const path = require('node:path');

const CONSENT_TEXT = 'I hereby declare that the information provided is true, accurate and giving my permission to UNHCR to use it for the purpose of this form.';

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function displayDate(value) {
  if (!value) return '';
  if (value instanceof Date) return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: '2-digit', year: 'numeric'
  }).format(value);
  const text = String(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : text;
}

function familyData(value) {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

function field(label, value) {
  const text = String(value ?? '').trim();
  return `<tr class="label"><td>${escapeHtml(label)}</td></tr><tr class="value"><td>${escapeHtml(text || '-')}</td></tr>`;
}

function cardNumber(value) {
  return String(value || '').trim().replace(/^MRO-/i, '');
}

function printedDate(date) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kuala_Lumpur', month: '2-digit', day: '2-digit', year: 'numeric' }).format(date);
}

function referenceFormHtml(member, { logoPath = path.join(__dirname, 'public', 'unLogo.png'), printedAt = new Date() } = {}) {
  const logo = fs.existsSync(logoPath) ? `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}` : '';
  const card = cardNumber(member.reference);
  const relatives = familyData(member.family_members_data);
  const familyCount = Math.max(Number(member.family_members) || 0, relatives.length);
  const fields = [
    ['Reference number', member.reference_number],
    ['Are you registered with UNHCR?', member.unhcr_status === 'Yes' ? 'Yes, I am registered' : 'No, I am not registered'],
    ...(member.unhcr_status === 'Yes' ? [['UNHCR file number', member.unhcr_file_number], ['Individual number', member.individual_number]] : []),
    ['Full name', member.fullname],
    ...(member.email ? [['Email', member.email]] : []),
    ['Phone number', member.phone],
    ...(member.phone2 ? [['Secondary phone number (optional)', member.phone2]] : []),
    ['Country of origin', member.country], ['Ethnicity', member.ethnicity], ['Religion', member.religion],
    ['Gender', member.gender], ['Date of birth', displayDate(member.dob)],
    ['Date of arrival in Malaysia', displayDate(member.arrival)],
    ...(member.photo_path ? [['Upload a copy of your passport size photo', path.basename(member.photo_path)]] : []),
    ['I have the following documents (optional) (Checked)', 'Other identity documents'],
    ['I have the following documents (optional) (Other identity documents)', 'Other identity documents'],
    ...(member.identity_document_filename ? [['Upload a copy of your other identity documents', member.identity_document_filename]] : []),
    ['Number of additional family members to be registered', String(familyCount)]
  ];
  if (familyCount) {
    fields.push(['Are all family member(s) listed here in Malaysia?', member.family_members_in_malaysia || '-']);
    for (let index = 0; index < familyCount; index += 1) {
      const relative = relatives[index] || {};
      const prefix = `${index + 1}. `;
      fields.push(
        [`${prefix}Full name`, relative.fullname || relative.name],
        [`${prefix}Country of origin`, relative.country],
        [`${prefix}Ethnicity`, relative.ethnicity],
        [`${prefix}Religion`, relative.religion],
        [`${prefix}Gender`, relative.gender],
        [`${prefix}Relationship`, relative.relationship],
        [`${prefix}Date of birth`, displayDate(relative.dob)],
        [`${prefix}Date of arrival in Malaysia`, displayDate(relative.arrival)]
      );
      if (relative.photo_filename) fields.push([`${prefix}Upload a copy of your passport size photo`, relative.photo_filename]);
      fields.push(
        [`${prefix}I have the following documents (Checked)`, 'Other identity documents'],
        [`${prefix}I have the following documents (${index + 1}. Other identity documents)`, 'Other identity documents']
      );
      if (relative.identity_document_filename) fields.push([`${prefix}Upload a copy of your other identity documents`, relative.identity_document_filename]);
    }
  }
  fields.push(['Consent (Consent)', member.consent === 'yes' ? 'Checked' : 'Not checked'], ['Consent (Text)', CONSENT_TEXT]);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 16mm 15mm; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { color: #111; font: 9pt/1.25 Arial, Helvetica, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .logo { position: relative; height: 23mm; display: flex; justify-content: center; align-items: flex-start; }
    .logo img { display: block; width: 80mm; height: auto; }
    .printed-date { position: absolute; left: 0; top: 0; font-size: 9pt; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; border-left: .5pt solid #d7d7d7; border-right: .5pt solid #d7d7d7; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    td { height: 8.62mm; padding: 0 5px; vertical-align: middle; overflow-wrap: anywhere; }
    thead td { position: relative; padding-left: 7px; background: linear-gradient(to right, #e2e2e2 64%, #fff 64%); border: .5pt solid #d7d7d7; font-size: 10pt; }
    .card-number { position: absolute; left: 64%; top: 0; display: flex; width: 36%; height: 100%; align-items: center; justify-content: center; }
    .label td { background: #e8f1f9; border-top: .5pt solid #e5e5e5; }
    .value td { padding-left: 39px; background: #fff; border-top: .5pt solid #ededed; }
    .value:last-child td { padding-top: 8px; padding-bottom: 8px; border-bottom: .5pt solid #d7d7d7; }
  </style></head><body><header class="logo"><span class="printed-date">${escapeHtml(printedDate(printedAt))}</span>${logo ? `<img src="${logo}" alt="UNHCR">` : ''}</header>
    <table><thead><tr><td>New Registration Request<span class="card-number">${escapeHtml(card)}</span></td></tr></thead><tbody>${fields.map(([label, value]) => field(label, value)).join('')}</tbody></table>
  </body></html>`;
}

module.exports = { referenceFormHtml, familyData, displayDate, cardNumber, printedDate };
