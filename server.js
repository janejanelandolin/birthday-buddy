require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const ExcelJS = require('exceljs');
const cron = require('node-cron');
const twilio = require('twilio');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const app = express();
const upload = multer({ dest: 'uploads/' });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.use(express.json());
app.use(express.static('public'));

const DEFAULT_MESSAGE = (firstName) => `Happy Birthday ${firstName}! - from your friends at Birthday Buddy`;

function normalizePhone(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

function normalizeDate(raw) {
  if (!raw) return null;
  if (raw instanceof Date) {
    const m = String(raw.getMonth() + 1).padStart(2, '0');
    const d = String(raw.getDate()).padStart(2, '0');
    const y = raw.getFullYear();
    return `${y}-${m}-${d}`;
  }
  // Accept MM/DD/YYYY, MM-DD-YYYY, YYYY-MM-DD
  const s = String(raw).trim();
  const mdy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2,'0')}-${mdy[2].padStart(2,'0')}`;
  const ymd = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2,'0')}-${ymd[3].padStart(2,'0')}`;
  return null;
}

function insertContact({ first_name, last_name, birthday, phone_number, message }) {
  const stmt = db.prepare(`
    INSERT INTO contacts (first_name, last_name, birthday, phone_number, message)
    VALUES (?, ?, ?, ?, ?)
  `);
  return stmt.run(first_name, last_name, birthday, phone_number, message);
}

// Single contact submission
app.post('/api/contacts', (req, res) => {
  const { first_name, last_name, birthday, phone_number, message } = req.body;
  if (!first_name || !last_name || !birthday || !phone_number) {
    return res.status(400).json({ error: 'first_name, last_name, birthday, and phone_number are required' });
  }
  const normalizedDate = normalizeDate(birthday);
  if (!normalizedDate) return res.status(400).json({ error: 'Invalid birthday format. Use YYYY-MM-DD or MM/DD/YYYY' });

  const finalMessage = message?.trim() || DEFAULT_MESSAGE(first_name);
  const result = insertContact({
    first_name: first_name.trim(),
    last_name: last_name.trim(),
    birthday: normalizedDate,
    phone_number: normalizePhone(phone_number),
    message: finalMessage,
  });
  res.json({ id: result.lastInsertRowid, message: 'Contact added successfully' });
});

// Spreadsheet upload (CSV or XLSX)
app.post('/api/contacts/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const filePath = req.file.path;
  const originalName = req.file.originalname.toLowerCase();
  let rows = [];

  try {
    if (originalName.endsWith('.csv')) {
      const content = fs.readFileSync(filePath, 'utf8');
      rows = parse(content, { columns: true, skip_empty_lines: true, trim: true });
    } else if (originalName.endsWith('.xlsx') || originalName.endsWith('.xls')) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(filePath);
      const sheet = workbook.worksheets[0];
      const headers = [];
      sheet.getRow(1).eachCell((cell) => headers.push(String(cell.value || '').trim().toLowerCase().replace(/\s+/g, '_')));
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const obj = {};
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          obj[headers[colNumber - 1]] = cell.value;
        });
        if (Object.values(obj).some((v) => v !== null && v !== undefined && v !== '')) {
          rows.push(obj);
        }
      });
    } else {
      return res.status(400).json({ error: 'Only .csv, .xlsx, and .xls files are supported' });
    }
  } catch (err) {
    return res.status(400).json({ error: `Failed to parse file: ${err.message}` });
  } finally {
    fs.unlink(filePath, () => {});
  }

  const results = { added: 0, errors: [] };
  const FIELD_MAP = {
    first_name: ['first_name', 'firstname', 'first name'],
    last_name: ['last_name', 'lastname', 'last name'],
    birthday: ['birthday', 'birth_date', 'birthdate', 'date_of_birth', 'dob'],
    phone_number: ['phone_number', 'phone', 'phonenumber', 'mobile', 'cell'],
    message: ['message', 'msg', 'text'],
  };

  function findField(row, aliases) {
    const keys = Object.keys(row).map((k) => k.toLowerCase().replace(/\s+/g, '_'));
    for (const alias of aliases) {
      const idx = keys.indexOf(alias);
      if (idx !== -1) return Object.values(row)[idx];
    }
    return undefined;
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const first_name = String(findField(row, FIELD_MAP.first_name) ?? '').trim();
    const last_name = String(findField(row, FIELD_MAP.last_name) ?? '').trim();
    const birthdayRaw = findField(row, FIELD_MAP.birthday);
    const phone_number = String(findField(row, FIELD_MAP.phone_number) ?? '').trim();
    const messageRaw = String(findField(row, FIELD_MAP.message) ?? '').trim();

    if (!first_name || !last_name || !birthdayRaw || !phone_number) {
      results.errors.push({ row: i + 2, error: 'Missing required fields (first_name, last_name, birthday, phone_number)' });
      continue;
    }

    const birthday = normalizeDate(birthdayRaw);
    if (!birthday) {
      results.errors.push({ row: i + 2, error: `Invalid birthday: ${birthdayRaw}` });
      continue;
    }

    const message = messageRaw || DEFAULT_MESSAGE(first_name);
    try {
      insertContact({ first_name, last_name, birthday, phone_number: normalizePhone(phone_number), message });
      results.added++;
    } catch (err) {
      results.errors.push({ row: i + 2, error: err.message });
    }
  }

  res.json(results);
});

// List all contacts with latest send status
app.get('/api/contacts', (req, res) => {
  const contacts = db.prepare(`
    SELECT c.*,
      s.sent_at, s.message_body AS sent_message, s.error AS send_error, s.year AS sent_year
    FROM contacts c
    LEFT JOIN sent_log s ON s.contact_id = c.id
      AND s.id = (SELECT id FROM sent_log WHERE contact_id = c.id ORDER BY sent_at DESC LIMIT 1)
    ORDER BY c.created_at DESC
  `).all();
  res.json(contacts);
});

// Send now
app.post('/api/contacts/:id/send', async (req, res) => {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const year = new Date().getFullYear();
  try {
    await twilioClient.messages.create({
      body: contact.message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: contact.phone_number,
    });
    db.prepare(`
      INSERT INTO sent_log (contact_id, year, message_body, error)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(contact_id, year) DO UPDATE SET
        sent_at = datetime('now'), message_body = excluded.message_body, error = NULL
    `).run(contact.id, year, contact.message);
    res.json({ message: `Message sent to ${contact.first_name} ${contact.last_name}` });
  } catch (err) {
    db.prepare(`
      INSERT INTO sent_log (contact_id, year, message_body, error)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(contact_id, year) DO UPDATE SET
        sent_at = datetime('now'), message_body = excluded.message_body, error = excluded.error
    `).run(contact.id, year, contact.message, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete a contact
app.delete('/api/contacts/:id', (req, res) => {
  db.prepare('DELETE FROM sent_log WHERE contact_id = ?').run(req.params.id);
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  res.json({ message: 'Contact deleted' });
});

// Daily cron: 9:00 AM server time — send birthday messages
cron.schedule('0 9 * * *', async () => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const year = now.getFullYear();

  const contacts = db.prepare(`
    SELECT c.* FROM contacts c
    WHERE strftime('%m', c.birthday) = ? AND strftime('%d', c.birthday) = ?
    AND NOT EXISTS (
      SELECT 1 FROM sent_log s WHERE s.contact_id = c.id AND s.year = ?
    )
  `).all(month, day, year);

  for (const contact of contacts) {
    try {
      await twilioClient.messages.create({
        body: contact.message,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: contact.phone_number,
      });
      db.prepare(`
        INSERT INTO sent_log (contact_id, year, message_body, error)
        VALUES (?, ?, ?, NULL)
        ON CONFLICT(contact_id, year) DO UPDATE SET
          sent_at = datetime('now'), message_body = excluded.message_body, error = NULL
      `).run(contact.id, year, contact.message);
      console.log(`Sent birthday message to ${contact.first_name} ${contact.last_name} (${contact.phone_number})`);
    } catch (err) {
      db.prepare(`
        INSERT INTO sent_log (contact_id, year, message_body, error)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(contact_id, year) DO UPDATE SET
          sent_at = datetime('now'), message_body = excluded.message_body, error = excluded.error
      `).run(contact.id, year, contact.message, err.message);
      console.error(`Failed to send to ${contact.phone_number}:`, err.message);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Birthday Buddy running on port ${PORT}`));
