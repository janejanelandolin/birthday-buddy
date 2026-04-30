// Tab switching
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
});

// Toast
function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast ${type} show`;
  setTimeout(() => toast.classList.remove('show'), 3500);
}

// Format birthday for display
function formatBirthday(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${m}/${d}/${y}`;
}

// Load contacts
async function loadContacts() {
  const tbody = document.getElementById('contacts-body');
  try {
    const res = await fetch('/api/contacts');
    const contacts = await res.json();
    if (!contacts.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">No contacts yet. Add one above!</td></tr>';
      return;
    }
    tbody.innerHTML = contacts.map((c) => `
      <tr>
        <td>${escHtml(c.first_name)} ${escHtml(c.last_name)}</td>
        <td>${formatBirthday(c.birthday)}</td>
        <td>${escHtml(c.phone_number)}</td>
        <td class="msg-cell" title="${escHtml(c.message)}">${escHtml(c.message)}</td>
        <td>${renderStatus(c)}</td>
        <td><button class="log-btn" onclick="toggleLog(${c.id}, this)">▶ View</button></td>
        <td class="actions-cell">
          <button class="send-btn" onclick="sendNow(${c.id}, this)" title="Send now">Send Now</button>
          <button class="delete-btn" onclick="deleteContact(${c.id})" title="Remove">✕</button>
        </td>
      </tr>
      <tr class="log-row" id="log-row-${c.id}" style="display:none">
        <td colspan="7" class="log-cell">
          <div id="log-content-${c.id}" class="log-content">Loading...</div>
        </td>
      </tr>
    `).join('');
  } catch {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">Failed to load contacts.</td></tr>';
  }
}

function renderStatus(c) {
  if (!c.sent_at) {
    return `<span class="badge badge-scheduled">Scheduled</span>`;
  }
  if (c.send_error) {
    return `<span class="badge badge-failed" title="${escHtml(c.send_error)}">Failed</span>
            <div class="status-detail error-detail">${escHtml(c.send_error)}</div>`;
  }
  const sentDate = new Date(c.sent_at + 'Z');
  const formatted = sentDate.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
  const preview = c.sent_message ? escHtml(c.sent_message) : '';
  return `<span class="badge badge-sent">Sent</span>
          <div class="status-detail">${formatted}</div>
          ${preview ? `<div class="status-msg" title="${preview}">${preview}</div>` : ''}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function toggleLog(id, btn) {
  const row = document.getElementById(`log-row-${id}`);
  const content = document.getElementById(`log-content-${id}`);
  const isOpen = row.style.display !== 'none';
  if (isOpen) {
    row.style.display = 'none';
    btn.textContent = '▶ View';
    return;
  }
  row.style.display = '';
  btn.textContent = '▼ Hide';
  content.textContent = 'Loading...';
  try {
    const res = await fetch(`/api/contacts/${id}/attempts`);
    const attempts = await res.json();
    if (!attempts.length) {
      content.innerHTML = '<p class="log-empty">No send attempts yet.</p>';
      return;
    }
    content.innerHTML = `
      <table class="log-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Trigger</th>
            <th>Result</th>
            <th>Message Sent</th>
            <th>Twilio SID</th>
            <th>Failure Reason</th>
          </tr>
        </thead>
        <tbody>
          ${attempts.map((a) => `
            <tr class="${a.success ? 'log-success' : 'log-fail'}">
              <td>${new Date(a.attempted_at + 'Z').toLocaleString()}</td>
              <td><span class="trigger-badge trigger-${a.trigger}">${a.trigger}</span></td>
              <td>${a.success ? '<span class="badge badge-sent">Sent</span>' : '<span class="badge badge-failed">Failed</span>'}</td>
              <td class="log-msg" title="${escHtml(a.message_body || '')}">${escHtml(a.message_body || '—')}</td>
              <td class="log-sid">${a.twilio_sid ? `<code>${escHtml(a.twilio_sid)}</code>` : '—'}</td>
              <td class="log-error">${a.error ? escHtml(a.error) : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch {
    content.innerHTML = '<p class="log-empty">Failed to load log.</p>';
  }
}

async function sendNow(id, btn) {
  if (!confirm('Send this message immediately?')) return;
  btn.disabled = true;
  btn.textContent = 'Sending...';
  try {
    const res = await fetch(`/api/contacts/${id}/send`, { method: 'POST' });
    const json = await res.json();
    if (res.ok) {
      showToast(json.message);
    } else {
      showToast(json.error || 'Failed to send', 'error');
    }
    // Refresh log row if it's open
    const logRow = btn.closest('tr').nextElementSibling;
    if (logRow && logRow.style.display !== 'none') {
      const contactId = id;
      const logBtn = btn.closest('tr').querySelector('.log-btn');
      toggleLog(contactId, logBtn);
      toggleLog(contactId, logBtn);
    }
    loadContacts();
  } catch {
    showToast('Network error', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Now';
  }
}

async function deleteContact(id) {
  if (!confirm('Remove this contact from the campaign?')) return;
  const res = await fetch(`/api/contacts/${id}`, { method: 'DELETE' });
  if (res.ok) {
    showToast('Contact removed');
    loadContacts();
  } else {
    showToast('Failed to remove contact', 'error');
  }
}

// Single entry form
document.getElementById('single-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = {
    first_name: form.first_name.value,
    last_name: form.last_name.value,
    birthday: form.birthday.value,
    phone_number: form.phone_number.value,
    message: form.message.value,
  };
  try {
    const res = await fetch('/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (res.ok) {
      showToast('Contact added and scheduled!');
      form.reset();
      loadContacts();
    } else {
      showToast(json.error || 'Failed to add contact', 'error');
    }
  } catch {
    showToast('Network error', 'error');
  }
});

// File upload — drag & drop + browse
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const uploadBtn = document.getElementById('upload-btn');
const fileNameEl = document.getElementById('file-name');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) setFile(file);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });

function setFile(file) {
  fileNameEl.textContent = file.name;
  uploadBtn.disabled = false;
  fileInput._selectedFile = file;
}

document.getElementById('upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = fileInput.files[0] || fileInput._selectedFile;
  if (!file) return showToast('Please select a file', 'error');

  const formData = new FormData();
  formData.append('file', file);
  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Uploading...';

  try {
    const res = await fetch('/api/contacts/upload', { method: 'POST', body: formData });
    const json = await res.json();
    if (res.ok) {
      let msg = `${json.added} contact(s) scheduled`;
      if (json.errors.length) msg += `, ${json.errors.length} row(s) skipped`;
      showToast(msg, json.errors.length && !json.added ? 'error' : 'success');
      fileNameEl.textContent = '';
      fileInput.value = '';
      fileInput._selectedFile = null;
      loadContacts();
    } else {
      showToast(json.error || 'Upload failed', 'error');
    }
  } catch {
    showToast('Network error', 'error');
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload & Schedule';
  }
});

document.getElementById('refresh-btn').addEventListener('click', loadContacts);

loadContacts();
