// This legacy SQLite server exposes documents without the registry's access checks.
// Keep its source for migration reference, but never start the retired HTTP service.
throw new Error('The legacy server is retired. Use npm start (app-server.js) for the authenticated PostgreSQL registry.');

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const { body, validationResult } = require('express-validator');
const morgan = require('morgan');
require('dotenv').config();

const app = express();
const MAX_FAMILY_MEMBERS = 10;
const ALLOWED_IMAGE_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp']
]);
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      return callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'photo'));
    }
    callback(null, true);
  }
});

// Logging
app.use(morgan('combined'));

// Serve static files
app.use(express.static('public'));
app.use('/pdfs', express.static(path.join(__dirname, 'pdfs')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));
app.use('/qr_codes', express.static(path.join(__dirname, 'qr_codes')));

app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Helper: Format date as dd/mm/yyyy
function formatDateToMalaysia(date) {
  if (typeof date === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  }

  const parsedDate = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(parsedDate.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(parsedDate);
}

function isDateNotInFuture(value) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
  return value <= today;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function safeFileSegment(value) {
  const cleaned = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || 'application';
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  }
  return `${req.protocol}://${req.get('host')}`;
}

function unlinkIfExists(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, (error) => {
    if (error && error.code !== 'ENOENT') console.error('Error cleaning up file:', error);
  });
}

// Admin authentication middleware using environment variables
function adminAuth(req, res, next) {
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) {
    return res.status(503).send('Admin access is not configured.');
  }

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Authentication required.');
  }

  let decoded;
  try {
    decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  } catch {
    decoded = '';
  }
  const separator = decoded.indexOf(':');
  const username = separator >= 0 ? decoded.slice(0, separator) : '';
  const password = separator >= 0 ? decoded.slice(separator + 1) : '';
  const supplied = Buffer.from(`${username}\0${password}`);
  const expected = Buffer.from(`${process.env.ADMIN_USER}\0${process.env.ADMIN_PASS}`);
  const isValid = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);

  if (isValid) {
    return next();
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
  return res.status(401).send('Access denied.');
}

// Create or update SQLite database schema (including new fields and family_members_data)
const db = new sqlite3.Database('submissions.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  }
});

function runDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function allDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

const submissionColumns = {
  reference: 'TEXT', unhcr_status: 'TEXT', unhcr_file_number: 'TEXT', individual_number: 'TEXT',
  fullname: 'TEXT', father_name: 'TEXT', mother_name: 'TEXT', email: 'TEXT', phone: 'TEXT',
  phone2: 'TEXT', country: 'TEXT', ethnicity: 'TEXT', religion: 'TEXT', gender: 'TEXT', dob: 'TEXT',
  arrival: 'TEXT', address_state: 'TEXT', photo_path: 'TEXT', family_members: 'TEXT',
  vulnerability: 'TEXT', consent: 'TEXT', family_members_data: 'TEXT'
};

const dbReady = (async () => {
  await runDb(`
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ${Object.entries(submissionColumns).map(([name, type]) => `${name} ${type}`).join(',\n      ')}
    )
  `);

  const existingColumns = new Set((await allDb('PRAGMA table_info(submissions)')).map(column => column.name));
  for (const [name, type] of Object.entries(submissionColumns)) {
    if (!existingColumns.has(name)) await runDb(`ALTER TABLE submissions ADD COLUMN ${name} ${type}`);
  }
})();

// Main form submission route with validation
app.post('/submit',
  upload.single('photo'),
  [
    body('reference').trim().notEmpty().withMessage('Reference is required').isLength({ max: 80 }).withMessage('Reference is too long'),
    body('unhcr_status').isIn(['No', 'Yes']).withMessage('Invalid UNHCR status'),
    body('unhcr_file_number').if(body('unhcr_status').equals('Yes')).trim().notEmpty().withMessage('UNHCR file number is required'),
    body('individual_number').if(body('unhcr_status').equals('Yes')).trim().notEmpty().withMessage('Individual number is required'),
    body('fullname').trim().notEmpty().withMessage('Full name is required').isLength({ max: 160 }).withMessage('Full name is too long'),
    body('email').trim().isEmail().withMessage('Valid email is required').isLength({ max: 254 }).withMessage('Email is too long'),
    body('phone').trim().notEmpty().withMessage('Phone number is required').isLength({ max: 30 }).withMessage('Phone number is too long'),
    body('dob').isISO8601({ strict: true }).withMessage('Valid date of birth is required').bail().custom(isDateNotInFuture).withMessage('Date of birth cannot be in the future'),
    body('arrival').isISO8601({ strict: true }).withMessage('Valid arrival date is required').bail().custom(isDateNotInFuture).withMessage('Arrival date cannot be in the future'),
    body('family_members').isInt({ min: 0, max: MAX_FAMILY_MEMBERS }).withMessage(`Family members must be between 0 and ${MAX_FAMILY_MEMBERS}`),
    body('consent').equals('yes').withMessage('Consent is required')
  ],
  async (req, res) => {
    let photoPath = '';
    let submissionCompleted = false;
    const generatedFilePaths = [];
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      await dbReady;
      // Extract fields
      const {
        reference, unhcr_status, unhcr_file_number, individual_number,
        fullname, father_name, mother_name, email, phone, phone2,
        country, ethnicity, religion, gender, dob, arrival,
        address_state, family_members, vulnerability, consent
      } = req.body;

      // Save uploaded passport photo if provided
      if (req.file) {
        const uploadsDir = path.join(__dirname, 'public', 'uploads');
        fs.mkdirSync(uploadsDir, { recursive: true });
        photoPath = path.join(uploadsDir, req.file.filename + ALLOWED_IMAGE_TYPES.get(req.file.mimetype));
        fs.renameSync(req.file.path, photoPath);
      }

      // Process repeated family member fields
      const familyCount = Number.parseInt(family_members || '0', 10);
      const familyData = [];
      for (let i = 1; i <= familyCount; i++) {
        if (!String(req.body[`fam_${i}_fullname`] || '').trim()) {
          return res.status(400).json({ errors: [{ path: `fam_${i}_fullname`, msg: `Full name is required for family member ${i}` }] });
        }
        const famDOB = req.body[`fam_${i}_dob`] ? formatDateToMalaysia(req.body[`fam_${i}_dob`]) : "";
        const famArrival = req.body[`fam_${i}_arrival`] ? formatDateToMalaysia(req.body[`fam_${i}_arrival`]) : "";
        const fam = {
          fullname: req.body[`fam_${i}_fullname`] || "",
          father_name: req.body[`fam_${i}_father_name`] || "",
          mother_name: req.body[`fam_${i}_mother_name`] || "",
          email: req.body[`fam_${i}_email`] || "",
          phone: req.body[`fam_${i}_phone`] || "",
          phone2: req.body[`fam_${i}_phone2`] || "",
          country: req.body[`fam_${i}_country`] || "",
          ethnicity: req.body[`fam_${i}_ethnicity`] || "",
          religion: req.body[`fam_${i}_religion`] || "",
          gender: req.body[`fam_${i}_gender`] || "",
          dob: famDOB,
          arrival: famArrival,
          address_state: req.body[`fam_${i}_address_state`] || "",
          vulnerability: req.body[`fam_${i}_vulnerability`] || "N/A"
        };
        familyData.push(fam);
      }
      const familyDataJson = JSON.stringify(familyData);

      // Format main dates
      const formattedDOB = dob ? formatDateToMalaysia(dob) : "";
      const formattedArrival = arrival ? formatDateToMalaysia(arrival) : "";

      // Generate passport photo link if exists
      let photoLink = '';
      if (photoPath && fs.existsSync(photoPath)) {
        const photoFilename = path.basename(photoPath);
        photoLink = `${getPublicBaseUrl(req)}/uploads/${encodeURIComponent(photoFilename)}`;
      }

      // Read header logo
      let headerLogoBase64 = '';
      const logoPath = path.join(__dirname, 'public', 'logo.png');
      if (fs.existsSync(logoPath)) {
        const logoBuffer = fs.readFileSync(logoPath);
        headerLogoBase64 = logoBuffer.toString('base64');
      }

      // Generate unique PDF filename and URL
      const safeReference = safeFileSegment(reference);
      const publicId = crypto.randomBytes(16).toString('hex');
      const pdfFilename = `${publicId}.pdf`;
      const pdfsDir = path.join(__dirname, 'pdfs');
      fs.mkdirSync(pdfsDir, { recursive: true });
      const pdfFilePath = path.join(pdfsDir, pdfFilename);
      const pdfUrl = `${getPublicBaseUrl(req)}/pdfs/${encodeURIComponent(pdfFilename)}`;

      // Generate QR code PNG file for PDF URL
      const qrCodesDir = path.join(__dirname, 'qr_codes');
      fs.mkdirSync(qrCodesDir, { recursive: true });
      const qrCodeFilename = `${publicId}-qr.png`;
      const qrCodeFilePath = path.join(qrCodesDir, qrCodeFilename);
      await QRCode.toFile(qrCodeFilePath, pdfUrl, { errorCorrectionLevel: 'H' });
      generatedFilePaths.push(qrCodeFilePath);
      let qrDataUrl = '';
      if (fs.existsSync(qrCodeFilePath)) {
        const qrBuffer = fs.readFileSync(qrCodeFilePath);
        qrDataUrl = 'data:image/png;base64,' + qrBuffer.toString('base64');
      }

      // Current date in Malaysian format
      const dateGenerated = formatDateToMalaysia(new Date());

      // Build HTML for family members display
      let familyMembersHTML = "";
      if (familyCount > 0) {
        familyMembersHTML = `<h3>Additional Family Members</h3>`;
        familyData.forEach((fam, idx) => {
          familyMembersHTML += `
            <div style="margin-bottom: 10px; border: 1px solid #ddd; padding: 10px;">
              <h4>Family Member #${idx + 1}</h4>
              <p><strong>Full Name:</strong> ${escapeHtml(fam.fullname)}</p>
              <p><strong>Father Name:</strong> ${escapeHtml(fam.father_name)}</p>
              <p><strong>Mother Name:</strong> ${escapeHtml(fam.mother_name)}</p>
              <p><strong>Email:</strong> ${escapeHtml(fam.email)}</p>
              <p><strong>Phone:</strong> ${escapeHtml(fam.phone)}</p>
              <p><strong>Second Phone:</strong> ${escapeHtml(fam.phone2)}</p>
              <p><strong>Country:</strong> ${escapeHtml(fam.country)}</p>
              <p><strong>Ethnicity:</strong> ${escapeHtml(fam.ethnicity)}</p>
              <p><strong>Religion:</strong> ${escapeHtml(fam.religion)}</p>
              <p><strong>Gender:</strong> ${escapeHtml(fam.gender)}</p>
              <p><strong>Date of Birth:</strong> ${escapeHtml(fam.dob)}</p>
              <p><strong>Date of Arrival:</strong> ${escapeHtml(fam.arrival)}</p>
              <p><strong>Address (State):</strong> ${escapeHtml(fam.address_state)}</p>
              <p><strong>Vulnerability:</strong> ${escapeHtml(fam.vulnerability)}</p>
            </div>
          `;
        });
      }

      const pdfData = {
        reference: escapeHtml(reference),
        unhcrFileNumber: escapeHtml(unhcr_file_number || 'N/A'),
        individualNumber: escapeHtml(individual_number || 'N/A'),
        fullname: escapeHtml(fullname),
        fatherName: escapeHtml(father_name),
        motherName: escapeHtml(mother_name),
        email: escapeHtml(email),
        phone: escapeHtml(phone),
        phone2: escapeHtml(phone2),
        country: escapeHtml(country),
        ethnicity: escapeHtml(ethnicity),
        religion: escapeHtml(religion),
        gender: escapeHtml(gender),
        addressState: escapeHtml(address_state),
        vulnerability: escapeHtml(vulnerability || 'N/A')
      };

      // Construct PDF HTML content
      const htmlContent = `
      <html>
        <head>
          <style>
            body {
              font-family: Arial, sans-serif;
              margin: 40px;
              background-color: #fff;
              color: #000;
              position: relative;
            }
            .watermark {
              position: fixed;
              top: 40%;
              left: 20%;
              font-size: 60px;
              color: rgba(0,0,0,0.1);
              transform: rotate(-30deg);
              z-index: -1;
            }
            .header {
              text-align: center;
              margin-bottom: 20px;
            }
            .header h1 {
              font-size: 26px;
              margin: 0;
              color: #004080;
            }
            .header h2 {
              font-size: 20px;
              margin: 5px 0 20px 0;
              color: #0066cc;
            }
            .logo {
              text-align: center;
              margin-bottom: 20px;
            }
            .logo img {
              width: 150px;
              height: auto;
              object-fit: contain;
            }
            .field {
              margin-bottom: 15px;
              display: flex;
            }
            .field-label {
              font-weight: bold;
              text-transform: uppercase;
              font-size: 12px;
              background-color: #e0e0e0;
              padding: 5px;
              width: 40%;
            }
            .field-value {
              font-size: 14px;
              margin-left: 10px;
              background-color: #f9f9f9;
              padding: 5px;
              width: 60%;
            }
            .date-field {
              margin-top: 20px;
              display: flex;
            }
            .qr-section {
              margin-top: 20px;
              text-align: center;
            }
            .qr-section img {
              width: 120px;
              height: auto;
            }
            .declaration {
              margin-top: 30px;
              font-style: italic;
              font-size: 12px;
              text-align: justify;
            }
            .footer {
              position: fixed;
              bottom: 20px;
              left: 40px;
              right: 40px;
              text-align: center;
              font-size: 10px;
              color: #666;
            }
          </style>
        </head>
        <body>
          <div class="watermark">Confidential</div>
          <div class="logo">
            ${headerLogoBase64 ? `<img src="data:image/png;base64,${headerLogoBase64}" alt="Logo">` : ''}
          </div>
          <div class="header">
            <h1>Mon Refugee Organization</h1>
            <h2>Membership Form</h2>
          </div>
          <div class="field">
            <div class="field-label">Reference Number:</div>
            <div class="field-value">${pdfData.reference}</div>
          </div>
          <div class="field">
            <div class="field-label">Registered with UNHCR:</div>
            <div class="field-value">${unhcr_status === "Yes" ? "Yes" : "No"}</div>
          </div>
          ${unhcr_status === "Yes" ? `
          <div class="field">
            <div class="field-label">UNHCR File Number:</div>
            <div class="field-value">${pdfData.unhcrFileNumber}</div>
          </div>
          <div class="field">
            <div class="field-label">Individual Number:</div>
            <div class="field-value">${pdfData.individualNumber}</div>
          </div>
          ` : ""}
          <div class="field">
            <div class="field-label">Full Name:</div>
            <div class="field-value">${pdfData.fullname}</div>
          </div>
          <div class="field">
            <div class="field-label">Father Name:</div>
            <div class="field-value">${pdfData.fatherName}</div>
          </div>
          <div class="field">
            <div class="field-label">Mother Name:</div>
            <div class="field-value">${pdfData.motherName}</div>
          </div>
          <div class="field">
            <div class="field-label">Email:</div>
            <div class="field-value">${pdfData.email}</div>
          </div>
          <div class="field">
            <div class="field-label">Phone:</div>
            <div class="field-value">${pdfData.phone}</div>
          </div>
          <div class="field">
            <div class="field-label">Second Phone:</div>
            <div class="field-value">${pdfData.phone2}</div>
          </div>
          <div class="field">
            <div class="field-label">Country:</div>
            <div class="field-value">${pdfData.country}</div>
          </div>
          <div class="field">
            <div class="field-label">Ethnicity:</div>
            <div class="field-value">${pdfData.ethnicity}</div>
          </div>
          <div class="field">
            <div class="field-label">Religion:</div>
            <div class="field-value">${pdfData.religion}</div>
          </div>
          <div class="field">
            <div class="field-label">Gender:</div>
            <div class="field-value">${pdfData.gender}</div>
          </div>
          <div class="field">
            <div class="field-label">Date of Birth:</div>
            <div class="field-value">${formattedDOB}</div>
          </div>
          <div class="field">
            <div class="field-label">Date of Arrival:</div>
            <div class="field-value">${formattedArrival}</div>
          </div>
          <div class="field">
            <div class="field-label">Address (State):</div>
            <div class="field-value">${pdfData.addressState}</div>
          </div>
          <div class="field">
            <div class="field-label">Vulnerability:</div>
            <div class="field-value">${pdfData.vulnerability}</div>
          </div>
          <div class="field">
            <div class="field-label">Passport Photo Link:</div>
            <div class="field-value">
              ${photoLink ? `<a href="${escapeHtml(photoLink)}">View Passport Photo</a>` : "No Photo Uploaded"}
            </div>
          </div>
          ${familyMembersHTML}
          <div class="field date-field">
            <div class="field-label">Date Generated:</div>
            <div class="field-value">${dateGenerated}</div>
          </div>
          <div class="qr-section">
            <div><strong>Scan to view your PDF:</strong></div>
            <img src="${qrDataUrl}" alt="QR Code">
          </div>
          <div class="footer">
            This PDF was generated on ${dateGenerated}. All rights reserved.
          </div>
        </body>
      </html>
      `;

      // Generate PDF using Puppeteer with printBackground enabled
      let browser;
      let pdfBuffer;
      try {
        browser = await puppeteer.launch({
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        await page.emulateMediaType('screen');
        pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
      } finally {
        if (browser) await browser.close();
      }

      // Save the PDF to disk
      fs.writeFileSync(pdfFilePath, pdfBuffer);
      generatedFilePaths.push(pdfFilePath);

      await runDb(`
        INSERT INTO submissions (
          reference, unhcr_status, unhcr_file_number, individual_number,
          fullname, father_name, mother_name, email, phone, phone2,
          country, ethnicity, religion, gender, dob, arrival,
          address_state, photo_path, family_members, vulnerability,
          consent, family_members_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        reference, unhcr_status, unhcr_file_number || '', individual_number || '',
        fullname, father_name || '', mother_name || '', email, phone, phone2 || '',
        country || '', ethnicity || '', religion || '', gender || '', formattedDOB, formattedArrival,
        address_state || '', photoPath, String(familyCount), vulnerability || 'N/A',
        consent, familyDataJson
      ]);
      submissionCompleted = true;

      const smtpConfigured = ['EMAIL_HOST', 'EMAIL_PORT', 'EMAIL_USER', 'EMAIL_PASS']
        .every(name => Boolean(process.env[name]));
      if (smtpConfigured) {
        const emailPort = Number.parseInt(process.env.EMAIL_PORT, 10);
        const transporter = nodemailer.createTransport({
          host: process.env.EMAIL_HOST,
          port: emailPort,
          secure: emailPort === 465,
          auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
          connectionTimeout: 10000,
          greetingTimeout: 10000,
          socketTimeout: 10000
        });

        const mailOptions = {
          from: `"Mon Refugee Organization" <${process.env.EMAIL_USER}>`,
          to: email,
          subject: 'Your Membership Application Form',
          text: `Attached is your membership form PDF. You can also view it online at ${pdfUrl}`,
          attachments: [
            { filename: `membership-${safeReference}.pdf`, path: pdfFilePath },
            { filename: `membership-${safeReference}-qr.png`, path: qrCodeFilePath }
          ]
        };
        if (process.env.EMAIL_CC) mailOptions.cc = process.env.EMAIL_CC;

        try {
          await transporter.sendMail(mailOptions);
        } catch (emailError) {
          console.error('Application saved, but email delivery failed:', emailError.message);
        }
      } else {
        console.warn('Application saved without email: SMTP settings are incomplete.');
      }

      // Send PDF inline in browser
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename=registration.pdf');
      res.setHeader('Content-Length', pdfBuffer.length);
      res.end(pdfBuffer);

    } catch (error) {
      console.error('Error processing submission:', error);
      if (!res.headersSent) res.status(500).send('Unable to process the application. Please try again.');
    } finally {
      if (req.file) unlinkIfExists(req.file.path);
      if (!submissionCompleted) {
        unlinkIfExists(photoPath);
        generatedFilePaths.forEach(unlinkIfExists);
      }
    }
  });

// Admin panel route
app.get('/admin', adminAuth, async (req, res) => {
  try {
    await dbReady;
    const rows = await allDb('SELECT * FROM submissions ORDER BY id DESC');
    let html = `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Admin Dashboard</title>
          <style>
            * { box-sizing: border-box; }
            body { margin: 0; padding: 32px 20px; color: #172033; background: #f4f7fb; font: 16px/1.5 system-ui, sans-serif; }
            main { width: min(100%, 1120px); margin: 0 auto; }
            .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
            h1 { margin: 0; font-size: clamp(1.5rem, 4vw, 2rem); }
            a { display: inline-flex; min-height: 42px; align-items: center; padding: 8px 14px; color: #fff; background: #075d9c; border-radius: 7px; font-weight: 700; text-decoration: none; }
            a:focus-visible { outline: 3px solid rgba(21, 131, 204, .3); outline-offset: 2px; }
            .table-wrap { overflow-x: auto; background: #fff; border: 1px solid #d7dee9; border-radius: 10px; box-shadow: 0 8px 24px rgba(26,48,78,.07); }
            table { width: 100%; min-width: 760px; border-collapse: collapse; }
            th, td { padding: 12px 14px; border-bottom: 1px solid #e2e7ef; text-align: left; vertical-align: top; }
            th { background: #f7f9fc; font-size: .8125rem; letter-spacing: .03em; text-transform: uppercase; }
            tbody tr:last-child td { border-bottom: 0; }
            .empty { padding: 36px; color: #556176; text-align: center; }
            @media (max-width: 560px) { body { padding: 20px 10px; } .toolbar { align-items: stretch; flex-direction: column; } a { justify-content: center; } }
          </style>
        </head>
        <body>
          <main>
            <div class="toolbar">
              <h1>Membership submissions</h1>
              <a href="/export">Export CSV</a>
            </div>
            <div class="table-wrap">
              ${rows.length ? `<table>
                <thead><tr><th>ID</th><th>Reference</th><th>Full name</th><th>Email</th><th>Phone</th><th>Date of birth</th></tr></thead>
                <tbody>${rows.map(row => `<tr>
                  <td>${escapeHtml(row.id)}</td>
                  <td>${escapeHtml(row.reference)}</td>
                  <td>${escapeHtml(row.fullname)}</td>
                  <td>${escapeHtml(row.email)}</td>
                  <td>${escapeHtml(row.phone)}</td>
                  <td>${escapeHtml(row.dob)}</td>
                </tr>`).join('')}</tbody>
              </table>` : '<p class="empty">No submissions yet.</p>'}
            </div>
          </main>
        </body>
      </html>
    `;
    res.send(html);
  } catch (error) {
    console.error('Error fetching submissions:', error);
    res.status(500).send('Internal Server Error');
  }
});

// CSV export route
app.get('/export', adminAuth, async (req, res) => {
  try {
    await dbReady;
    const rows = await allDb('SELECT * FROM submissions ORDER BY id DESC');
    let csv = "ID,Reference,Full Name,Email,Phone,Date of Birth\n";
    rows.forEach(row => {
      csv += [row.id, row.reference, row.fullname, row.email, row.phone, row.dob].map(csvCell).join(',') + '\n';
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=submissions.csv");
    res.send('\uFEFF' + csv);
  } catch (error) {
    console.error('Error exporting submissions:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'Photo must be 2 MB or smaller.'
      : 'Photo must be a JPG, PNG, or WebP image.';
    return res.status(400).json({ errors: [{ path: 'photo', msg: message }] });
  }
  console.error('Unhandled request error:', error);
  return res.status(500).send('Internal Server Error');
});

const PORT = process.env.PORT || 3000;
dbReady.then(() => {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}).catch((error) => {
  console.error('Unable to initialize the database:', error);
  process.exitCode = 1;
});
