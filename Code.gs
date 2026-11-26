const ADMIN_PASSWORD_HASH_ITERATIONS = 4000;
const ADMIN_SESSION_DURATION_SECONDS = 30 * 24 * 60 * 60;
const FIRESTORE_PROJECT_ID = 'hotelbooking-29ac6';
const FIRESTORE_DATABASE_ID = '(default)';
const FIRESTORE_BOOKING_HEADERS = [
  'id', 'name', 'phone', 'checkin', 'checkout', 'nights', 'people', 'comment',
  'status', 'totalprice', 'createdat', 'email', 'bookby', 'adminRemark'
];
const FIRESTORE_ADMIN_HEADERS = [
  'username', 'passwordHash', 'salt', 'role', 'active', 'createdAt',
  'updatedAt', 'sessionVersion', 'email'
];

function doGet(e) {
  const callback = e && e.parameter ? e.parameter.callback : '';
  try {
    const bookingWindow = getBookingWindow_();
    const data = getAvailability_(bookingWindow);
    return jsonOutput_({ status: 'success', data: data, bookingWindow: bookingWindow }, callback);
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return jsonOutput_({ status: 'error', message: 'ไม่สามารถอ่านข้อมูลการจองได้' }, callback);
  }
}

function doPost(e) {
  const parameters = e && e.parameter ? e.parameter : {};
  let result;
  try {
    const payload = parseBookingPayload_(parameters.payload, e && e.postData ? e.postData.contents : '');
    result = parameters.action === 'admin'
      ? handleAdminRequest_(payload)
      : reserveBooking_(payload, 'website');
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    result = {
      status: 'error',
      message: parameters.action === 'admin'
        ? (err && err.message ? err.message : 'ไม่สามารถดำเนินการของผู้ดูแลได้')
        : 'ไม่สามารถบันทึกการจองได้ กรุณาลองใหม่อีกครั้ง'
    };
  }

  return postMessageOutput_(parameters.nonce, result, 'bsh-booking-result');
}

function firestoreApiUrl_(path) {
  return 'https://firestore.googleapis.com/v1/projects/' +
    encodeURIComponent(FIRESTORE_PROJECT_ID) + '/databases/' +
    encodeURIComponent(FIRESTORE_DATABASE_ID) + '/documents/' + path;
}

function firestoreRequest_(method, url, payload, allowNotFound) {
  const options = {
    method: method,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  };
  if (payload !== undefined) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  const response = UrlFetchApp.fetch(url, options);
  const statusCode = response.getResponseCode();
  const responseText = response.getContentText();
  if (allowNotFound && statusCode === 404) return null;
  if (statusCode < 200 || statusCode >= 300) {
    let message = responseText;
    try {
      const error = JSON.parse(responseText);
      if (error.error && error.error.message) message = error.error.message;
    } catch (ignored) {
      message = responseText;
    }
    throw new Error('Firestore API ' + statusCode + ': ' + message);
  }
  if (!responseText) return null;
  return JSON.parse(responseText);
}

function firestoreEncodeValue_(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (value instanceof Date) {
    if (isNaN(value.getTime())) throw new Error('Firestore ไม่สามารถบันทึกวันที่ที่ไม่ถูกต้องได้');
    return { timestampValue: value.toISOString() };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  throw new Error('ชนิดข้อมูลนี้ไม่รองรับใน Firestore: ' + typeof value);
}

function firestoreDecodeValue_(value) {
  if (Object.prototype.hasOwnProperty.call(value, 'stringValue')) return value.stringValue;
  if (Object.prototype.hasOwnProperty.call(value, 'integerValue')) return Number(value.integerValue);
  if (Object.prototype.hasOwnProperty.call(value, 'doubleValue')) return Number(value.doubleValue);
  if (Object.prototype.hasOwnProperty.call(value, 'booleanValue')) return value.booleanValue;
  if (Object.prototype.hasOwnProperty.call(value, 'timestampValue')) return new Date(value.timestampValue);
  if (Object.prototype.hasOwnProperty.call(value, 'nullValue')) return '';
  if (value.mapValue) {
    const result = {};
    Object.keys(value.mapValue.fields || {}).forEach(function(key) {
      result[key] = firestoreDecodeValue_(value.mapValue.fields[key]);
    });
    return result;
  }
  if (value.arrayValue) {
    return (value.arrayValue.values || []).map(firestoreDecodeValue_);
  }
  if (value.referenceValue) return value.referenceValue;
  throw new Error('Firestore ส่งชนิดข้อมูลที่ไม่รองรับกลับมา');
}

function firestoreFieldsFromRecord_(record) {
  const fields = {};
  Object.keys(record).forEach(function(key) {
    fields[key] = firestoreEncodeValue_(record[key]);
  });
  return fields;
}

function firestoreRecordFromDocument_(document) {
  const record = {};
  Object.keys(document.fields || {}).forEach(function(key) {
    record[key] = firestoreDecodeValue_(document.fields[key]);
  });
  return record;
}

function firestoreDocumentUrl_(collectionName, documentId) {
  return firestoreApiUrl_(encodeURIComponent(collectionName) + '/' + encodeURIComponent(documentId));
}

function firestoreGetDocument_(collectionName, documentId) {
  return firestoreRequest_(
    'get',
    firestoreDocumentUrl_(collectionName, documentId),
    undefined,
    true
  );
}

function firestoreListDocuments_(collectionName) {
  const documents = [];
  let pageToken = '';
  do {
    let url = firestoreApiUrl_(encodeURIComponent(collectionName)) + '?pageSize=1000';
    if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);
    const page = firestoreRequest_('get', url);
    Array.prototype.push.apply(documents, page.documents || []);
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return documents;
}

function firestoreWriteDocument_(collectionName, documentId, record) {
  const fields = firestoreFieldsFromRecord_(record);
  const updateMask = Object.keys(fields).map(function(field) {
    return 'updateMask.fieldPaths=' + encodeURIComponent(field);
  }).join('&');
  const url = firestoreDocumentUrl_(collectionName, documentId) +
    (updateMask ? '?' + updateMask : '');
  return firestoreRequest_('patch', url, { fields: fields });
}

function firestoreDeleteDocument_(collectionName, documentId) {
  firestoreRequest_('delete', firestoreDocumentUrl_(collectionName, documentId));
}

function firestoreRows_(collectionName, headers) {
  const rows = [headers.slice()];
  firestoreListDocuments_(collectionName).forEach(function(document) {
    const record = firestoreRecordFromDocument_(document);
    rows.push(headers.map(function(header) {
      return Object.prototype.hasOwnProperty.call(record, header) ? record[header] : '';
    }));
  });
  return rows;
}

function createFirestoreSheetAdapter_(collectionName, headers, idField) {
  const idColumn = headers.indexOf(idField);
  if (idColumn < 0) throw new Error('Firestore schema ไม่มีคอลัมน์รหัสเอกสาร ' + idField);
  return {
    getLastColumn: function() {
      return headers.length;
    },
    getLastRow: function() {
      return firestoreRows_(collectionName, headers).length;
    },
    getDataRange: function() {
      return { getValues: function() { return firestoreRows_(collectionName, headers); } };
    },
    getRange: function(row, column, rowCount, columnCount) {
      const numberOfRows = rowCount || 1;
      const numberOfColumns = columnCount || 1;
      function getValues() {
        return firestoreRows_(collectionName, headers).slice(row - 1, row - 1 + numberOfRows)
          .map(function(values) { return values.slice(column - 1, column - 1 + numberOfColumns); });
      }
      return {
        getValues: getValues,
        getDisplayValues: function() {
          return getValues().map(function(values) {
            return values.map(function(value) { return value instanceof Date ? value.toISOString() : String(value); });
          });
        },
        setValues: function(values) {
          const currentRows = firestoreRows_(collectionName, headers);
          values.forEach(function(updatedValues, index) {
            const rowIndex = row - 1 + index;
            if (rowIndex <= 0 || rowIndex > currentRows.length) {
              throw new Error('Firestore ไม่สามารถแก้ไขแถวที่ไม่มีอยู่ได้');
            }
            const isAppend = rowIndex === currentRows.length;
            const originalRow = isAppend ? headers.map(function() { return ''; }) : currentRows[rowIndex];
            const updatedRow = originalRow.slice();
            updatedValues.forEach(function(value, valueIndex) {
              updatedRow[column - 1 + valueIndex] = value;
            });
            const previousId = String(originalRow[idColumn] || '').trim();
            const nextId = String(updatedRow[idColumn] || '').trim();
            if (!nextId) throw new Error('Firestore document id ต้องไม่ว่าง');
            const record = {};
            headers.forEach(function(header, headerIndex) {
              record[header] = updatedRow[headerIndex];
            });
            firestoreWriteDocument_(collectionName, nextId, record);
            if (previousId && previousId !== nextId) firestoreDeleteDocument_(collectionName, previousId);
            if (isAppend) currentRows.push(updatedRow);
          });
        }
      };
    },
    appendRow: function(values) {
      const row = headers.map(function(header, index) {
        return index < values.length ? values[index] : '';
      });
      const documentId = String(row[idColumn] || '').trim();
      if (!documentId) throw new Error('Firestore document id ต้องไม่ว่าง');
      const record = {};
      headers.forEach(function(header, index) { record[header] = row[index]; });
      firestoreWriteDocument_(collectionName, documentId, record);
    }
  };
}

function postMessageOutput_(nonce, result, messageType) {
  const message = JSON.stringify({
    type: messageType,
    nonce: String(nonce || ''),
    result: result
  }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const html = '<!doctype html><html><body><script>window.top.postMessage(' +
    message +
    ', "*");</script></body></html>';

  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function handleAdminRequest_(request) {
  if (request.action === 'login') return loginAdmin_(request.username, request.password);

  const session = verifyAdminSession_(request.session_token);
  if (request.action === 'list') {
    return { status: 'success', data: getAdminBookings_() };
  }
  if (request.action === 'createBooking') {
    return createAdminBooking_(request.booking, session);
  }
  if (request.action === 'update') {
    return updateAdminBooking_(request.booking);
  }
  if (request.action === 'sendConfirmationEmail') {
    return resendBookingConfirmationEmail_(request.id);
  }
  if (request.action === 'sendCancellationNotification') {
    return resendCancellationNotification_(request.id);
  }
  if (request.action === 'sendCancellationEmail') {
    return resendBookingCancellationEmail_(request.id);
  }
  if (request.action === 'listUsers') {
    requireSuperAdmin_(session);
    return { status: 'success', data: listAdminUsers_() };
  }
  if (request.action === 'createUser') {
    requireSuperAdmin_(session);
    return createAdminUser_(request.username, request.password);
  }
  if (request.action === 'updateUser') {
    requireSuperAdmin_(session);
    return updateAdminUser_(request.username, request.newUsername, request.newPassword, request.active);
  }
  if (request.action === 'changeOwnPassword') {
    return changeOwnAdminPassword_(session, request.currentPassword, request.newPassword);
  }
  return { status: 'error', message: 'ไม่รู้จักคำสั่งของผู้ดูแล' };
}

function setupInitialAdmin() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const properties = PropertiesService.getScriptProperties();
    const initialPassword = String(properties.getProperty('ADMIN_BOOTSTRAP_PASSWORD') || '');
    if (!isStrongAdminPassword_(initialPassword)) {
      throw new Error('ตั้งค่า ADMIN_BOOTSTRAP_PASSWORD ความยาว 8-128 ตัวอักษรใน Script Properties ก่อน');
    }

    if (findAdminUser_('robojorj')) {
      throw new Error('พบ username robojorj อยู่แล้ว ไม่ได้เปลี่ยนรหัสผ่าน');
    }

    if (!properties.getProperty('ADMIN_PASSWORD_PEPPER')) {
      properties.setProperty('ADMIN_PASSWORD_PEPPER', Utilities.getUuid() + Utilities.getUuid());
    }
    if (!properties.getProperty('ADMIN_SESSION_SECRET')) {
      properties.setProperty('ADMIN_SESSION_SECRET', Utilities.getUuid() + Utilities.getUuid());
    }

    const salt = createPasswordSalt_();
    const now = new Date();
    getAdminUserSheet_().sheet.appendRow([
      'robojorj',
      derivePasswordHash_(initialPassword, salt),
      salt,
      'superadmin',
      true,
      now,
      now,
      1
    ]);
    properties.deleteProperty('ADMIN_BOOTSTRAP_PASSWORD');
    console.log('สร้างบัญชี superadmin robojorj สำเร็จ และลบ ADMIN_BOOTSTRAP_PASSWORD แล้ว');
    return 'บัญชี robojorj พร้อมใช้งาน';
  } finally {
    lock.releaseLock();
  }
}

function resetInitialAdminPassword() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const properties = PropertiesService.getScriptProperties();
    const newPassword = String(properties.getProperty('ADMIN_BOOTSTRAP_PASSWORD') || '');
    if (!isStrongAdminPassword_(newPassword)) {
      throw new Error('ตั้งค่า ADMIN_BOOTSTRAP_PASSWORD ความยาว 8-128 ตัวอักษรใน Script Properties ก่อน');
    }

    const userInfo = getAdminUserSheet_();
    const user = findAdminUser_('robojorj');
    if (!user || user.role !== 'superadmin') {
      throw new Error('ไม่พบบัญชี superadmin robojorj กรุณาเรียก setupInitialAdmin');
    }

    const row = userInfo.sheet.getRange(user.rowIndex, 1, 1, 8).getValues()[0];
    const salt = createPasswordSalt_();
    row[userInfo.columns.passwordHash] = derivePasswordHash_(newPassword, salt);
    row[userInfo.columns.salt] = salt;
    row[userInfo.columns.active] = true;
    row[userInfo.columns.updatedAt] = new Date();
    row[userInfo.columns.sessionVersion] = user.sessionVersion + 1;
    userInfo.sheet.getRange(user.rowIndex, 1, 1, row.length).setValues([row]);
    properties.deleteProperty('ADMIN_BOOTSTRAP_PASSWORD');
    CacheService.getScriptCache().remove(adminLoginRateLimitKey_('robojorj'));
    console.log('รีเซ็ตรหัสผ่าน superadmin robojorj สำเร็จ และลบ ADMIN_BOOTSTRAP_PASSWORD แล้ว');
    return 'รีเซ็ตรหัสผ่าน robojorj แล้ว';
  } finally {
    lock.releaseLock();
  }
}

function loginAdmin_(usernameValue, passwordValue) {
  const username = normalizeAdminUsername_(usernameValue);
  const password = String(passwordValue || '');
  if (!isValidAdminUsername_(username) || password.length > 128) {
    return { status: 'error', message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
  }
  const cache = CacheService.getScriptCache();
  const rateLimitKey = adminLoginRateLimitKey_(username);
  const failedAttempts = Number(cache.get(rateLimitKey) || 0);
  if (failedAttempts >= 5) {
    return { status: 'error', message: 'เข้าสู่ระบบไม่สำเร็จหลายครั้ง กรุณารอ 15 นาทีแล้วลองใหม่' };
  }

  const user = findAdminUser_(username);
  const candidateHash = derivePasswordHash_(password, user ? user.salt : 'unknown-user-salt');
  if (!user || !isAdminUserActive_(user) || !constantTimeEquals_(candidateHash, user.passwordHash)) {
    cache.put(rateLimitKey, String(failedAttempts + 1), 900);
    return { status: 'error', message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
  }

  cache.remove(rateLimitKey);
  const sessionToken = createAdminSession_(user);
  return {
    status: 'success',
    data: {
      username: user.username,
      role: user.role,
      sessionToken: sessionToken
    }
  };
}

function adminLoginRateLimitKey_(username) {
  return 'admin-login-' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(username || 'unknown'))
  );
}

function createAdminSession_(user) {
  const properties = PropertiesService.getScriptProperties();
  const secret = String(properties.getProperty('ADMIN_SESSION_SECRET') || '');
  if (!secret) throw new Error('ยังไม่ได้ตั้งค่า secret สำหรับ session');
  const payload = Utilities.base64EncodeWebSafe(JSON.stringify({
    username: user.username,
    sessionVersion: user.sessionVersion,
    expiresAt: Math.floor(Date.now() / 1000) + ADMIN_SESSION_DURATION_SECONDS,
    nonce: Utilities.getUuid()
  }));
  const signature = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(payload, secret)
  );
  return payload + '.' + signature;
}

function verifyAdminSession_(sessionToken) {
  const parts = String(sessionToken || '').split('.');
  if (parts.length !== 2) throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  const secret = String(PropertiesService.getScriptProperties().getProperty('ADMIN_SESSION_SECRET') || '');
  if (!secret) throw new Error('ยังไม่ได้ตั้งค่า session กรุณาให้ผู้ดูแลระบบเริ่มต้นระบบก่อน');

  const expectedSignature = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(parts[0], secret)
  );
  if (!constantTimeEquals_(parts[1], expectedSignature)) {
    throw new Error('เซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่');
  }

  let payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (err) {
    throw new Error('เซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่');
  }
  if (!payload.username || Number(payload.expiresAt) <= Math.floor(Date.now() / 1000)) {
    throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  }

  const user = findAdminUser_(payload.username);
  if (!user || !isAdminUserActive_(user) ||
      Number(user.sessionVersion) !== Number(payload.sessionVersion)) {
    throw new Error('บัญชีถูกปิดใช้งานหรือมีการเปลี่ยนรหัสผ่าน กรุณาเข้าสู่ระบบใหม่');
  }
  return user;
}

function derivePasswordHash_(password, salt) {
  const secretPepper = String(PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD_PEPPER') || '');
  if (!secretPepper) throw new Error('ยังไม่ได้ตั้งค่า password pepper กรุณาเรียก setupInitialAdmin');

  const iterations = ADMIN_PASSWORD_HASH_ITERATIONS;
  let u = Utilities.computeHmacSha256Signature(String(salt) + secretPepper + '\u0000\u0000\u0000\u0001', String(password));
  const derived = u.slice();
  for (let iteration = 1; iteration < iterations; iteration++) {
    // Apps Script HMAC accepts text input, so encode each intermediate digest before the next round.
    u = Utilities.computeHmacSha256Signature(Utilities.base64EncodeWebSafe(u), String(password));
    for (let index = 0; index < derived.length; index++) {
      derived[index] ^= u[index];
    }
  }
  return Utilities.base64EncodeWebSafe(derived);
}

function createPasswordSalt_() {
  return Utilities.getUuid() + Utilities.getUuid();
}

function constantTimeEquals_(leftValue, rightValue) {
  const left = String(leftValue || '');
  const right = String(rightValue || '');
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function normalizeAdminUsername_(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidAdminUsername_(username) {
  return /^[a-z0-9][a-z0-9._-]{2,29}$/.test(username);
}

function isStrongAdminPassword_(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 128;
}

function isAdminUserActive_(user) {
  return user.active === true || String(user.active).toLowerCase() === 'true';
}

function requireSuperAdmin_(user) {
  if (user.username !== 'robojorj' || user.role !== 'superadmin') {
    throw new Error('เฉพาะบัญชี robojorj เท่านั้นที่จัดการบัญชีแอดมินได้');
  }
}

function getAdminUserSheet_() {
  return {
    sheet: createFirestoreSheetAdapter_('adminUsers', FIRESTORE_ADMIN_HEADERS, 'username'),
    columns: {
      username: 0,
      passwordHash: 1,
      salt: 2,
      role: 3,
      active: 4,
      createdAt: 5,
      updatedAt: 6,
      sessionVersion: 7,
      email: 8
    }
  };
}

function getLegacyAdminUserSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('สคริปต์ต้องผูกกับ Google Spreadsheet');
  const sheet = spreadsheet.getSheetByName('user');
  if (!sheet) throw new Error('ไม่พบชีต user กรุณาเรียก setupInitialAdmin ใน Apps Script');

  const headers = ['username', 'passwordhash', 'salt', 'role', 'active', 'createdat', 'updatedat', 'sessionversion'];
  const lastColumn = sheet.getLastColumn();
  const actualHeaders = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0]
    .map(function(value) { return String(value || '').trim().toLowerCase(); });
  if (!headers.every(function(header, index) { return actualHeaders[index] === header; })) {
    throw new Error('หัวคอลัมน์ในชีต user ไม่ถูกต้อง');
  }
  return {
    sheet: sheet,
    columns: {
      username: 0,
      passwordHash: 1,
      salt: 2,
      role: 3,
      active: 4,
      createdAt: 5,
      updatedAt: 6,
      sessionVersion: 7,
      email: actualHeaders.indexOf('email')
    }
  };
}

function findAdminUser_(username) {
  if (!username) return null;
  const userInfo = getAdminUserSheet_();
  const rows = userInfo.sheet.getDataRange().getValues();
  for (let index = 1; index < rows.length; index++) {
    if (normalizeAdminUsername_(rows[index][userInfo.columns.username]) !== username) continue;
    return {
      rowIndex: index + 1,
      username: username,
      passwordHash: String(rows[index][userInfo.columns.passwordHash] || ''),
      salt: String(rows[index][userInfo.columns.salt] || ''),
      role: String(rows[index][userInfo.columns.role] || 'admin'),
      active: rows[index][userInfo.columns.active],
      createdAt: rows[index][userInfo.columns.createdAt],
      updatedAt: rows[index][userInfo.columns.updatedAt],
      sessionVersion: Number(rows[index][userInfo.columns.sessionVersion]) || 1
    };
  }
  return null;
}

function listAdminUsers_() {
  const userInfo = getAdminUserSheet_();
  const rows = userInfo.sheet.getDataRange().getValues();
  return rows.slice(1).filter(function(row) {
    return String(row[userInfo.columns.username] || '').trim() !== '';
  }).map(function(row) {
    return {
      username: normalizeAdminUsername_(row[userInfo.columns.username]),
      role: String(row[userInfo.columns.role] || 'admin'),
      active: isAdminUserActive_({ active: row[userInfo.columns.active] }),
      createdAt: dateTimeCellToString_(row[userInfo.columns.createdAt]),
      updatedAt: dateTimeCellToString_(row[userInfo.columns.updatedAt])
    };
  });
}

function createAdminUser_(usernameValue, passwordValue) {
  const username = normalizeAdminUsername_(usernameValue);
  const password = String(passwordValue || '');
  if (!isValidAdminUsername_(username)) {
    return { status: 'error', message: 'username ใช้ a-z, 0-9, จุด, ขีดกลาง หรือขีดล่าง ความยาว 3-30 ตัว' };
  }
  if (username === 'robojorj') return { status: 'error', message: 'สงวน username robojorj ไว้สำหรับ superadmin' };
  if (!isStrongAdminPassword_(password)) {
    return { status: 'error', message: 'รหัสผ่านต้องมีความยาว 8-128 ตัวอักษร' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const userInfo = getAdminUserSheet_();
    if (findAdminUser_(username)) return { status: 'error', message: 'username นี้มีอยู่แล้ว' };
    const salt = createPasswordSalt_();
    const now = new Date();
    userInfo.sheet.appendRow([username, derivePasswordHash_(password, salt), salt, 'admin', true, now, now, 1]);
    return { status: 'success', data: { username: username, active: true, role: 'admin' } };
  } finally {
    lock.releaseLock();
  }
}

function updateAdminUser_(usernameValue, newUsernameValue, newPasswordValue, activeValue) {
  const username = normalizeAdminUsername_(usernameValue);
  const newUsername = normalizeAdminUsername_(newUsernameValue || username);
  const newPassword = String(newPasswordValue || '');
  const active = activeValue === true || String(activeValue).toLowerCase() === 'true';
  if (!isValidAdminUsername_(newUsername)) {
    return { status: 'error', message: 'username ใช้ a-z, 0-9, จุด, ขีดกลาง หรือขีดล่าง ความยาว 3-30 ตัว' };
  }
  if (newPassword && !isStrongAdminPassword_(newPassword)) {
    return { status: 'error', message: 'รหัสผ่านต้องมีความยาว 8-128 ตัวอักษร' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const userInfo = getAdminUserSheet_();
    const user = findAdminUser_(username);
    if (!user) return { status: 'error', message: 'ไม่พบบัญชีแอดมินนี้' };
    if (username === 'robojorj' && (newUsername !== 'robojorj' || !active)) {
      return { status: 'error', message: 'ไม่สามารถเปลี่ยนชื่อหรือปิดบัญชี superadmin robojorj ได้' };
    }
    const existingUser = findAdminUser_(newUsername);
    if (existingUser && existingUser.username !== username) {
      return { status: 'error', message: 'username ใหม่มีผู้ใช้งานแล้ว' };
    }

    const row = userInfo.sheet.getRange(user.rowIndex, 1, 1, 8).getValues()[0];
    row[userInfo.columns.username] = newUsername;
    row[userInfo.columns.active] = active;
    row[userInfo.columns.updatedAt] = new Date();
    row[userInfo.columns.sessionVersion] = user.sessionVersion + 1;
    if (newPassword) {
      const salt = createPasswordSalt_();
      row[userInfo.columns.salt] = salt;
      row[userInfo.columns.passwordHash] = derivePasswordHash_(newPassword, salt);
    }
    userInfo.sheet.getRange(user.rowIndex, 1, 1, row.length).setValues([row]);
    if (newPassword || newUsername !== username) {
      const cache = CacheService.getScriptCache();
      cache.remove(adminLoginRateLimitKey_(username));
      cache.remove(adminLoginRateLimitKey_(newUsername));
    }
    return { status: 'success', data: { username: newUsername, active: active } };
  } finally {
    lock.releaseLock();
  }
}

function changeOwnAdminPassword_(session, currentPasswordValue, newPasswordValue) {
  const currentPassword = String(currentPasswordValue || '');
  const newPassword = String(newPasswordValue || '');
  if (!isStrongAdminPassword_(newPassword)) {
    return { status: 'error', message: 'รหัสผ่านใหม่ต้องมีความยาว 8-128 ตัวอักษร' };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const userInfo = getAdminUserSheet_();
    const user = findAdminUser_(session.username);
    if (!user || !constantTimeEquals_(derivePasswordHash_(currentPassword, user.salt), user.passwordHash)) {
      return { status: 'error', message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' };
    }

    const salt = createPasswordSalt_();
    const row = userInfo.sheet.getRange(user.rowIndex, 1, 1, 8).getValues()[0];
    row[userInfo.columns.salt] = salt;
    row[userInfo.columns.passwordHash] = derivePasswordHash_(newPassword, salt);
    row[userInfo.columns.updatedAt] = new Date();
    row[userInfo.columns.sessionVersion] = user.sessionVersion + 1;
    userInfo.sheet.getRange(user.rowIndex, 1, 1, row.length).setValues([row]);
    CacheService.getScriptCache().remove(adminLoginRateLimitKey_(session.username));
    return { status: 'success', message: 'เปลี่ยนรหัสผ่านแล้ว กรุณาเข้าสู่ระบบใหม่' };
  } finally {
    lock.releaseLock();
  }
}

function getAdminBookings_() {
  const sheetInfo = getBookingSheet_();
  const rows = sheetInfo.sheet.getDataRange().getValues();
  return rows.slice(1).map(function(row) {
    const id = String(row[sheetInfo.columns.id] || '').trim();
    if (!id) return null;
    return bookingRecordFromRow_(row, sheetInfo);
  }).filter(Boolean).sort(function(left, right) {
    return String(right.createdAt || '').localeCompare(String(left.createdAt || ''));
  });
}

function updateAdminBooking_(booking) {
  const lock = LockService.getScriptLock();
  let updatedBooking;
  let shouldSendConfirmation = false;
  let shouldSendCancellationNotification = false;
  let shouldSendCustomerCancellationEmail = false;
  lock.waitLock(30000);
  try {
    if (!booking || typeof booking !== 'object') {
      return { status: 'error', message: 'ข้อมูลการจองไม่ถูกต้อง' };
    }

    const bookingId = String(booking.id || '').trim();
    const providedName = String(booking.name || '').trim();
    const phone = String(booking.phone || '').trim();
    const email = String(booking.email || '').trim();
    const checkIn = String(booking.checkIn || '').trim();
    const checkOut = String(booking.checkOut || '').trim();
    const people = String(booking.people || '').trim();
    const comment = String(booking.comment || '');
    const adminRemark = booking.adminRemark === undefined || booking.adminRemark === null
      ? null
      : String(booking.adminRemark);
    const requestedStatus = String(booking.status || '').trim().toLowerCase();
    const isHouseClosed = isHouseClosedStatus_(requestedStatus);
    const status = isHouseClosed ? 'close-ปิดบ้าน' : requestedStatus;
    let name = providedName || (isHouseClosed ? 'ปิดบ้าน' : '');
    const totalPrice = Number(booking.totalPrice);

    if (!bookingId || (!name && !isHouseClosed && status !== 'cancel') || name.length > 200 || phone.length > 50 ||
        people.length > 100 || !isValidIsoDate_(checkIn) ||
        !isValidIsoDate_(checkOut) || checkOut <= checkIn) {
      return { status: 'error', message: 'กรุณาตรวจสอบรหัส ชื่อ เบอร์โทร และช่วงวันที่' };
    }
    if (!isHouseClosed && status !== 'cancel' && !phone) {
      return { status: 'error', message: 'กรุณากรอกเบอร์โทรศัพท์' };
    }
    if (['booking', 'confirmed', 'complete', 'cancel'].indexOf(status) < 0 && !isHouseClosed) {
      return { status: 'error', message: 'สถานะไม่ถูกต้อง' };
    }
    if (!Number.isFinite(totalPrice) || totalPrice < 0 || comment.length > 5000 ||
        (adminRemark !== null && adminRemark.length > 5000)) {
      return { status: 'error', message: 'กรุณาตรวจสอบยอดเงินหรือข้อความเพิ่มเติม' };
    }
    if (email && !isValidEmail_(email) && !isHouseClosed) {
      return { status: 'error', message: 'รูปแบบอีเมลไม่ถูกต้อง' };
    }
    if (status === 'confirmed' && !isValidEmail_(email)) {
      return { status: 'error', message: 'กรุณากรอกอีเมลที่ถูกต้องก่อนยืนยันการจอง' };
    }

    const sheetInfo = ensureBookingMetadataColumns_(getBookingSheet_());
    if (!Number.isInteger(sheetInfo.columns.adminRemark) ||
        sheetInfo.columns.adminRemark < 0 || sheetInfo.columns.adminRemark >= sheetInfo.headers.length) {
      return { status: 'error', message: 'ไม่พบคอลัมน์ adminRemark ในชีตการจอง' };
    }
    const rows = sheetInfo.sheet.getDataRange().getValues();
    let targetRowIndex = -1;
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
      if (String(rows[rowIndex][sheetInfo.columns.id] || '').trim() === bookingId) {
        targetRowIndex = rowIndex;
        break;
      }
    }
    if (targetRowIndex < 0) return { status: 'error', message: 'ไม่พบรายการจองนี้ อาจถูกลบไปแล้ว' };
    const previousStatus = getRowStatus_(rows[targetRowIndex], sheetInfo.columns.statuses).toLowerCase();
    const isReopeningHouse = status === 'cancel' && isHouseClosedStatus_(previousStatus);
    if (isReopeningHouse && !name) name = 'ปิดบ้าน';
    if (!name || (!isHouseClosed && !isReopeningHouse && !phone)) {
      return { status: 'error', message: 'กรุณาตรวจสอบชื่อและเบอร์โทรศัพท์' };
    }
    shouldSendConfirmation = status === 'confirmed' && previousStatus !== 'confirmed';
    shouldSendCancellationNotification = status === 'cancel' &&
      !isCancelledStatus_(previousStatus) && !isHouseClosedStatus_(previousStatus);
    shouldSendCustomerCancellationEmail = shouldSendCancellationNotification;

    if (!isCancelledStatus_(status)) {
      for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
        if (rowIndex === targetRowIndex) continue;
        const row = rows[rowIndex];
        if (isCancelledStatus_(getRowStatus_(row, sheetInfo.columns.statuses))) continue;
        const existingCheckIn = dateCellToIso_(row[sheetInfo.columns.checkIn]);
        const existingCheckOut = dateCellToIso_(row[sheetInfo.columns.checkOut]);
        if (existingCheckIn && existingCheckOut &&
            existingCheckIn < checkOut && existingCheckOut > checkIn) {
          return {
            status: 'conflict',
            message: 'ช่วงวันที่แก้ไขทับซ้อนกับรายการจอง ' + String(row[sheetInfo.columns.id] || '')
          };
        }
      }
    }

    const updatedRow = rows[targetRowIndex].slice();
    updatedRow[sheetInfo.columns.name] = name;
    updatedRow[sheetInfo.columns.phone] = phone;
    updatedRow[sheetInfo.columns.checkIn] = checkIn;
    updatedRow[sheetInfo.columns.checkOut] = checkOut;
    updatedRow[sheetInfo.columns.nights] = Math.round(
      (Date.parse(checkOut + 'T00:00:00Z') - Date.parse(checkIn + 'T00:00:00Z')) / 86400000
    );
    updatedRow[sheetInfo.columns.people] = people;
    updatedRow[sheetInfo.columns.comment] = comment;
    updatedRow[sheetInfo.columns.adminRemark] = adminRemark === null
      ? String(updatedRow[sheetInfo.columns.adminRemark] || '')
      : adminRemark;
    updatedRow[sheetInfo.columns.totalPrice] = isHouseClosed ? 0 : totalPrice;
    updatedRow[sheetInfo.columns.email] = email;
    sheetInfo.columns.statuses.forEach(function(columnIndex) {
      updatedRow[columnIndex] = status;
    });

    sheetInfo.sheet.getRange(targetRowIndex + 1, 1, 1, updatedRow.length).setValues([updatedRow]);
    updatedBooking = bookingRecordFromRow_(updatedRow, sheetInfo);
  } finally {
    lock.releaseLock();
  }

  const result = { status: 'success', data: updatedBooking };
  if (shouldSendConfirmation) {
    try {
      sendBookingConfirmationEmail_(updatedBooking);
      result.emailStatus = 'sent';
    } catch (error) {
      console.error('ไม่สามารถส่งอีเมลยืนยันการจองได้:', error && error.stack ? error.stack : error);
      result.emailStatus = 'failed';
      const detail = error && error.message ? String(error.message).slice(0, 300) : 'ไม่ทราบสาเหตุ';
      result.emailMessage = 'บันทึกการยืนยันแล้ว แต่ส่งอีเมลไม่สำเร็จ: ' + detail;
    }
  }
  if (shouldSendCancellationNotification) {
    try {
      sendBookingNotificationToAdmins_(updatedBooking, 'cancel');
      result.adminNotificationStatus = 'sent';
    } catch (error) {
      console.error('ไม่สามารถส่งอีเมลแจ้งการยกเลิกให้ผู้ดูแลได้:', error && error.stack ? error.stack : error);
      result.adminNotificationStatus = 'failed';
      const detail = error && error.message ? String(error.message).slice(0, 300) : 'ไม่ทราบสาเหตุ';
      result.adminNotificationMessage = 'บันทึกการยกเลิกแล้ว แต่แจ้งเตือนผู้ดูแลทางอีเมลไม่สำเร็จ: ' + detail;
    }
  }
  if (shouldSendCustomerCancellationEmail) {
    try {
      sendBookingCancellationEmail_(updatedBooking);
      result.customerEmailStatus = 'sent';
    } catch (error) {
      console.error('ไม่สามารถส่งอีเมลแจ้งการยกเลิกให้ลูกค้าได้:', error && error.stack ? error.stack : error);
      result.customerEmailStatus = 'failed';
      const detail = error && error.message ? String(error.message).slice(0, 300) : 'ไม่ทราบสาเหตุ';
      result.customerEmailMessage = 'บันทึกการยกเลิกแล้ว แต่แจ้งลูกค้าทางอีเมลไม่สำเร็จ: ' + detail;
    }
  }
  return result;
}

function resendBookingConfirmationEmail_(bookingId) {
  const lock = LockService.getScriptLock();
  let booking;
  lock.waitLock(30000);
  try {
    const sheetInfo = getBookingSheet_();
    const rows = sheetInfo.sheet.getDataRange().getValues();
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
      if (String(rows[rowIndex][sheetInfo.columns.id] || '').trim() !== String(bookingId || '').trim()) continue;
      booking = bookingRecordFromRow_(rows[rowIndex], sheetInfo);
      break;
    }
    if (!booking) return { status: 'error', message: 'ไม่พบรายการจองนี้' };
    if (String(booking.status || '').trim().toLowerCase() !== 'confirmed') {
      return { status: 'error', message: 'ส่งอีเมลได้เฉพาะรายการที่ยืนยันแล้ว' };
    }
  } finally {
    lock.releaseLock();
  }

  sendBookingConfirmationEmail_(booking);
  return { status: 'success', data: { email: booking.email } };
}

function resendCancellationNotification_(bookingId) {
  const lock = LockService.getScriptLock();
  let booking;
  lock.waitLock(30000);
  try {
    const sheetInfo = getBookingSheet_();
    const rows = sheetInfo.sheet.getDataRange().getValues();
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
      if (String(rows[rowIndex][sheetInfo.columns.id] || '').trim() !== String(bookingId || '').trim()) continue;
      booking = bookingRecordFromRow_(rows[rowIndex], sheetInfo);
      break;
    }
    if (!booking) return { status: 'error', message: 'ไม่พบรายการจองนี้' };
    if (!isCancelledStatus_(booking.status)) {
      return { status: 'error', message: 'ส่งการแจ้งเตือนได้เฉพาะรายการที่ยกเลิกแล้ว' };
    }
  } finally {
    lock.releaseLock();
  }

  sendBookingNotificationToAdmins_(booking, 'cancel');
  return { status: 'success', message: 'ส่งอีเมลแจ้งการยกเลิกให้ผู้ดูแลแล้ว' };
}

function resendBookingCancellationEmail_(bookingId) {
  const lock = LockService.getScriptLock();
  let booking;
  lock.waitLock(30000);
  try {
    const sheetInfo = getBookingSheet_();
    const rows = sheetInfo.sheet.getDataRange().getValues();
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
      if (String(rows[rowIndex][sheetInfo.columns.id] || '').trim() !== String(bookingId || '').trim()) continue;
      booking = bookingRecordFromRow_(rows[rowIndex], sheetInfo);
      break;
    }
    if (!booking) return { status: 'error', message: 'ไม่พบรายการจองนี้' };
    if (!isCancelledStatus_(booking.status)) {
      return { status: 'error', message: 'ส่งอีเมลได้เฉพาะรายการที่ยกเลิกแล้ว' };
    }
  } finally {
    lock.releaseLock();
  }

  sendBookingCancellationEmail_(booking);
  return { status: 'success', data: { email: booking.email } };
}

function sendBookingConfirmationEmail_(booking) {
  if (!booking || !isValidEmail_(booking.email)) {
    throw new Error('ไม่มีอีเมลลูกค้าที่ถูกต้องสำหรับรายการจองนี้');
  }

  const escapeHtml = function(value) {
    return String(value == null || value === '' ? 'ไม่มี' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };
  const details = [
    ['รหัสจอง', booking.id],
    ['ชื่อผู้จอง', booking.name],
    ['อีเมล', booking.email],
    ['เบอร์โทรศัพท์', booking.phone],
    ['วันเข้าพัก', booking.checkIn],
    ['วันเช็คเอาท์', booking.checkOut],
    ['จำนวนคืน', String(booking.nights) + ' คืน'],
    ['จำนวนผู้เข้าพัก', booking.people],
    ['ยอดชำระวันเข้าพัก', '฿' + (Number(booking.totalPrice) || 0).toLocaleString('th-TH') + ' บาท'],
    ['คำขอเพิ่มเติม', booking.comment || 'ไม่มี'],
    ['สถานะ', 'ยืนยันแล้ว']
  ];
  const textDetails = details.map(function(detail) {
    return detail[0] + ': ' + (detail[1] || 'ไม่มี');
  }).join('\n');
  const htmlRows = details.map(function(detail) {
    return '<tr><th style="padding:8px;text-align:left;border-bottom:1px solid #e2e8f0">' +
      escapeHtml(detail[0]) + '</th><td style="padding:8px;border-bottom:1px solid #e2e8f0">' +
      escapeHtml(detail[1]) + '</td></tr>';
  }).join('');
  const subject = 'ยืนยันการจองบ้านชายหาด ' + booking.id;
  const body = 'เรียน คุณ' + (booking.name || '') + '\n\n' +
    'ยืนยันการจองบ้านชายหาดเรียบร้อยแล้ว รายละเอียดการจอง:\n' + textDetails +
    '\n\nกรุณาทักที่เพจเพื่อเอาไว้ติดต่อสื่อสารกัน และระบุหมายเลขการจองมาด้วยนะครับ: https://www.facebook.com/BaanShineHeartRayong' +
    '\nติดต่อเจ้าของบ้าน: พี่จอร์จ 080-565-0481';
  const htmlBody = '<div style="font-family:Arial,sans-serif;color:#1e293b;line-height:1.6">' +
    '<p>เรียน คุณ' + escapeHtml(booking.name) + '</p>' +
    '<p>ยืนยันการจองบ้านชายหาดเรียบร้อยแล้ว รายละเอียดการจอง:</p>' +
    '<table style="border-collapse:collapse;width:100%;max-width:640px">' + htmlRows + '</table>' +
    '<p>กรุณาทักที่เพจเพื่อเอาไว้ติดต่อสื่อสารกัน และระบุหมายเลขการจองมาด้วยนะครับ: ' +
    '<a href="https://www.facebook.com/BaanShineHeartRayong">Facebook บ้านชายหาด</a></p>' +
    '<p>ติดต่อเจ้าของบ้าน: พี่จอร์จ 080-565-0481</p></div>';

  MailApp.sendEmail({
    to: booking.email,
    subject: subject,
    body: body,
    htmlBody: htmlBody,
    name: 'บ้านชายหาด'
  });
}

function sendBookingCancellationEmail_(booking) {
  if (!booking || !isValidEmail_(booking.email)) {
    throw new Error('ไม่มีอีเมลลูกค้าที่ถูกต้องสำหรับรายการจองนี้');
  }

  const escapeHtml = function(value) {
    return String(value == null || value === '' ? 'ไม่มี' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };
  const details = [
    ['รหัสจอง', booking.id],
    ['ชื่อผู้จอง', booking.name],
    ['อีเมล', booking.email],
    ['เบอร์โทรศัพท์', booking.phone],
    ['วันเข้าพัก', booking.checkIn],
    ['วันเช็คเอาท์', booking.checkOut],
    ['จำนวนคืน', String(booking.nights) + ' คืน'],
    ['จำนวนผู้เข้าพัก', booking.people],
    ['ยอดชำระวันเข้าพัก', '฿' + (Number(booking.totalPrice) || 0).toLocaleString('th-TH') + ' บาท'],
    ['คำขอเพิ่มเติม', booking.comment || 'ไม่มี'],
    ['สถานะ', 'ยกเลิกแล้ว']
  ];
  const textDetails = details.map(function(detail) {
    return detail[0] + ': ' + (detail[1] || 'ไม่มี');
  }).join('\n');
  const htmlRows = details.map(function(detail) {
    return '<tr><th style="padding:8px;text-align:left;border-bottom:1px solid #e2e8f0">' +
      escapeHtml(detail[0]) + '</th><td style="padding:8px;border-bottom:1px solid #e2e8f0">' +
      escapeHtml(detail[1]) + '</td></tr>';
  }).join('');
  MailApp.sendEmail({
    to: booking.email,
    subject: 'แจ้งยกเลิกการจองบ้านชายหาด ' + booking.id,
    body: 'เรียน คุณ' + (booking.name || '') + '\n\n' +
      'แจ้งให้ทราบว่ารายการจองบ้านชายหาดของท่านถูกยกเลิกแล้ว รายละเอียด:\n' + textDetails +
      '\n\nสอบถามเพิ่มเติม ติดต่อพี่จอร์จ 080-565-0481',
    htmlBody: '<div style="font-family:Arial,sans-serif;color:#1e293b;line-height:1.6">' +
      '<p>เรียน คุณ' + escapeHtml(booking.name) + '</p>' +
      '<p>แจ้งให้ทราบว่ารายการจองบ้านชายหาดของท่านถูกยกเลิกแล้ว รายละเอียด:</p>' +
      '<table style="border-collapse:collapse;width:100%;max-width:640px">' + htmlRows + '</table>' +
      '<p>สอบถามเพิ่มเติม ติดต่อพี่จอร์จ 080-565-0481</p></div>',
    name: 'บ้านชายหาด'
  });
}

function authorizeBookingEmailSending() {
  return MailApp.getRemainingDailyQuota();
}

function bookingRecordFromRow_(row, sheetInfo) {
  return {
    id: String(row[sheetInfo.columns.id] || '').trim(),
    name: String(row[sheetInfo.columns.name] || ''),
    phone: String(row[sheetInfo.columns.phone] || ''),
    checkIn: dateCellToIso_(row[sheetInfo.columns.checkIn]),
    checkOut: dateCellToIso_(row[sheetInfo.columns.checkOut]),
    nights: Number(row[sheetInfo.columns.nights]) || 0,
    people: String(row[sheetInfo.columns.people] || ''),
    email: sheetInfo.columns.email >= 0 ? String(row[sheetInfo.columns.email] || '') : '',
    bookBy: sheetInfo.columns.bookBy >= 0 ? String(row[sheetInfo.columns.bookBy] || '') : '',
    adminRemark: sheetInfo.columns.adminRemark >= 0 ? String(row[sheetInfo.columns.adminRemark] || '') : '',
    status: getRowStatus_(row, sheetInfo.columns.statuses),
    comment: String(row[sheetInfo.columns.comment] || ''),
    totalPrice: Number(row[sheetInfo.columns.totalPrice]) || 0,
    createdAt: dateTimeCellToString_(row[sheetInfo.columns.createdAt])
  };
}

function dateTimeCellToString_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    const timeZone = getDateTimeZone_();
    return Utilities.formatDate(value, timeZone, 'yyyy-MM-dd HH:mm:ss');
  }
  return String(value || '');
}

function getDateTimeZone_() {
  return Session.getScriptTimeZone();
}

function getAvailability_(bookingWindow) {
  const window = bookingWindow || getBookingWindow_();
  const sheetInfo = getBookingSheet_();
  const lastRow = sheetInfo.sheet.getLastRow();
  if (lastRow < 2) return [];

  const requiredColumns = [
    sheetInfo.columns.checkIn,
    sheetInfo.columns.checkOut
  ].concat(sheetInfo.columns.statuses);
  const firstColumn = Math.min.apply(null, requiredColumns);
  const lastColumn = Math.max.apply(null, requiredColumns);
  const rows = sheetInfo.sheet.getRange(
    2,
    firstColumn + 1,
    lastRow - 1,
    lastColumn - firstColumn + 1
  ).getValues();
  const records = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const checkIn = dateCellToIso_(row[sheetInfo.columns.checkIn - firstColumn]);
    const checkOut = dateCellToIso_(row[sheetInfo.columns.checkOut - firstColumn]);
    if (!checkIn || !checkOut || checkOut <= checkIn) continue;
    if (checkOut <= window.startDate || checkIn > window.maxCheckIn) continue;

    records.push({
      checkIn: checkIn,
      checkOut: checkOut,
      status: getRowStatus_(row, sheetInfo.columns.statuses.map(function(column) {
        return column - firstColumn;
      }))
    });
  }

  return records;
}

function getBookingWindow_() {
  const timeZone = Session.getScriptTimeZone();
  const startDate = Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd');
  return {
    startDate: startDate,
    maxCheckIn: addMonthsToIsoDate_(startDate, 3)
  };
}

function addMonthsToIsoDate_(dateValue, months) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ''));
  if (!match) throw new Error('วันที่สำหรับคำนวณช่วงจองไม่ถูกต้อง');

  const year = Number(match[1]);
  const month = Number(match[2]) - 1 + months;
  const day = Number(match[3]);
  const targetMonthDate = new Date(Date.UTC(year, month, 1));
  const targetLastDay = new Date(Date.UTC(
    targetMonthDate.getUTCFullYear(),
    targetMonthDate.getUTCMonth() + 1,
    0
  )).getUTCDate();
  return [
    targetMonthDate.getUTCFullYear(),
    String(targetMonthDate.getUTCMonth() + 1).padStart(2, '0'),
    String(Math.min(day, targetLastDay)).padStart(2, '0')
  ].join('-');
}

function createAdminBooking_(booking, session) {
  const status = String(booking && booking.status || 'booking').trim().toLowerCase();
  if (status !== 'booking' && !isHouseClosedStatus_(status)) {
    return { status: 'error', message: 'สร้างรายการได้เฉพาะสถานะรอยืนยันหรือ Close-ปิดบ้าน' };
  }
  const adminRemark = String(booking && booking.adminRemark || '');
  if (adminRemark.length > 5000) {
    return { status: 'error', message: 'หมายเหตุจากผู้ดูแลต้องมีความยาวไม่เกิน 5000 ตัวอักษร' };
  }
  return reserveBooking_(booking, session.username, true, true, status, adminRemark);
}

function reserveBooking_(booking, bookBy, skipDuplicateRequest, allowBeyondBookingWindow, requestedStatus, adminRemark) {
  const lock = LockService.getScriptLock();
  let bookingResult;
  let notificationBooking;
  lock.waitLock(30000);
  try {
    if (!booking || typeof booking !== 'object') {
      return { status: 'error', message: 'ข้อมูลการจองไม่ถูกต้อง' };
    }

    const checkIn = String(booking.checkIn || '').trim();
    const checkOut = String(booking.checkOut || '').trim();
    const status = isHouseClosedStatus_(requestedStatus) ? 'close-ปิดบ้าน' : 'booking';
    const isHouseClosed = isHouseClosedStatus_(status);
    if (!isValidIsoDate_(checkIn) || !isValidIsoDate_(checkOut) || checkOut <= checkIn) {
      return { status: 'error', message: 'กรุณาตรวจสอบวันที่เข้าพัก' };
    }
    const bookingWindow = getBookingWindow_();
    if (checkIn < bookingWindow.startDate ||
        (!allowBeyondBookingWindow && checkIn > bookingWindow.maxCheckIn)) {
      return {
        status: 'error',
        message: allowBeyondBookingWindow
          ? 'ไม่สามารถจองวันที่ผ่านมาแล้วได้'
          : 'สามารถจองได้ตั้งแต่วันนี้และล่วงหน้าไม่เกิน 3 เดือน'
      };
    }

    const name = String(booking.name || '').trim();
    const phone = String(booking.phone || '').trim();
    const email = String(booking.email || '').trim();
    if (!isHouseClosed && (!name || !phone || !email)) {
      return { status: 'error', message: 'กรุณากรอกชื่อ เบอร์โทรศัพท์ และอีเมล' };
    }
    if ((!isHouseClosed && name.length > 200) || phone.length > 50 ||
        (!isHouseClosed && !isValidEmail_(email))) {
      return { status: 'error', message: 'กรุณาตรวจสอบชื่อ เบอร์โทรศัพท์ และรูปแบบอีเมล' };
    }

    const sheetInfo = ensureBookingMetadataColumns_(getBookingSheet_());
    const rows = sheetInfo.sheet.getDataRange().getValues();
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      const existingStatus = getRowStatus_(row, sheetInfo.columns.statuses);
      const existingCheckIn = dateCellToIso_(row[sheetInfo.columns.checkIn]);
      const existingCheckOut = dateCellToIso_(row[sheetInfo.columns.checkOut]);
      const existingName = String(row[sheetInfo.columns.name] || '').trim();
      const existingPhone = String(row[sheetInfo.columns.phone] || '').trim();
      if (!skipDuplicateRequest && !isCancelledStatus_(existingStatus) &&
          existingCheckIn === checkIn && existingCheckOut === checkOut &&
          existingName === name && existingPhone === phone) {
        return {
          status: 'success',
          data: {
            id: String(row[sheetInfo.columns.id] || '').trim(),
            checkIn: checkIn,
            checkOut: checkOut,
            status: existingStatus
          }
        };
      }

      if (isCancelledStatus_(existingStatus)) continue;
      if (existingCheckIn && existingCheckOut &&
          existingCheckIn < checkOut && existingCheckOut > checkIn) {
        return { status: 'conflict', message: 'ช่วงวันที่เลือกมีผู้จองแล้ว' };
      }
    }

    const timeZone = getDateTimeZone_();
    const currentYear = Number(Utilities.formatDate(new Date(), timeZone, 'yyyy'));
    const bookingId = getNextBookingId_(
      rows,
      sheetInfo.columns.id,
      sheetInfo.columns.createdAt,
      currentYear
    );
    const record = {
      id: bookingId,
      name: isHouseClosed ? 'ปิดบ้าน' : name,
      phone: phone,
      checkIn: checkIn,
      checkOut: checkOut,
      nights: Math.round((Date.parse(checkOut + 'T00:00:00Z') - Date.parse(checkIn + 'T00:00:00Z')) / 86400000),
      guests: String(booking.guests || ''),
      email: email,
      bookBy: String(bookBy || 'website'),
      status: status,
      comment: String(booking.notes || booking.comment || ''),
      adminRemark: String(adminRemark || ''),
      totalPrice: isHouseClosed ? 0 : Number(booking.totalPrice) || 0,
      createdAt: new Date()
    };

    const newRow = sheetInfo.headers.map(function(header, index) {
      const normalizedHeader = header.trim().toLowerCase();
      if (normalizedHeader === 'people' || normalizedHeader === 'guests') {
        return index === sheetInfo.columns.people ? record.guests : '';
      }
      if (normalizedHeader === 'comment' || normalizedHeader === 'notes') {
        return index === sheetInfo.columns.comment ? record.comment : '';
      }

      const recordKey = {
        checkin: 'checkIn',
        checkout: 'checkOut',
        totalprice: 'totalPrice',
        createdat: 'createdAt',
        bookby: 'bookBy',
        adminremark: 'adminRemark'
      }[normalizedHeader] || normalizedHeader;
      return Object.prototype.hasOwnProperty.call(record, recordKey) ? record[recordKey] : '';
    });
    sheetInfo.columns.statuses.forEach(function(columnIndex) {
      newRow[columnIndex] = record.status;
    });

    sheetInfo.sheet.getRange(sheetInfo.sheet.getLastRow() + 1, 1, 1, newRow.length).setValues([newRow]);
    notificationBooking = record;
    bookingResult = {
      status: 'success',
      data: {
        id: record.id,
        checkIn: record.checkIn,
        checkOut: record.checkOut,
        status: record.status
      }
    };
  } finally {
    lock.releaseLock();
  }

  if (!isHouseClosedStatus_(notificationBooking.status)) {
    try {
      sendNewBookingNotificationToAdmins_(notificationBooking);
      bookingResult.adminNotificationStatus = 'sent';
    } catch (error) {
      console.error('ไม่สามารถส่งอีเมลแจ้งเตือนการจองให้ผู้ดูแลได้:', error && error.stack ? error.stack : error);
      bookingResult.adminNotificationStatus = 'failed';
      const detail = error && error.message ? String(error.message).slice(0, 300) : 'ไม่ทราบสาเหตุ';
      bookingResult.adminNotificationMessage = 'บันทึกการจองแล้ว แต่แจ้งเตือนผู้ดูแลทางอีเมลไม่สำเร็จ: ' + detail;
    }
  }
  return bookingResult;
}

function sendNewBookingNotificationToAdmins_(booking) {
  return sendBookingNotificationToAdmins_(booking, 'new');
}

function sendBookingNotificationToAdmins_(booking, eventType) {
  const userInfo = getAdminUserSheet_();
  const emailColumn = userInfo.columns.email;
  if (emailColumn < 0) throw new Error('ไม่พบคอลัมน์ email ในชีต user');

  const rows = userInfo.sheet.getDataRange().getValues();
  const seenEmails = {};
  const recipients = [];
  const adminsWithoutValidEmail = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const username = String(row[userInfo.columns.username] || '').trim();
    if (!username || !isAdminUserActive_({ active: row[userInfo.columns.active] })) {
      continue;
    }

    const email = String(row[emailColumn] || '').trim();
    if (!isValidEmail_(email)) {
      adminsWithoutValidEmail.push(username);
      continue;
    }
    const normalizedEmail = email.toLowerCase();
    if (seenEmails[normalizedEmail]) continue;
    seenEmails[normalizedEmail] = true;
    recipients.push(email);
  }
  if (adminsWithoutValidEmail.length) {
    throw new Error('มีบัญชีผู้ดูแลที่เปิดใช้งานแต่ไม่มี email ที่ถูกต้องในชีต user');
  }
  if (!recipients.length) throw new Error('ไม่พบ email ที่ถูกต้องของผู้ดูแลที่เปิดใช้งานในชีต user');

  const escapeHtml = function(value) {
    return String(value == null || value === '' ? 'ไม่มี' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };
  const details = [
    ['รหัสจอง', booking.id],
    ['ผู้ทำรายการ', booking.bookBy || 'website'],
    ['ชื่อผู้จอง', booking.name],
    ['อีเมลลูกค้า', booking.email],
    ['เบอร์โทรศัพท์', booking.phone],
    ['วันเข้าพัก', booking.checkIn],
    ['วันเช็คเอาท์', booking.checkOut],
    ['จำนวนคืน', String(booking.nights) + ' คืน'],
    ['จำนวนผู้เข้าพัก', booking.guests || booking.people],
    ['ยอดชำระวันเข้าพัก', '฿' + (Number(booking.totalPrice) || 0).toLocaleString('th-TH') + ' บาท'],
    ['คำขอเพิ่มเติม', booking.comment || 'ไม่มี'],
    ['สถานะ', eventType === 'cancel' ? 'ยกเลิกแล้ว' : 'รอแอดมินยืนยัน']
  ];
  const textDetails = details.map(function(detail) {
    return detail[0] + ': ' + (detail[1] || 'ไม่มี');
  }).join('\n');
  const htmlRows = details.map(function(detail) {
    return '<tr><th style="padding:8px;text-align:left;border-bottom:1px solid #e2e8f0">' +
      escapeHtml(detail[0]) + '</th><td style="padding:8px;border-bottom:1px solid #e2e8f0">' +
      escapeHtml(detail[1]) + '</td></tr>';
  }).join('');
  const eventTitle = eventType === 'cancel' ? 'มีการยกเลิกรายการจอง' : 'มีรายการจองใหม่เข้ามา';
  const message = {
    to: recipients[0],
    subject: eventTitle + ' ' + booking.id + ' — บ้านชายหาด',
    body: eventTitle + ' รายละเอียด:\n\n' + textDetails,
    htmlBody: '<div style="font-family:Arial,sans-serif;color:#1e293b;line-height:1.6">' +
      '<p>' + eventTitle + ' รายละเอียด:</p>' +
      '<table style="border-collapse:collapse;width:100%;max-width:640px">' + htmlRows + '</table></div>',
    name: 'บ้านชายหาด'
  };
  if (recipients.length > 1) message.bcc = recipients.slice(1).join(',');
  MailApp.sendEmail(message);
}

function getNextBookingId_(rows, idColumn, createdAtColumn, year) {
  const prefix = getYearPrefix_(year);
  const pattern = new RegExp('^' + prefix + '-(\\d+)$');
  let highestNumber = 0;

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const match = pattern.exec(String(rows[rowIndex][idColumn] || '').trim());
    if (!match) continue;

    const createdAt = rows[rowIndex][createdAtColumn];
    if (createdAt) {
      const createdAtYear = Number(dateTimeCellToString_(createdAt).slice(0, 4));
      if (Number.isInteger(createdAtYear) && createdAtYear !== year) continue;
    }
    highestNumber = Math.max(highestNumber, Number(match[1]));
  }

  return prefix + '-' + String(highestNumber + 1).padStart(4, '0');
}

function getYearPrefix_(year) {
  let sequence = year - 2025;
  if (sequence < 1) throw new Error('ไม่สามารถสร้างรหัสจองสำหรับปีก่อน พ.ศ. 2569 ได้');

  let prefix = '';
  while (sequence > 0) {
    sequence--;
    prefix = String.fromCharCode(65 + (sequence % 26)) + prefix;
    sequence = Math.floor(sequence / 26);
  }
  return prefix;
}

function getBookingSheet_() {
  return {
    sheet: createFirestoreSheetAdapter_('bookings', FIRESTORE_BOOKING_HEADERS, 'id'),
    headers: FIRESTORE_BOOKING_HEADERS.slice(),
    columns: {
      id: 0,
      name: 1,
      phone: 2,
      checkIn: 3,
      checkOut: 4,
      nights: 5,
      people: 6,
      comment: 7,
      statuses: [8],
      totalPrice: 9,
      createdAt: 10,
      email: 11,
      bookBy: 12,
      adminRemark: 13
    }
  };
}

function getLegacyBookingSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('สคริปต์ต้องผูกกับ Google Spreadsheet');

  const required = ['id', 'name', 'phone', 'checkin', 'checkout', 'nights', 'status', 'totalprice', 'createdat'];
  const sheets = spreadsheet.getSheets();
  for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex++) {
    const sheet = sheets[sheetIndex];
    const lastColumn = sheet.getLastColumn();
    if (!lastColumn) continue;

    const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0].map(function(value) {
      return String(value || '').trim();
    });
    const normalized = headers.map(function(value) { return value.toLowerCase(); });
    if (!required.every(function(header) { return normalized.indexOf(header) !== -1; })) continue;
    const peopleColumn = normalized.indexOf('people');
    const guestsColumn = normalized.indexOf('guests');
    if (peopleColumn < 0 && guestsColumn < 0) continue;
    const commentColumn = normalized.indexOf('comment');
    const notesColumn = normalized.indexOf('notes');
    if (commentColumn < 0 && notesColumn < 0) continue;

    return {
      sheet: sheet,
      headers: headers,
      columns: {
        id: normalized.indexOf('id'),
        name: normalized.indexOf('name'),
        phone: normalized.indexOf('phone'),
        checkIn: normalized.indexOf('checkin'),
        checkOut: normalized.indexOf('checkout'),
        nights: normalized.indexOf('nights'),
        people: peopleColumn >= 0 ? peopleColumn : guestsColumn,
        comment: commentColumn >= 0 ? commentColumn : notesColumn,
        totalPrice: normalized.indexOf('totalprice'),
        createdAt: normalized.indexOf('createdat'),
        email: normalized.indexOf('email'),
        bookBy: normalized.indexOf('bookby'),
        adminRemark: normalized.indexOf('adminremark'),
        statuses: normalized.reduce(function(indices, header, index) {
          if (header === 'status') indices.push(index);
          return indices;
        }, [])
      }
    };
  }

  throw new Error('ไม่พบแท็บที่มีหัวคอลัมน์การจองครบถ้วน');
}

function migrateSheetsToFirestore() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const properties = PropertiesService.getScriptProperties();
    const migrationStarted = properties.getProperty('FIRESTORE_MIGRATION_STARTED') === 'true';
    if (!migrationStarted &&
        (firestoreListDocuments_('bookings').length || firestoreListDocuments_('adminUsers').length)) {
      throw new Error('Firestore มีข้อมูลอยู่แล้ว จึงหยุดการย้ายเพื่อป้องกันการเขียนทับ');
    }

    const bookingInfo = getLegacyBookingSheet_();
    const userInfo = getLegacyAdminUserSheet_();
    const bookingRows = bookingInfo.sheet.getDataRange().getValues();
    const userRows = userInfo.sheet.getDataRange().getValues();
    const imported = { bookings: 0, adminUsers: 0 };
    const skipped = { bookings: 0, adminUsers: 0 };
    const seenBookingIds = {};
    const seenUsernames = {};
    const bookingEntries = bookingRows.slice(1).map(function(row) {
      return { row: row, booking: bookingRecordFromRow_(row, bookingInfo) };
    }).filter(function(entry) { return entry.booking.id; });
    const userEntries = userRows.slice(1).map(function(row) {
      return { row: row, username: normalizeAdminUsername_(row[userInfo.columns.username]) };
    }).filter(function(entry) { return entry.username; });

    bookingEntries.forEach(function(entry) {
      const booking = entry.booking;
      if (seenBookingIds[booking.id]) throw new Error('พบรหัสจองซ้ำในชีต: ' + booking.id);
      seenBookingIds[booking.id] = true;
    });
    userEntries.forEach(function(entry) {
      if (seenUsernames[entry.username]) {
        throw new Error('พบ username ซ้ำในชีต user: ' + entry.username);
      }
      seenUsernames[entry.username] = true;
    });

    properties.setProperty('FIRESTORE_MIGRATION_STARTED', 'true');
    bookingEntries.forEach(function(entry) {
      const row = entry.row;
      const booking = entry.booking;
      if (firestoreGetDocument_('bookings', booking.id)) {
        skipped.bookings++;
        return;
      }

      firestoreWriteDocument_('bookings', booking.id, {
        id: booking.id,
        name: booking.name,
        phone: booking.phone,
        checkin: booking.checkIn,
        checkout: booking.checkOut,
        nights: booking.nights,
        people: booking.people,
        comment: booking.comment,
        status: booking.status,
        totalprice: booking.totalPrice,
        createdat: row[bookingInfo.columns.createdAt] || booking.createdAt,
        email: booking.email,
        bookby: booking.bookBy,
        adminRemark: booking.adminRemark
      });
      imported.bookings++;
    });

    userEntries.forEach(function(entry) {
      const row = entry.row;
      const username = entry.username;
      if (firestoreGetDocument_('adminUsers', username)) {
        skipped.adminUsers++;
        return;
      }

      firestoreWriteDocument_('adminUsers', username, {
        username: username,
        passwordHash: String(row[userInfo.columns.passwordHash] || ''),
        salt: String(row[userInfo.columns.salt] || ''),
        role: String(row[userInfo.columns.role] || 'admin'),
        active: isAdminUserActive_({ active: row[userInfo.columns.active] }),
        createdAt: row[userInfo.columns.createdAt] || '',
        updatedAt: row[userInfo.columns.updatedAt] || '',
        sessionVersion: Number(row[userInfo.columns.sessionVersion]) || 1,
        email: userInfo.columns.email >= 0 ? String(row[userInfo.columns.email] || '') : ''
      });
      imported.adminUsers++;
    });

    properties.setProperty('FIRESTORE_MIGRATION_COMPLETE', 'true');
    const result = {
      status: 'success',
      mode: migrationStarted ? 'incremental' : 'initial',
      imported: imported,
      skipped: skipped
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function ensureBookingMetadataColumns_(sheetInfo) {
  const missingHeaders = [];
  if (sheetInfo.columns.email < 0) missingHeaders.push('email');
  if (sheetInfo.columns.bookBy < 0) missingHeaders.push('bookBy');
  if (!Number.isInteger(sheetInfo.columns.adminRemark) || sheetInfo.columns.adminRemark < 0) {
    missingHeaders.push('adminRemark');
  }
  if (!missingHeaders.length) return sheetInfo;

  const firstNewColumn = sheetInfo.sheet.getLastColumn() + 1;
  sheetInfo.sheet.getRange(1, firstNewColumn, 1, missingHeaders.length).setValues([missingHeaders]);
  missingHeaders.forEach(function(header, index) {
    const columnIndex = firstNewColumn - 1 + index;
    sheetInfo.headers.push(header);
    const columnKey = { email: 'email', bookBy: 'bookBy', adminRemark: 'adminRemark' }[header];
    sheetInfo.columns[columnKey] = columnIndex;
  });
  return sheetInfo;
}

function isValidEmail_(value) {
  const email = String(value || '').trim();
  if (!email || email.length > 254) return false;
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || parts[0].length > 64 || parts[0].charAt(0) === '.' ||
      parts[0].charAt(parts[0].length - 1) === '.' || parts[0].indexOf('..') >= 0 ||
      !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(parts[0])) {
    return false;
  }
  const domainLabels = parts[1].split('.');
  return domainLabels.length >= 2 && domainLabels.every(function(label) {
    return label.length >= 1 && label.length <= 63 &&
      /^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/i.test(label);
  }) && domainLabels[domainLabels.length - 1].length >= 2;
}

function removeDuplicateStatusColumns() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheetInfo = getBookingSheet_();
    const statusColumns = sheetInfo.columns.statuses;
    if (statusColumns.length <= 1) {
      console.log('พบ status เพียงคอลัมน์เดียว ไม่ต้องลบ');
      return 0;
    }

    const lastRow = sheetInfo.sheet.getLastRow();
    if (lastRow > 1) {
      const rows = sheetInfo.sheet.getRange(2, 1, lastRow - 1, sheetInfo.sheet.getLastColumn()).getValues();
      const mergedStatuses = rows.map(function(row) {
        const hasStatus = statusColumns.some(function(columnIndex) {
          return String(row[columnIndex] || '').trim() !== '';
        });
        return [hasStatus ? getRowStatus_(row, statusColumns) : ''];
      });
      sheetInfo.sheet.getRange(2, statusColumns[0] + 1, mergedStatuses.length, 1).setValues(mergedStatuses);
    }

    for (let index = statusColumns.length - 1; index > 0; index--) {
      sheetInfo.sheet.deleteColumn(statusColumns[index] + 1);
    }

    const removedCount = statusColumns.length - 1;
    console.log('ลบคอลัมน์ status ที่ซ้ำแล้ว: ' + removedCount);
    return removedCount;
  } finally {
    lock.releaseLock();
  }
}

function getRowStatus_(row, statusColumns) {
  const statuses = statusColumns.map(function(index) {
    return String(row[index] || '').trim();
  }).filter(Boolean);
  const cancelled = statuses.find(isCancelledStatus_);
  const houseClosed = statuses.find(isHouseClosedStatus_);
  const complete = statuses.find(function(status) { return status.toLowerCase() === 'complete'; });
  const confirmed = statuses.find(function(status) { return status.toLowerCase() === 'confirmed'; });
  const booking = statuses.find(function(status) { return status.toLowerCase() === 'booking'; });
  return cancelled || houseClosed || complete || confirmed || booking || statuses[0] || 'confirmed';
}

function isHouseClosedStatus_(status) {
  const normalized = String(status || '').trim().toLowerCase();
  return normalized === 'close' || normalized === 'close-ปิดบ้าน';
}

function isCancelledStatus_(status) {
  const normalized = String(status || '').trim().toLowerCase();
  return normalized === 'cancel' || normalized === 'cancelled' || normalized === 'canceled';
}

function dateCellToIso_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    const timeZone = getDateTimeZone_();
    return Utilities.formatDate(value, timeZone, 'yyyy-MM-dd');
  }
  const text = String(value || '').trim();
  return isValidIsoDate_(text) ? text : '';
}

function isValidIsoDate_(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3]);
}

function parseBookingPayload_(parameterPayload, rawBody) {
  if (parameterPayload) return JSON.parse(parameterPayload);
  if (rawBody) {
    const parsed = JSON.parse(rawBody);
    if (parsed && parsed.payload) return typeof parsed.payload === 'string' ? JSON.parse(parsed.payload) : parsed.payload;
    return parsed;
  }
  throw new Error('ไม่มีข้อมูลการจอง');
}

function jsonOutput_(payload, callback) {
  const json = JSON.stringify(payload);
  const safeCallback = /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback) ? callback : '';
  if (safeCallback) {
    return ContentService.createTextOutput(safeCallback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}
