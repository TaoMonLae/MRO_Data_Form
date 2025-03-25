const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const { body, validationResult } = require('express-validator');
const morgan = require('morgan');
require('dotenv').config();

const app = express();
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 2 * 1024 * 1024 } // 2MB file limit
});

// Logging
app.use(morgan('combined'));

// Serve static files
app.use(express.static('public'));
app.use('/pdfs', express.static(path.join(__dirname, 'pdfs')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));
app.use('/qr_codes', express.static(path.join(__dirname, 'qr_codes')));

app.use(bodyParser.urlencoded({ extended: true }));

// Helper: Format date as dd/mm/yyyy
function formatDateToMalaysia(date) {
  const d = new Date(date);
  const day = ("0" + d.getDate()).slice(-2);
  const month = ("0" + (d.getMonth() + 1)).slice(-2);
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

// Admin authentication middleware using environment variables
function adminAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Authentication required.');
  }
  const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  const username = credentials[0];
  const password = credentials[1];
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    return next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Access denied.');
  }
}

// Create or update SQLite database schema (including new fields and family_members_data)
const db = new sqlite3.Database('submissions.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    db.run(`
      CREATE TABLE IF NOT EXISTS submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reference TEXT,
        unhcr_status TEXT,
        unhcr_file_number TEXT,
        individual_number TEXT,
        fullname TEXT,
        father_name TEXT,
        mother_name TEXT,
        email TEXT,
        phone TEXT,
        phone2 TEXT,
        country TEXT,
        ethnicity TEXT,
        religion TEXT,
        gender TEXT,
        dob TEXT,
        arrival TEXT,
        address_state TEXT,
        photo_path TEXT,
        family_members TEXT,
        vulnerability TEXT,
        consent TEXT,
        family_members_data TEXT
      )
    `);
  }
});

// Main form submission route with validation
app.post('/submit',
  upload.single('photo'),
  [
    body('reference').trim().notEmpty().withMessage('Reference is required'),
    body('fullname').trim().notEmpty().withMessage('Full name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('phone').trim().notEmpty().withMessage('Phone number is required'),
    body('dob').notEmpty().withMessage('Date of birth is required'),
    body('arrival').notEmpty().withMessage('Date of arrival is required')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      // Extract fields
      const {
        reference, unhcr_status, unhcr_file_number, individual_number,
        fullname, father_name, mother_name, email, phone, phone2,
        country, ethnicity, religion, gender, dob, arrival,
        address_state, family_members, vulnerability, consent
      } = req.body;

      // Save uploaded passport photo if provided
      let photoPath = '';
      if (req.file) {
        const uploadsDir = path.join(__dirname, 'public', 'uploads');
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
        photoPath = path.join(uploadsDir, req.file.filename + path.extname(req.file.originalname));
        fs.renameSync(req.file.path, photoPath);
      }

      // Process repeated family member fields
      const familyCount = parseInt(family_members || "0", 10);
      let familyData = [];
      for (let i = 1; i <= familyCount; i++) {
        const famDOB = req.body[`fam_${i}_dob`] ? formatDateToMalaysia(req.body[`fam_${i}_dob`]) : "";
        const famArrival = req.body[`fam_${i}_arrival`] ? formatDateToMalaysia(req.body[`fam_${i}_arrival`]) : "";
        let fam = {
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

      // Insert data into DB
      const stmt = db.prepare(`
        INSERT INTO submissions (
          reference, unhcr_status, unhcr_file_number, individual_number,
          fullname, father_name, mother_name, email, phone, phone2,
          country, ethnicity, religion, gender, dob, arrival,
          address_state, photo_path, family_members, vulnerability,
          consent, family_members_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        reference, unhcr_status, unhcr_file_number, individual_number,
        fullname, father_name, mother_name, email, phone, phone2,
        country, ethnicity, religion, gender, formattedDOB, formattedArrival,
        address_state, photoPath, family_members, vulnerability,
        consent, familyDataJson
      );
      stmt.finalize();

      // Generate passport photo link if exists
      let photoLink = '';
      if (photoPath && fs.existsSync(photoPath)) {
        const photoFilename = path.basename(photoPath);
        const PORT = process.env.PORT || 3000;
        photoLink = `http://localhost:${PORT}/uploads/${photoFilename}`;
      }

      // Read header logo
      let headerLogoBase64 = '';
      const logoPath = path.join(__dirname, 'public', 'logo.png');
      if (fs.existsSync(logoPath)) {
        const logoBuffer = fs.readFileSync(logoPath);
        headerLogoBase64 = logoBuffer.toString('base64');
      }

      // Generate unique PDF filename and URL
      const pdfFilename = `${Date.now()}-${reference}.pdf`;
      const pdfsDir = path.join(__dirname, 'pdfs');
      if (!fs.existsSync(pdfsDir)) fs.mkdirSync(pdfsDir);
      const pdfFilePath = path.join(pdfsDir, pdfFilename);
      const PORT = process.env.PORT || 3000;
      const pdfUrl = `http://localhost:${PORT}/pdfs/${pdfFilename}`;

      // Generate QR code PNG file for PDF URL
      const qrCodesDir = path.join(__dirname, 'qr_codes');
      if (!fs.existsSync(qrCodesDir)) fs.mkdirSync(qrCodesDir);
      const qrCodeFilename = `${Date.now()}-${reference}-qr.png`;
      const qrCodeFilePath = path.join(qrCodesDir, qrCodeFilename);
      await QRCode.toFile(qrCodeFilePath, pdfUrl, { errorCorrectionLevel: 'H' });
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
              <p><strong>Full Name:</strong> ${fam.fullname}</p>
              <p><strong>Father Name:</strong> ${fam.father_name}</p>
              <p><strong>Mother Name:</strong> ${fam.mother_name}</p>
              <p><strong>Email:</strong> ${fam.email}</p>
              <p><strong>Phone:</strong> ${fam.phone}</p>
              <p><strong>Second Phone:</strong> ${fam.phone2}</p>
              <p><strong>Country:</strong> ${fam.country}</p>
              <p><strong>Ethnicity:</strong> ${fam.ethnicity}</p>
              <p><strong>Religion:</strong> ${fam.religion}</p>
              <p><strong>Gender:</strong> ${fam.gender}</p>
              <p><strong>Date of Birth:</strong> ${fam.dob}</p>
              <p><strong>Date of Arrival:</strong> ${fam.arrival}</p>
              <p><strong>Address (State):</strong> ${fam.address_state}</p>
              <p><strong>Vulnerability:</strong> ${fam.vulnerability}</p>
            </div>
          `;
        });
      }

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
            <div class="field-value">${reference}</div>
          </div>
          <div class="field">
            <div class="field-label">Registered with UNHCR:</div>
            <div class="field-value">${unhcr_status === "Yes" ? "Yes" : "No"}</div>
          </div>
          ${unhcr_status === "Yes" ? `
          <div class="field">
            <div class="field-label">UNHCR File Number:</div>
            <div class="field-value">${unhcr_file_number || "N/A"}</div>
          </div>
          <div class="field">
            <div class="field-label">Individual Number:</div>
            <div class="field-value">${individual_number || "N/A"}</div>
          </div>
          ` : ""}
          <div class="field">
            <div class="field-label">Full Name:</div>
            <div class="field-value">${fullname}</div>
          </div>
          <div class="field">
            <div class="field-label">Father Name:</div>
            <div class="field-value">${father_name || ""}</div>
          </div>
          <div class="field">
            <div class="field-label">Mother Name:</div>
            <div class="field-value">${mother_name || ""}</div>
          </div>
          <div class="field">
            <div class="field-label">Email:</div>
            <div class="field-value">${email}</div>
          </div>
          <div class="field">
            <div class="field-label">Phone:</div>
            <div class="field-value">${phone}</div>
          </div>
          <div class="field">
            <div class="field-label">Second Phone:</div>
            <div class="field-value">${phone2 || ""}</div>
          </div>
          <div class="field">
            <div class="field-label">Country:</div>
            <div class="field-value">${country}</div>
          </div>
          <div class="field">
            <div class="field-label">Ethnicity:</div>
            <div class="field-value">${ethnicity}</div>
          </div>
          <div class="field">
            <div class="field-label">Religion:</div>
            <div class="field-value">${religion}</div>
          </div>
          <div class="field">
            <div class="field-label">Gender:</div>
            <div class="field-value">${gender}</div>
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
            <div class="field-value">${address_state || ""}</div>
          </div>
          <div class="field">
            <div class="field-label">Vulnerability:</div>
            <div class="field-value">${vulnerability || "N/A"}</div>
          </div>
          <div class="field">
            <div class="field-label">Passport Photo Link:</div>
            <div class="field-value">
              ${photoLink ? `<a href="${photoLink}" target="_blank">View Passport Photo</a>` : "No Photo Uploaded"}
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
      const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      const page = await browser.newPage();
      await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
      await page.emulateMediaType('screen');
      const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
      await browser.close();

      // Save the PDF to disk
      fs.writeFileSync(pdfFilePath, pdfBuffer);

      // Create email transporter with explicit SMTP configuration for Gmail
      const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: parseInt(process.env.EMAIL_PORT),
        secure: false, // true for port 465, false for 587
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
        },
        connectionTimeout: 10000,  // 10 seconds
        greetingTimeout: 10000,
        socketTimeout: 10000,
        logger: true,
        debug: true
      });


      const mailOptions = {
        from: `"Mon Refugee Organization" <${process.env.EMAIL_USER}>`,
        to: email,
        cc: "taomonlae@gmail.com",
        subject: 'Your Membership Application Form',
        text: `Attached is your membership form PDF. Thank you for your contribution.You can also view it online at ${pdfUrl}`,
        attachments: [
          { filename: pdfFilename, path: pdfFilePath },
          { filename: qrCodeFilename, path: qrCodeFilePath }
        ]
      };

      console.log("Sending email to:", email);
      console.log("SMTP user:", process.env.EMAIL_USER);

      await transporter.sendMail(mailOptions);
      console.log("Email sent successfully");

      // Send PDF inline in browser
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename=registration.pdf');
      res.setHeader('Content-Length', pdfBuffer.length);
      res.end(pdfBuffer);

    } catch (error) {
      console.error('Error processing submission:', error);
      res.status(500).send('Internal Server Error');
    }
  });

// Admin panel route
app.get('/admin', adminAuth, (req, res) => {
  db.all("SELECT * FROM submissions", (err, rows) => {
    if (err) {
      console.error('Error fetching submissions:', err);
      return res.status(500).send("Internal Server Error");
    }
    let html = `
      <html>
        <head>
          <title>Admin Dashboard</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            table { border-collapse: collapse; width: 100%; }
            th, td { border: 1px solid #ddd; padding: 8px; }
            th { background-color: #f2f2f2; }
          </style>
        </head>
        <body>
          <h2>Admin Dashboard - Submissions</h2>
          <a href="/export" target="_blank">Export CSV</a>
          <table>
            <tr>
              <th>ID</th>
              <th>Reference</th>
              <th>Full Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Date of Birth</th>
            </tr>`;
    rows.forEach(row => {
      html += `
        <tr>
          <td>${row.id}</td>
          <td>${row.reference}</td>
          <td>${row.fullname}</td>
          <td>${row.email}</td>
          <td>${row.phone}</td>
          <td>${row.dob}</td>
        </tr>`;
    });
    html += `</table>
        </body>
      </html>
    `;
    res.send(html);
  });
});

// CSV export route
app.get('/export', adminAuth, (req, res) => {
  db.all("SELECT * FROM submissions", (err, rows) => {
    if (err) {
      console.error('Error fetching submissions:', err);
      return res.status(500).send("Internal Server Error");
    }
    let csv = "ID,Reference,Full Name,Email,Phone,Date of Birth\n";
    rows.forEach(row => {
      csv += `${row.id},"${row.reference}","${row.fullname}","${row.email}","${row.phone}","${row.dob}"\n`;
    });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=submissions.csv");
    res.send(csv);
  });
});

// Admin auth middleware using env variables
function adminAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Authentication required.');
  }
  const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  const username = credentials[0];
  const password = credentials[1];
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    return next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Access denied.');
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
