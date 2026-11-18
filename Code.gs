const ADMIN_PASSWORD_HASH_ITERATIONS = 4000;
const ADMIN_SESSION_DURATION_SECONDS = 30 * 24 * 60 * 60;

function doGet(e) {
  const callback = e && e.parameter ? e.parameter.callback : '';
  try {
    const data = getAvailability_();
    return jsonOutput_({ status: 'success', data: data }, callback);
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

    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) throw new Error('สคริปต์ต้องผูกกับ Google Spreadsheet');
    let sheet = spreadsheet.getSheetByName('user');
    if (!sheet) sheet = spreadsheet.insertSheet('user');

    const headers = ['username', 'passwordHash', 'salt', 'role', 'active', 'createdAt', 'updatedAt', 'sessionVersion'];
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    } else {
      const currentHeaders = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0]
        .map(function(value) { return String(value || '').trim().toLowerCase(); });
      if (!headers.every(function(header, index) { return currentHeaders[index] === header.toLowerCase(); })) {
        throw new Error('ชีต user มีหัวคอลัมน์ไม่ตรง กรุณาสำรองข้อมูลและตรวจสอบก่อน');
      }
    }

    const rows = sheet.getDataRange().getValues();
    if (rows.slice(1).some(function(row) { return String(row[0] || '').trim().toLowerCase() === 'robojorj'; })) {
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
    sheet.appendRow([
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
    SpreadsheetApp.flush();
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
    SpreadsheetApp.flush();
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
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('สคริปต์ต้องผูกกับ Google Spreadsheet');
  const sheet = spreadsheet.getSheetByName('user');
  if (!sheet) throw new Error('ไม่พบชีต user กรุณาเรียก setupInitialAdmin ใน Apps Script');

  const headers = ['username', 'passwordhash', 'salt', 'role', 'active', 'createdat', 'updatedat', 'sessionversion'];
  const actualHeaders = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0]
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
      sessionVersion: 7
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
    SpreadsheetApp.flush();
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
    SpreadsheetApp.flush();
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
    SpreadsheetApp.flush();
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
  }).filter(Boolean).reverse();
}

function updateAdminBooking_(booking) {
  const lock = LockService.getScriptLock();
  let updatedBooking;
  let shouldSendConfirmation = false;
  lock.waitLock(30000);
  try {
    if (!booking || typeof booking !== 'object') {
      return { status: 'error', message: 'ข้อมูลการจองไม่ถูกต้อง' };
    }

    const bookingId = String(booking.id || '').trim();
    const name = String(booking.name || '').trim();
    const phone = String(booking.phone || '').trim();
    const email = String(booking.email || '').trim();
    const checkIn = String(booking.checkIn || '').trim();
    const checkOut = String(booking.checkOut || '').trim();
    const people = String(booking.people || '').trim();
    const comment = String(booking.comment || '');
    const status = String(booking.status || '').trim().toLowerCase();
    const totalPrice = Number(booking.totalPrice);

    if (!bookingId || !name || name.length > 200 || !phone || phone.length > 50 ||
        people.length > 100 || !isValidIsoDate_(checkIn) ||
        !isValidIsoDate_(checkOut) || checkOut <= checkIn) {
      return { status: 'error', message: 'กรุณาตรวจสอบรหัส ชื่อ เบอร์โทร และช่วงวันที่' };
    }
    if (['booking', 'confirmed', 'complete', 'cancel'].indexOf(status) < 0) {
      return { status: 'error', message: 'สถานะต้องเป็น booking, confirmed, complete หรือ cancel' };
    }
    if (!Number.isFinite(totalPrice) || totalPrice < 0 || comment.length > 5000) {
      return { status: 'error', message: 'กรุณาตรวจสอบยอดเงินหรือข้อความเพิ่มเติม' };
    }
    if (email && !isValidEmail_(email)) {
      return { status: 'error', message: 'รูปแบบอีเมลไม่ถูกต้อง' };
    }
    if (status === 'confirmed' && !isValidEmail_(email)) {
      return { status: 'error', message: 'กรุณากรอกอีเมลที่ถูกต้องก่อนยืนยันการจอง' };
    }

    const sheetInfo = ensureBookingMetadataColumns_(getBookingSheet_());
    const rows = sheetInfo.sheet.getDataRange().getValues();
    let targetRowIndex = -1;
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
      if (String(rows[rowIndex][sheetInfo.columns.id] || '').trim() === bookingId) {
        targetRowIndex = rowIndex;
        break;
      }
    }
    if (targetRowIndex < 0) return { status: 'error', message: 'ไม่พบรายการจองนี้ อาจถูกลบไปแล้ว' };
    shouldSendConfirmation = status === 'confirmed' &&
      getRowStatus_(rows[targetRowIndex], sheetInfo.columns.statuses).toLowerCase() !== 'confirmed';

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
    updatedRow[sheetInfo.columns.totalPrice] = totalPrice;
    updatedRow[sheetInfo.columns.email] = email;
    sheetInfo.columns.statuses.forEach(function(columnIndex) {
      updatedRow[columnIndex] = status;
    });

    sheetInfo.sheet.getRange(targetRowIndex + 1, 1, 1, updatedRow.length).setValues([updatedRow]);
    SpreadsheetApp.flush();
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
    '\n\nติดต่อเจ้าของบ้าน: พี่จอร์จ 080-565-0481';
  const htmlBody = '<div style="font-family:Arial,sans-serif;color:#1e293b;line-height:1.6">' +
    '<p>เรียน คุณ' + escapeHtml(booking.name) + '</p>' +
    '<p>ยืนยันการจองบ้านชายหาดเรียบร้อยแล้ว รายละเอียดการจอง:</p>' +
    '<table style="border-collapse:collapse;width:100%;max-width:640px">' + htmlRows + '</table>' +
    '<p>ติดต่อเจ้าของบ้าน: พี่จอร์จ 080-565-0481</p></div>';

  MailApp.sendEmail({
    to: booking.email,
    subject: subject,
    body: body,
    htmlBody: htmlBody,
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
    status: getRowStatus_(row, sheetInfo.columns.statuses),
    comment: String(row[sheetInfo.columns.comment] || ''),
    totalPrice: Number(row[sheetInfo.columns.totalPrice]) || 0,
    createdAt: dateTimeCellToString_(row[sheetInfo.columns.createdAt])
  };
}

function dateTimeCellToString_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    const timeZone = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    return Utilities.formatDate(value, timeZone, 'yyyy-MM-dd HH:mm:ss');
  }
  return String(value || '');
}

function getAvailability_() {
  const sheetInfo = getBookingSheet_();
  const values = sheetInfo.sheet.getDataRange().getValues();
  const records = [];

  for (let rowIndex = 1; rowIndex < values.length; rowIndex++) {
    const row = values[rowIndex];
    const checkIn = dateCellToIso_(row[sheetInfo.columns.checkIn]);
    const checkOut = dateCellToIso_(row[sheetInfo.columns.checkOut]);
    if (!checkIn || !checkOut || checkOut <= checkIn) continue;

    records.push({
      checkIn: checkIn,
      checkOut: checkOut,
      status: getRowStatus_(row, sheetInfo.columns.statuses)
    });
  }

  return records;
}

function createAdminBooking_(booking, session) {
  return reserveBooking_(booking, session.username, true);
}

function reserveBooking_(booking, bookBy, skipDuplicateRequest) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (!booking || typeof booking !== 'object') {
      return { status: 'error', message: 'ข้อมูลการจองไม่ถูกต้อง' };
    }

    const checkIn = String(booking.checkIn || '').trim();
    const checkOut = String(booking.checkOut || '').trim();
    if (!isValidIsoDate_(checkIn) || !isValidIsoDate_(checkOut) || checkOut <= checkIn) {
      return { status: 'error', message: 'กรุณาตรวจสอบวันที่เข้าพัก' };
    }

    const name = String(booking.name || '').trim();
    const phone = String(booking.phone || '').trim();
    const email = String(booking.email || '').trim();
    if (!name || !phone || !email) {
      return { status: 'error', message: 'กรุณากรอกชื่อ เบอร์โทรศัพท์ และอีเมล' };
    }
    if (name.length > 200 || phone.length > 50 || !isValidEmail_(email)) {
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

    const timeZone = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    const currentYear = Number(Utilities.formatDate(new Date(), timeZone, 'yyyy'));
    const bookingId = getNextBookingId_(
      rows,
      sheetInfo.columns.id,
      sheetInfo.columns.createdAt,
      currentYear
    );
    const record = {
      id: bookingId,
      name: name,
      phone: phone,
      checkIn: checkIn,
      checkOut: checkOut,
      nights: Math.round((Date.parse(checkOut + 'T00:00:00Z') - Date.parse(checkIn + 'T00:00:00Z')) / 86400000),
      guests: String(booking.guests || ''),
      email: email,
      bookBy: String(bookBy || 'website'),
      status: 'booking',
      comment: String(booking.notes || booking.comment || ''),
      totalPrice: Number(booking.totalPrice) || 0,
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
        bookby: 'bookBy'
      }[normalizedHeader] || normalizedHeader;
      return Object.prototype.hasOwnProperty.call(record, recordKey) ? record[recordKey] : '';
    });
    // The existing sheet has two status columns; keep both in sync.
    sheetInfo.columns.statuses.forEach(function(columnIndex) {
      newRow[columnIndex] = record.status;
    });

    sheetInfo.sheet.getRange(sheetInfo.sheet.getLastRow() + 1, 1, 1, newRow.length).setValues([newRow]);
    SpreadsheetApp.flush();
    return {
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
        statuses: normalized.reduce(function(indices, header, index) {
          if (header === 'status') indices.push(index);
          return indices;
        }, [])
      }
    };
  }

  throw new Error('ไม่พบแท็บที่มีหัวคอลัมน์การจองครบถ้วน');
}

function ensureBookingMetadataColumns_(sheetInfo) {
  const missingHeaders = [];
  if (sheetInfo.columns.email < 0) missingHeaders.push('email');
  if (sheetInfo.columns.bookBy < 0) missingHeaders.push('bookBy');
  if (!missingHeaders.length) return sheetInfo;

  const firstNewColumn = sheetInfo.sheet.getLastColumn() + 1;
  sheetInfo.sheet.getRange(1, firstNewColumn, 1, missingHeaders.length).setValues([missingHeaders]);
  missingHeaders.forEach(function(header, index) {
    const columnIndex = firstNewColumn - 1 + index;
    sheetInfo.headers.push(header);
    sheetInfo.columns[header === 'email' ? 'email' : 'bookBy'] = columnIndex;
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
  const complete = statuses.find(function(status) { return status.toLowerCase() === 'complete'; });
  const confirmed = statuses.find(function(status) { return status.toLowerCase() === 'confirmed'; });
  const booking = statuses.find(function(status) { return status.toLowerCase() === 'booking'; });
  return cancelled || complete || confirmed || booking || statuses[0] || 'confirmed';
}

function isCancelledStatus_(status) {
  const normalized = String(status || '').trim().toLowerCase();
  return normalized === 'cancel' || normalized === 'cancelled' || normalized === 'canceled';
}

function dateCellToIso_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    const timeZone = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
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
