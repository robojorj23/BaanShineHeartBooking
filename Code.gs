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
    const booking = parseBookingPayload_(parameters.payload, e && e.postData ? e.postData.contents : '');
    result = reserveBooking_(booking);
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    result = { status: 'error', message: 'ไม่สามารถบันทึกการจองได้ กรุณาลองใหม่อีกครั้ง' };
  }

  const nonce = String(parameters.nonce || '');
  const message = JSON.stringify({
    type: 'bsh-booking-result',
    nonce: nonce,
    result: result
  }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const html = '<!doctype html><html><body><script>window.top.postMessage(' +
    message +
    ', "*");</script></body></html>';

  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
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

function reserveBooking_(booking) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheetInfo = getBookingSheet_();
    const checkIn = String(booking.checkIn || '').trim();
    const checkOut = String(booking.checkOut || '').trim();
    if (!isValidIsoDate_(checkIn) || !isValidIsoDate_(checkOut) || checkOut <= checkIn) {
      return { status: 'error', message: 'กรุณาตรวจสอบวันที่เข้าพัก' };
    }

    const name = String(booking.name || '').trim();
    const phone = String(booking.phone || '').trim();
    if (!name || !phone) {
      return { status: 'error', message: 'กรุณากรอกชื่อและเบอร์โทรศัพท์' };
    }

    const rows = sheetInfo.sheet.getDataRange().getValues();
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      const existingStatus = getRowStatus_(row, sheetInfo.columns.statuses);
      const existingCheckIn = dateCellToIso_(row[sheetInfo.columns.checkIn]);
      const existingCheckOut = dateCellToIso_(row[sheetInfo.columns.checkOut]);
      const existingName = String(row[sheetInfo.columns.name] || '').trim();
      const existingPhone = String(row[sheetInfo.columns.phone] || '').trim();
      if (!isCancelledStatus_(existingStatus) &&
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
    const bookingId = getNextBookingId_(rows, sheetInfo.columns.id, currentYear);
    const record = {
      id: bookingId,
      name: name,
      phone: phone,
      checkIn: checkIn,
      checkOut: checkOut,
      nights: Math.round((Date.parse(checkOut + 'T00:00:00Z') - Date.parse(checkIn + 'T00:00:00Z')) / 86400000),
      guests: String(booking.guests || ''),
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
        createdat: 'createdAt'
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

function getNextBookingId_(rows, idColumn, year) {
  const prefix = getYearPrefix_(year);
  const pattern = new RegExp('^' + prefix + '-(\\d+)$');
  let highestNumber = 0;

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const match = pattern.exec(String(rows[rowIndex][idColumn] || '').trim());
    if (match) highestNumber = Math.max(highestNumber, Number(match[1]));
  }

  return prefix + '-' + String(highestNumber + 1).padStart(3, '0');
}

function getYearPrefix_(year) {
  let sequence = year - 2024;
  if (sequence < 1) throw new Error('ไม่สามารถสร้างรหัสจองสำหรับปีก่อน พ.ศ. 2568 ได้');

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
        people: peopleColumn >= 0 ? peopleColumn : guestsColumn,
        comment: commentColumn >= 0 ? commentColumn : notesColumn,
        statuses: normalized.reduce(function(indices, header, index) {
          if (header === 'status') indices.push(index);
          return indices;
        }, [])
      }
    };
  }

  throw new Error('ไม่พบแท็บที่มีหัวคอลัมน์การจองครบถ้วน');
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
  const confirmed = statuses.find(function(status) { return status.toLowerCase() === 'confirmed'; });
  const booking = statuses.find(function(status) { return status.toLowerCase() === 'booking'; });
  return cancelled || confirmed || booking || statuses[0] || 'confirmed';
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
