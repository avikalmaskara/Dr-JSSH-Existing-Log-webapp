/**
 * Dr. JSSH Existing Log — Apps Script backend.
 * Bound to the "Dr. J.S.S.H Existing A.C log" spreadsheet (Extensions → Apps Script).
 *
 * Tabs:
 *   Log            — one row per AC entry, Log No = JSSH/<FY>/<0001>
 *   Dashboard Edit — audit trail of every change made from the in-app dashboard
 *   EON_Team       — who may sign in (created automatically on first run if missing)
 *
 * Every function the browser calls returns {success: true, ...} or {success: false, error: "..."}.
 */

const CONFIG = {
  APP_NAME: 'Dr. JSSH Existing Log',
  LOG_SHEET: 'Log',
  EDIT_SHEET: 'Dashboard Edit',
  TEAM_SHEET: 'EON_Team',
  ID_PREFIX: 'JSSH',
  PHOTO_ROOT_FOLDER_NAME: 'Dr. JSSH Existing Log Photos',
  PENDING_FOLDER_NAME: '_pending uploads',
  OWNER_EMAIL: 'director@eonsales.in',
  SESSION_TTL_SECONDS: 365 * 24 * 60 * 60,
  OTP_TTL_SECONDS: 10 * 60,
  OTP_MAX_ATTEMPTS: 5,
  OTP_RESEND_GAP_SECONDS: 45,
  TEAM_CACHE_SECONDS: 5 * 60,
  MAX_PHOTOS_PER_ENTRY: 6,
  MAX_ENTRIES_PER_SUBMIT: 40,
  MAX_PHOTO_BYTES: 4 * 1024 * 1024
};

// Tap options shown on the form. "Other" (type your own) is added by the app for every group.
const OPTIONS = {
  floors: ['Ground', '1st', '2nd', '3rd', '4th', '5th', 'Divine Pathway'],
  acStatus: ['Existing', 'Existing (Dismantle)', 'New Required'],
  brands: ['Voltas', 'Lloyd', 'Panasonic', 'Godrej', 'LG'],
  tonnage: ['1.0 T - 3★', '1.5 T - 3★', '2.0 T - 3★', '5.5 T', '8.5 T', '11.0 T']
};

const NEW_REQUIRED_STATUS = 'New Required';

// Columns are found by header text, so they can be reordered in the sheet.
// Missing headers are appended automatically on first use.
const LOG_FIELDS = [
  { key: 'logNo', header: 'Log No' },
  { key: 'area', header: 'Area/Room No' },
  { key: 'floor', header: 'Floor' },
  { key: 'acStatus', header: 'AC Status' },
  { key: 'brand', header: 'Brand' },
  { key: 'tonnage', header: 'Tonnage' },
  { key: 'qty', header: 'Qty' },
  { key: 'photos', header: 'Photo' },
  { key: 'remarks', header: 'Remarks' },
  { key: 'enteredBy', header: 'Entered By' },
  { key: 'loggedAt', header: 'Logged At' },
  { key: 'lastEditedBy', header: 'Last Edited By' },
  { key: 'lastEditedAt', header: 'Last Edited At' }
];
const EDITABLE_KEYS = ['area', 'floor', 'acStatus', 'brand', 'tonnage', 'qty', 'photos', 'remarks'];
const EDIT_LOG_HEADERS = ['Timestamp', 'Log No', 'Field', 'Old Value', 'New Value', 'Edited By'];
const TEAM_HEADERS = ['Name', 'Role', 'Email ID', 'Attachment Access', 'Status'];

/* ------------------------------------------------------------------ */
/* Web app entry + triggers                                            */
/* ------------------------------------------------------------------ */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(CONFIG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

// Simple trigger: an edit on the team tab takes effect on the next click instead of after the 5-min cache.
// Log/Dashboard data is never cached server-side, so manual edits there are always picked up live.
function onEdit(e) {
  try {
    const sheetName = e && e.range ? e.range.getSheet().getName() : '';
    if (normalizeName_(sheetName) === normalizeName_(CONFIG.TEAM_SHEET)) {
      CacheService.getScriptCache().remove('team_list_v1');
    }
  } catch (err) {
    // onEdit must never interrupt someone typing in the sheet.
  }
}

/* ------------------------------------------------------------------ */
/* Sign-in: emailed one-time code → signed session token               */
/* ------------------------------------------------------------------ */

function requestOtp(email) {
  return respond_(function () {
    const cleanEmail = normalizeEmail_(email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) throw userError_('Enter a valid email address.');

    const member = findMember_(cleanEmail);
    if (!member) throw userError_('Access Denied — this email is not on the EON Team list.');

    const cache = CacheService.getScriptCache();
    const gapKey = 'otp_gap_' + cleanEmail;
    if (cache.get(gapKey)) throw userError_('A code was just sent. Please wait a few seconds before asking again.');

    const code = String(Math.floor(100000 + Math.random() * 900000));
    cache.put('otp_' + cleanEmail, JSON.stringify({ hash: sha256_(code), attempts: 0 }), CONFIG.OTP_TTL_SECONDS);
    cache.put(gapKey, '1', CONFIG.OTP_RESEND_GAP_SECONDS);

    MailApp.sendEmail({
      to: cleanEmail,
      subject: CONFIG.APP_NAME + ' sign-in code: ' + code,
      name: CONFIG.APP_NAME,
      htmlBody:
        '<div style="font-family:Arial,sans-serif;font-size:15px;color:#1f2d3d">' +
        '<p>Hi ' + escapeHtml_(member.name || '') + ',</p>' +
        '<p>Your sign-in code for <b>' + CONFIG.APP_NAME + '</b> is:</p>' +
        '<p style="font-size:30px;letter-spacing:6px;font-weight:bold;color:#1565c0">' + code + '</p>' +
        '<p>It expires in 10 minutes. If you did not ask for this, ignore this email.</p></div>'
    });
    return { resendAfterSeconds: CONFIG.OTP_RESEND_GAP_SECONDS };
  });
}

function verifyOtp(email, code) {
  return respond_(function () {
    const cleanEmail = normalizeEmail_(email);
    const cleanCode = String(code || '').replace(/\D/g, '');
    if (cleanCode.length !== 6) throw userError_('Enter the 6-digit code from the email.');

    const cache = CacheService.getScriptCache();
    const key = 'otp_' + cleanEmail;
    const stored = cache.get(key);
    if (!stored) throw userError_('This code has expired. Ask for a new one.');

    const record = JSON.parse(stored);
    if (record.hash !== sha256_(cleanCode)) {
      record.attempts += 1;
      if (record.attempts >= CONFIG.OTP_MAX_ATTEMPTS) {
        cache.remove(key);
        throw userError_('Too many wrong tries. Ask for a new code.');
      }
      cache.put(key, JSON.stringify(record), CONFIG.OTP_TTL_SECONDS);
      throw userError_('Wrong code. ' + (CONFIG.OTP_MAX_ATTEMPTS - record.attempts) + ' tries left.');
    }
    cache.remove(key);

    const member = findMember_(cleanEmail);
    if (!member) throw userError_('Access Denied — this email is not on the EON Team list.');
    return { token: signToken_(cleanEmail), user: publicUser_(member) };
  });
}

/* ------------------------------------------------------------------ */
/* App data                                                            */
/* ------------------------------------------------------------------ */

// Called once after sign-in / page load. Always a live read.
function getBootstrap(token) {
  return respond_(function () {
    const member = authenticate_(token);
    ensureSheets_();
    return { user: publicUser_(member), options: OPTIONS, areas: readAreaList_() };
  });
}

// "Refresh list" link — live read of every Area/Room No already used.
function getAreaList(token) {
  return respond_(function () {
    authenticate_(token);
    return { areas: readAreaList_() };
  });
}

function uploadPhoto(token, photo) {
  return respond_(function () {
    const member = authenticate_(token);
    if (!photo || typeof photo.base64 !== 'string') throw userError_('No photo received.');
    const mimeType = String(photo.mimeType || 'image/jpeg');
    if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) throw userError_('Only JPG, PNG or WEBP photos are allowed.');

    const bytes = Utilities.base64Decode(photo.base64.replace(/^data:[^,]+,/, ''));
    if (bytes.length > CONFIG.MAX_PHOTO_BYTES) throw userError_('Photo is too large even after compression.');

    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
    const name = 'pending_' + stamp + '_' + (member.email ? member.email.split('@')[0] : 'link') + '.jpg';
    const file = getPendingFolder_().createFile(Utilities.newBlob(bytes, mimeType, name));

    let sharingWarning = '';
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (err) {
      sharingWarning = 'Saved, but Drive did not allow link sharing: ' + err.message;
    }
    return { fileId: file.getId(), url: driveViewUrl_(file.getId()), sharingWarning: sharingWarning };
  });
}

// Only photos still in the pending folder can be deleted — saved log photos are never removed by the app.
function deletePhoto(token, fileId) {
  return respond_(function () {
    authenticate_(token);
    const file = DriveApp.getFileById(String(fileId));
    if (isInFolder_(file, getPendingFolder_().getId())) file.setTrashed(true);
    return {};
  });
}

function submitLog(token, payload) {
  return respond_(function () {
    const member = authenticate_(token);
    if (!payload || !Array.isArray(payload.entries) || !payload.entries.length) throw userError_('Nothing to submit.');
    if (payload.entries.length > CONFIG.MAX_ENTRIES_PER_SUBMIT) {
      throw userError_('Please submit at most ' + CONFIG.MAX_ENTRIES_PER_SUBMIT + ' ACs at a time.');
    }

    // A double-tap or a network retry sends the same key — return the first result instead of logging twice.
    const cache = CacheService.getScriptCache();
    const submissionKey = String(payload.submissionKey || '').slice(0, 80);
    if (submissionKey) {
      const previous = cache.get('submit_' + submissionKey);
      if (previous) return JSON.parse(previous);
    }

    const pendingFolderId = getPendingFolder_().getId();
    const cleanEntries = [];
    const fieldErrors = [];
    payload.entries.forEach(function (raw, index) {
      const result = validateEntry_(raw, { pendingFolderId: pendingFolderId, existingPhotoIds: [] });
      result.errors.forEach(function (err) {
        fieldErrors.push({ entryIndex: index, field: err.field, message: err.message });
      });
      cleanEntries.push(result.clean);
    });
    if (fieldErrors.length) {
      return { success: false, error: 'Some entries need fixing.', fieldErrors: fieldErrors };
    }

    const sheet = getLogSheet_();
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    let logNos;
    try {
      const columnMap = ensureLogHeaders_(sheet);
      logNos = nextLogNos_(sheet, columnMap, cleanEntries.length);
      const now = new Date();
      const lastColumn = sheet.getLastColumn();
      const rows = cleanEntries.map(function (entry, index) {
        const record = Object.assign({}, entry, {
          logNo: logNos[index],
          photos: photoCellValue_(entry.photos),
          enteredBy: memberLabel_(member),
          loggedAt: now
        });
        return buildRow_(record, columnMap, lastColumn);
      });
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, lastColumn).setValues(rows);
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }

    // Moving/renaming doesn't change Drive links, so this runs after the lock is released.
    cleanEntries.forEach(function (entry, index) {
      filePhotos_(entry.photos, logNos[index], 0);
    });

    const response = { success: true, logNos: logNos };
    if (submissionKey) cache.put('submit_' + submissionKey, JSON.stringify(response), 6 * 60 * 60);
    return response;
  });
}

function getDashboard(token) {
  return respond_(function () {
    const member = authenticate_(token);
    const sheet = getLogSheet_();
    const columnMap = ensureLogHeaders_(sheet);
    const rows = readLogRecords_(sheet, columnMap).map(toClientRecord_);
    rows.reverse(); // newest first
    return { rows: rows, options: OPTIONS, user: publicUser_(member) };
  });
}

function updateLog(token, logNo, changes) {
  return respond_(function () {
    const member = authenticate_(token);
    const targetLogNo = String(logNo || '').trim();
    if (!targetLogNo) throw userError_('Missing Log No.');
    if (!changes || typeof changes !== 'object') throw userError_('Nothing to save.');

    const sheet = getLogSheet_();
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    let updated;
    let newPhotos = [];
    let existingPhotoCount = 0;
    try {
      const columnMap = ensureLogHeaders_(sheet);
      const records = readLogRecords_(sheet, columnMap);
      const current = records.find(function (r) { return String(r.logNo).trim() === targetLogNo; });
      if (!current) throw userError_('Log ' + targetLogNo + ' was not found — it may have been deleted in the sheet. Tap Refresh.');

      const currentPhotoIds = parsePhotoCell_(current.photos).map(function (p) { return p.fileId; });
      existingPhotoCount = currentPhotoIds.length;

      // Only fields the user actually changed are applied; everything else keeps the live sheet value.
      const merged = {
        area: current.area, floor: current.floor, acStatus: current.acStatus, brand: current.brand,
        tonnage: current.tonnage, qty: current.qty, remarks: current.remarks,
        photos: parsePhotoCell_(current.photos)
      };
      EDITABLE_KEYS.forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(changes, key)) merged[key] = changes[key];
      });

      const result = validateEntry_(merged, {
        pendingFolderId: getPendingFolder_().getId(),
        existingPhotoIds: currentPhotoIds
      });
      if (result.errors.length) {
        return { success: false, error: result.errors.map(function (e) { return e.message; }).join(' '), fieldErrors: result.errors };
      }
      const clean = result.clean;
      newPhotos = clean.photos.filter(function (p) { return currentPhotoIds.indexOf(p.fileId) === -1; });

      const editor = memberLabel_(member);
      const now = new Date();
      const auditRows = [];
      EDITABLE_KEYS.forEach(function (key) {
        const oldValue = key === 'photos' ? String(current.photos || '') : formatCell_(current[key]);
        const newValue = key === 'photos' ? photoCellValue_(clean.photos) : clean[key];
        if (String(oldValue) === String(newValue)) return;
        const header = headerFor_(key);
        sheet.getRange(current.rowNumber, columnMap[header.toLowerCase()]).setValue(newValue);
        auditRows.push([now, targetLogNo, header, oldValue, String(newValue), editor]);
      });

      if (auditRows.length) {
        sheet.getRange(current.rowNumber, columnMap['last edited by']).setValue(editor);
        sheet.getRange(current.rowNumber, columnMap['last edited at']).setValue(now);
        const editSheet = getEditSheet_();
        editSheet.getRange(editSheet.getLastRow() + 1, 1, auditRows.length, EDIT_LOG_HEADERS.length).setValues(auditRows);
      }
      SpreadsheetApp.flush();

      const fresh = readLogRecords_(sheet, columnMap).find(function (r) { return String(r.logNo).trim() === targetLogNo; });
      updated = toClientRecord_(fresh);
      updated.changedCount = auditRows.length;
    } finally {
      lock.releaseLock();
    }

    filePhotos_(newPhotos, targetLogNo, existingPhotoCount);
    return { row: updated };
  });
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function validateEntry_(raw, context) {
  const errors = [];
  const entry = raw || {};
  const clean = {
    area: cleanText_(entry.area, 100),
    floor: cleanText_(entry.floor, 50),
    acStatus: cleanText_(entry.acStatus, 50),
    brand: cleanText_(entry.brand, 50),
    tonnage: cleanText_(entry.tonnage, 30),
    qty: null,
    remarks: cleanText_(entry.remarks, 1000),
    photos: []
  };
  const isNewRequired = clean.acStatus === NEW_REQUIRED_STATUS;

  if (!clean.area) errors.push({ field: 'area', message: 'Area/Room No is required.' });
  if (!clean.floor) errors.push({ field: 'floor', message: 'Select a floor.' });
  if (OPTIONS.acStatus.indexOf(clean.acStatus) === -1) errors.push({ field: 'acStatus', message: 'Select an AC status.' });
  if (!clean.brand && !isNewRequired) errors.push({ field: 'brand', message: 'Select a brand.' });
  if (!clean.tonnage) errors.push({ field: 'tonnage', message: 'Select a tonnage.' });

  const qty = Number(entry.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 999) {
    errors.push({ field: 'qty', message: 'Qty must be a whole number from 1 to 999.' });
  } else {
    clean.qty = qty;
  }

  const photos = Array.isArray(entry.photos) ? entry.photos : [];
  if (photos.length > CONFIG.MAX_PHOTOS_PER_ENTRY) {
    errors.push({ field: 'photos', message: 'At most ' + CONFIG.MAX_PHOTOS_PER_ENTRY + ' photos per AC.' });
  }
  const seen = {};
  photos.slice(0, CONFIG.MAX_PHOTOS_PER_ENTRY).forEach(function (photo) {
    const fileId = String((photo && photo.fileId) || '').trim();
    if (!fileId || seen[fileId]) return;
    seen[fileId] = true;
    // A photo is accepted only if it was already on this row, or was uploaded through the app (pending folder).
    if (context.existingPhotoIds.indexOf(fileId) !== -1) {
      clean.photos.push({ fileId: fileId });
      return;
    }
    try {
      const file = DriveApp.getFileById(fileId);
      if (!isInFolder_(file, context.pendingFolderId)) throw new Error('not pending');
      clean.photos.push({ fileId: fileId });
    } catch (err) {
      errors.push({ field: 'photos', message: 'A photo could not be found in Drive — remove it and add it again.' });
    }
  });
  if (!isNewRequired && !clean.photos.length && !errors.some(function (e) { return e.field === 'photos'; })) {
    errors.push({ field: 'photos', message: 'Add at least one photo (serial number visible).' });
  }
  return { clean: clean, errors: errors };
}

// Trims, collapses whitespace, caps length, and neutralises leading = + - @ so text can't become a formula.
function cleanText_(value, maxLength) {
  let text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return text;
}

/* ------------------------------------------------------------------ */
/* Log No generation                                                   */
/* ------------------------------------------------------------------ */

// Financial year code: Apr 2026 – Mar 2027 → "2627".
function fyCode_(date) {
  const startYear = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return pad2_(startYear % 100) + pad2_((startYear + 1) % 100);
}

// Must be called under the script lock. Takes the higher of (highest ID in the sheet for this FY,
// stored counter), then skips any ID that already exists — so manual rows never cause duplicates.
function nextLogNos_(sheet, columnMap, count) {
  const fy = fyCode_(new Date());
  const prefix = CONFIG.ID_PREFIX + '/' + fy + '/';
  const pattern = new RegExp('^' + CONFIG.ID_PREFIX + '/' + fy + '/(\\d+)$');
  const lastRow = sheet.getLastRow();
  const values = lastRow > 1
    ? sheet.getRange(2, columnMap['log no'], lastRow - 1, 1).getDisplayValues().map(function (r) { return String(r[0]).trim(); })
    : [];

  const existing = {};
  let highestInSheet = 0;
  values.forEach(function (value) {
    existing[value] = true;
    const match = value.match(pattern);
    if (match) highestInSheet = Math.max(highestInSheet, Number(match[1]));
  });

  const props = PropertiesService.getScriptProperties();
  const counterKey = 'LOG_COUNTER_' + fy;
  let counter = Math.max(highestInSheet, Number(props.getProperty(counterKey)) || 0);
  const ids = [];
  while (ids.length < count) {
    counter += 1;
    const id = prefix + String(counter).padStart(4, '0');
    if (!existing[id]) ids.push(id);
  }
  props.setProperty(counterKey, String(counter));
  return ids;
}

/* ------------------------------------------------------------------ */
/* Sheet helpers                                                       */
/* ------------------------------------------------------------------ */

function ensureSheets_() {
  ensureLogHeaders_(getLogSheet_());
  getEditSheet_();
  getTeamSheet_();
}

function getLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(CONFIG.LOG_SHEET) || ss.insertSheet(CONFIG.LOG_SHEET);
}

function getEditSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.EDIT_SHEET) || ss.insertSheet(CONFIG.EDIT_SHEET);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, EDIT_LOG_HEADERS.length).setValues([EDIT_LOG_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Accepts EON_Team / Eon_Team / "EON Team". Created with the owner as the first member if missing.
function getTeamSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const target = normalizeName_(CONFIG.TEAM_SHEET);
  let sheet = ss.getSheets().find(function (s) { return normalizeName_(s.getName()) === target; });
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.TEAM_SHEET);
    sheet.getRange(1, 1, 2, TEAM_HEADERS.length).setValues([
      TEAM_HEADERS,
      ['Director', 'Owner', CONFIG.OWNER_EMAIL, 'Yes', 'Active']
    ]);
    sheet.getRange(1, 1, 1, TEAM_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function ensureLogHeaders_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headerRow = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const present = headerRow.map(function (h) { return String(h).trim().toLowerCase(); });
  const missing = LOG_FIELDS.map(function (f) { return f.header; })
    .filter(function (h) { return present.indexOf(h.toLowerCase()) === -1; });

  if (missing.length) {
    const sheetIsEmpty = present.every(function (h) { return !h; });
    const writeAt = sheetIsEmpty ? 1 : sheet.getLastColumn() + 1;
    sheet.getRange(1, writeAt, 1, missing.length).setValues([missing]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return getColumnMap_(sheet);
}

function getColumnMap_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const map = {};
  headers.forEach(function (header, index) {
    const key = String(header).trim().toLowerCase();
    if (key && !map[key]) map[key] = index + 1;
  });
  return map;
}

function headerFor_(key) {
  return LOG_FIELDS.find(function (f) { return f.key === key; }).header;
}

function buildRow_(record, columnMap, lastColumn) {
  const row = new Array(lastColumn).fill('');
  LOG_FIELDS.forEach(function (field) {
    const column = columnMap[field.header.toLowerCase()];
    if (column && record[field.key] !== undefined && record[field.key] !== null) row[column - 1] = record[field.key];
  });
  return row;
}

function readLogRecords_(sheet, columnMap) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const records = [];
  values.forEach(function (row, index) {
    const record = { rowNumber: index + 2 };
    LOG_FIELDS.forEach(function (field) {
      const column = columnMap[field.header.toLowerCase()];
      record[field.key] = column ? row[column - 1] : '';
    });
    if (String(record.logNo).trim() || String(record.area).trim()) records.push(record);
  });
  return records;
}

function toClientRecord_(record) {
  const tz = Session.getScriptTimeZone();
  const formatDate = function (value) {
    return value instanceof Date ? Utilities.formatDate(value, tz, 'dd-MMM-yyyy HH:mm') : String(value || '');
  };
  return {
    logNo: String(record.logNo || '').trim(),
    area: formatCell_(record.area),
    floor: formatCell_(record.floor),
    acStatus: formatCell_(record.acStatus),
    brand: formatCell_(record.brand),
    tonnage: formatCell_(record.tonnage),
    qty: record.qty === '' ? '' : Number(record.qty),
    photos: parsePhotoCell_(record.photos),
    remarks: formatCell_(record.remarks),
    enteredBy: formatCell_(record.enteredBy),
    loggedAt: formatDate(record.loggedAt),
    loggedAtMs: record.loggedAt instanceof Date ? record.loggedAt.getTime() : 0,
    lastEditedBy: formatCell_(record.lastEditedBy),
    lastEditedAt: formatDate(record.lastEditedAt)
  };
}

function formatCell_(value) {
  return value instanceof Date ? value.toISOString() : String(value == null ? '' : value).trim();
}

function readAreaList_() {
  const sheet = getLogSheet_();
  const columnMap = ensureLogHeaders_(sheet);
  const column = columnMap['area/room no'];
  const lastRow = sheet.getLastRow();
  if (!column || lastRow < 2) return [];
  const seen = {};
  sheet.getRange(2, column, lastRow - 1, 1).getDisplayValues().forEach(function (r) {
    const value = String(r[0]).trim();
    if (value) seen[value.toLowerCase()] = seen[value.toLowerCase()] || value;
  });
  return Object.keys(seen).map(function (k) { return seen[k]; }).sort();
}

/* ------------------------------------------------------------------ */
/* Photos / Drive                                                      */
/* ------------------------------------------------------------------ */

function getRootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const storedId = props.getProperty('PHOTO_ROOT_FOLDER_ID');
  if (storedId) {
    try {
      const folder = DriveApp.getFolderById(storedId);
      if (!folder.isTrashed()) return folder;
    } catch (err) {
      // Folder deleted or inaccessible — fall through and create a new one.
    }
  }
  let parent = DriveApp.getRootFolder();
  try {
    const parents = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId()).getParents();
    if (parents.hasNext()) parent = parents.next();
  } catch (err) {
    // Keep My Drive root.
  }
  const folder = parent.createFolder(CONFIG.PHOTO_ROOT_FOLDER_NAME);
  props.setProperty('PHOTO_ROOT_FOLDER_ID', folder.getId());
  return folder;
}

function getChildFolder_(parent, name) {
  const existing = parent.getFoldersByName(name);
  return existing.hasNext() ? existing.next() : parent.createFolder(name);
}

function getPendingFolder_() {
  return getChildFolder_(getRootFolder_(), CONFIG.PENDING_FOLDER_NAME);
}

function isInFolder_(file, folderId) {
  const parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === folderId) return true;
  }
  return false;
}

// Moves freshly uploaded photos from "_pending uploads" into the FY folder and names them after the Log No.
function filePhotos_(photos, logNo, startIndex) {
  if (!photos || !photos.length) return;
  const fy = logNo.split('/')[1] || fyCode_(new Date());
  const fyFolder = getChildFolder_(getRootFolder_(), 'FY ' + fy);
  const pendingId = getPendingFolder_().getId();
  photos.forEach(function (photo, index) {
    try {
      const file = DriveApp.getFileById(photo.fileId);
      if (!isInFolder_(file, pendingId)) return;
      file.moveTo(fyFolder);
      file.setName(logNo.replace(/\//g, '-') + ' (' + (startIndex + index + 1) + ').jpg');
    } catch (err) {
      console.warn('Could not file photo ' + photo.fileId + ': ' + err.message);
    }
  });
}

function driveViewUrl_(fileId) {
  return 'https://drive.google.com/file/d/' + fileId + '/view';
}

function photoCellValue_(photos) {
  return (photos || []).map(function (p) { return driveViewUrl_(p.fileId); }).join('\n');
}

function parsePhotoCell_(value) {
  return String(value || '').split(/[\n,]+/).map(function (part) {
    const url = part.trim();
    const match = url.match(/\/d\/([\w-]{10,})/) || url.match(/[?&]id=([\w-]{10,})/);
    return match ? { fileId: match[1], url: driveViewUrl_(match[1]) } : null;
  }).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Auth helpers                                                        */
/* ------------------------------------------------------------------ */

function getTeam_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('team_list_v1');
  if (cached) return JSON.parse(cached);

  const sheet = getTeamSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const map = getColumnMap_(sheet);
  const emailCol = map['email id'] || map['email'];
  const nameCol = map['name'];
  const roleCol = map['role'];
  const statusCol = map['status'];
  if (!emailCol) throw new Error('The EON_Team tab needs an "Email ID" column.');

  const rows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getDisplayValues();
  const team = rows.map(function (row) {
    return {
      email: normalizeEmail_(row[emailCol - 1]),
      name: nameCol ? String(row[nameCol - 1]).trim() : '',
      role: roleCol ? String(row[roleCol - 1]).trim() : '',
      status: statusCol ? String(row[statusCol - 1]).trim().toLowerCase() : ''
    };
  }).filter(function (m) {
    // Blank or "Active" status = allowed; anything else (Inactive, Left…) = locked out.
    return m.email && (!m.status || m.status === 'active');
  });
  cache.put('team_list_v1', JSON.stringify(team), CONFIG.TEAM_CACHE_SECONDS);
  return team;
}

function findMember_(email) {
  const target = normalizeEmail_(email);
  return getTeam_().find(function (m) { return m.email === target; }) || null;
}

function publicUser_(member) {
  return { name: member.name || member.email, email: member.email, role: member.role || '', guest: !!member.guest };
}

// What goes in Entered By / Last Edited By / Edited By.
function memberLabel_(member) {
  if (member.guest) return member.name + ' (via link)';
  return member.name ? member.name + ' (' + member.email + ')' : member.email;
}

// Open access (no sign-in): anyone with the link is a guest. The browser sends "guest:<name>"
// where <name> is whatever the person typed in "Your name" (optional).
function guestMember_(token) {
  const raw = String(token || '');
  const name = raw.indexOf('guest:') === 0 ? cleanText_(raw.slice(6), 60) : '';
  return { email: '', name: name || 'Guest', role: '', guest: true };
}

function getSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('SESSION_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('SESSION_SECRET', secret);
  }
  return secret;
}

function signToken_(email) {
  const payload = { e: email, exp: Math.floor(Date.now() / 1000) + CONFIG.SESSION_TTL_SECONDS };
  const body = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  const signature = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, getSecret_()));
  return body + '.' + signature;
}

// Open access: there is no sign-in page any more. A valid old session token still identifies the
// team member (so their name/email keeps showing in Entered By); anything else is a guest.
function authenticate_(token) {
  try {
    return authenticateSession_(token);
  } catch (err) {
    if (err && err.isAuthError) return guestMember_(token);
    throw err;
  }
}

// Original check: signature, expiry, AND live EON_Team membership.
function authenticateSession_(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) throw authError_('Please sign in.');
  const expected = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(parts[0], getSecret_()));
  if (expected !== parts[1]) throw authError_('Your session has ended. Please sign in again.');

  let payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (err) {
    throw authError_('Please sign in again.');
  }
  if (!payload.exp || payload.exp * 1000 < Date.now()) throw authError_('Your session has expired. Please sign in again.');

  const member = findMember_(payload.e);
  if (!member) throw authError_('Access Denied — you are no longer on the EON Team list.');
  return member;
}

/* ------------------------------------------------------------------ */
/* Generic helpers                                                     */
/* ------------------------------------------------------------------ */

function respond_(work) {
  try {
    const result = work();
    if (result && result.success === false) return result;
    return Object.assign({ success: true }, result || {});
  } catch (err) {
    if (err && err.isAuthError) return { success: false, authFailed: true, error: err.message };
    if (err && err.isUserError) return { success: false, error: err.message };
    console.error(err && err.stack ? err.stack : err);
    const message = err && err.message ? err.message : String(err);
    if (/lock/i.test(message)) return { success: false, error: 'The sheet is busy with other submissions. Please try again in a moment.' };
    return { success: false, error: 'Server error: ' + message };
  }
}

function userError_(message) {
  const err = new Error(message);
  err.isUserError = true;
  return err;
}

function authError_(message) {
  const err = new Error(message);
  err.isAuthError = true;
  return err;
}

function normalizeEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeName_(name) {
  return String(name || '').toLowerCase().replace(/[^a-z]/g, '');
}

function sha256_(text) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text));
}

function pad2_(n) {
  return String(n).padStart(2, '0');
}

function escapeHtml_(text) {
  return String(text).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/**
 * Run once from the editor (select "setup" → Run) to create the tabs/folders and grant permissions.
 */
function setup() {
  ensureSheets_();
  getPendingFolder_();
  getSecret_();
  Logger.log('Ready. Photos folder: ' + getRootFolder_().getUrl());
}
