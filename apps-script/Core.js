/**
 * Readathon core logic.
 *
 * Plain JavaScript shared by the Apps Script web app (Code.js) and the local
 * dev server (dev/server.js). All storage goes through a `store` object and
 * all environment-specific behavior (clock, randomness, secrets) through an
 * `env` object, so this file never touches SpreadsheetApp directly.
 *
 * store: readTable(name) -> {headers, rows}, appendRows(name, rows),
 *        updateRow(name, index, values), deleteRows(name, indexes),
 *        replaceRows(name, rows), readRoster() -> {headers, rows},
 *        withLock(fn), cacheGet(key), cachePut(key, value, seconds), cacheRemove(key),
 *        adminEmails() -> emails of the data spreadsheet's owner and editors
 * env:   today() -> 'yyyy-MM-dd', now() -> ISO string, randomBytes(n) -> int[],
 *        googleClientId, verifyGoogleIdToken(idToken) -> Google's token claims or null,
 *        log(message)
 */

var SCHEMA = {
  Settings: ['key', 'value'],
  Students: ['studentId', 'studentName', 'grade', 'teacher', 'token', 'code', 'goalMinutes',
    'showReadingList', 'showTotalMinutes', 'showClassMinutes', 'createdAt', 'updatedAt'],
  Minutes: ['studentId', 'date', 'minutes', 'updatedAt'],
  Books: ['bookId', 'studentId', 'title', 'author', 'status', 'coverId', 'isbn', 'addedAt', 'finishedAt'],
};

var DEFAULT_WIDGET_HTML = [
  '<div class="widget-default">',
  '  <p>Every gift supports the {schoolName} PTO. Thank you for cheering on {studentFirstName}!</p>',
  '  <a class="btn btn-primary" target="_blank" rel="noopener"',
  '     href="https://example.org/donate?note={studentName:url}%20({studentTeacher:url})">',
  '    Donate in honor of {studentFirstName}',
  '  </a>',
  '</div>',
].join('\n');

var DEFAULT_SETTINGS = {
  readathonTitle: 'Bishop Readathon',
  schoolName: 'Bishop School',
  startDate: '',
  endDate: '',
  schoolGoalMinutes: 0,
  maxMinutesPerDay: 600,
  editsLocked: false,
  nameFormat: 'firstLastInitial',
  siteUrl: 'https://readathon.bishopschoolpto.com',
  homeShowClassTotals: true,
  defaultShowReadingList: true,
  defaultShowTotalMinutes: true,
  defaultShowClassMinutes: true,
  donationWidgetHtml: DEFAULT_WIDGET_HTML,
};

var SETTING_TYPES = {
  schoolGoalMinutes: 'number',
  maxMinutesPerDay: 'number',
  editsLocked: 'bool',
  homeShowClassTotals: 'bool',
  defaultShowReadingList: 'bool',
  defaultShowTotalMinutes: 'bool',
  defaultShowClassMinutes: 'bool',
  startDate: 'date',
  endDate: 'date',
};

var NAME_FORMATS = ['first', 'firstLastInitial', 'full'];
var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
var TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
var MAX_WIDGET_LENGTH = 45000; // Google Sheets cells hold at most 50,000 characters.
var MAX_BOOKS_PER_STUDENT = 300;
var AGG_CACHE_KEY = 'agg:v1';
var ROSTER_CACHE_KEY = 'roster:v1';
var GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status || 400;
  }
}

/** Entry point: dispatches one API request and returns {ok, data} or {ok:false, error}. */
function handleApi(store, env, req) {
  try {
    req = req || {};
    var action = ACTIONS[req.action];
    if (!action) throw new ApiError('Unknown action.');
    var ctx = { store: store, env: env, req: req, memo: {} };
    return { ok: true, data: action(ctx, req) };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message, status: err.status };
    if (env && env.log) env.log((err && err.stack) || String(err));
    return { ok: false, error: 'Something went wrong. Please try again.', status: 500 };
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function str(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function toBool(v, dflt) {
  if (v === true || v === false) return v;
  var s = str(v).toLowerCase();
  if (s === '') return dflt;
  return s === 'true' || s === 'yes' || s === '1' || s === 'y';
}

function toInt(v, dflt) {
  var n = Number(v);
  return isFinite(n) && str(v) !== '' ? Math.round(n) : dflt;
}

function isDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(dateStr, n) {
  var d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Inclusive list of dates from start to end ('yyyy-MM-dd'), capped for safety. */
function dateRange(start, end) {
  var out = [];
  for (var d = start; d <= end && out.length < 366; d = addDays(d, 1)) out.push(d);
  return out;
}

function randomString(env, length, alphabet) {
  var bytes = env.randomBytes(length);
  var out = '';
  for (var i = 0; i < length; i++) out += alphabet.charAt(bytes[i] % alphabet.length);
  return out;
}

function normHeader(h) {
  return str(h).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function compareGrades(a, b) {
  var rank = function (g) {
    var s = str(g).toUpperCase();
    if (s === 'PK' || s === 'PRE-K' || s === 'PREK') return -2;
    if (s === 'TK') return -1;
    if (s === 'K' || s === 'KINDER' || s === 'KINDERGARTEN') return 0;
    var n = parseInt(s.replace(/[^0-9]/g, ''), 10);
    return isNaN(n) ? 100 : n;
  };
  return rank(a) - rank(b) || str(a).localeCompare(str(b));
}

// ---------------------------------------------------------------------------
// Template rendering for the donation widget
// ---------------------------------------------------------------------------

var TEMPLATE_VARS = ['studentName', 'studentFirstName', 'studentLastInitial', 'studentGrade',
  'studentTeacher', 'studentCode', 'totalMinutes', 'goalMinutes', 'classMinutes', 'donationUrl',
  'schoolName', 'readathonTitle'];

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Replaces {var} (HTML-escaped), {var:url} (URL-encoded) and {var:json}
 * (a JSON string literal, safe inside <script>) for known variables only.
 * Unknown {placeholders} are left untouched so inline CSS/JS survives.
 */
function renderTemplate(html, vars) {
  return String(html || '').replace(/\{(\w+)(?::(\w+))?\}/g, function (match, name, mod) {
    if (TEMPLATE_VARS.indexOf(name) < 0 || !Object.prototype.hasOwnProperty.call(vars, name)) return match;
    var value = vars[name] === null || vars[name] === undefined ? '' : String(vars[name]);
    if (!mod || mod === 'html') return escapeHtml(value);
    if (mod === 'url') return encodeURIComponent(value);
    if (mod === 'json') return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
    return match;
  });
}

function templateVars(settings, student, totals) {
  return {
    studentName: displayName(student, settings.nameFormat),
    studentFirstName: student.firstName,
    studentLastInitial: student.lastName ? student.lastName.charAt(0) + '.' : '',
    studentGrade: student.grade,
    studentTeacher: student.teacher,
    studentCode: student.code,
    totalMinutes: totals.totalMinutes,
    goalMinutes: totals.goalMinutes || '',
    classMinutes: totals.classMinutes,
    donationUrl: str(settings.siteUrl).replace(/\/+$/, '') + '/d/' + student.code,
    schoolName: settings.schoolName,
    readathonTitle: settings.readathonTitle,
  };
}

function displayName(student, format) {
  if (format === 'first') return student.firstName;
  if (format === 'full') return (student.firstName + ' ' + student.lastName).trim();
  return (student.firstName + (student.lastName ? ' ' + student.lastName.charAt(0) + '.' : '')).trim();
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

/** Reads a data tab into records keyed by header, each with _i (data row index) and _raw. */
function loadTable(ctx, name) {
  var key = 'table:' + name;
  if (ctx.memo[key]) return ctx.memo[key];
  var t = ctx.store.readTable(name);
  var headers = (t.headers || []).map(str);
  SCHEMA[name].forEach(function (h) {
    if (headers.indexOf(h) < 0) {
      throw new ApiError('The "' + name + '" tab is missing the "' + h + '" column. Run setup() in Apps Script.', 500);
    }
  });
  var records = (t.rows || []).map(function (row, i) {
    var rec = { _i: i, _raw: row };
    headers.forEach(function (h, j) { rec[h] = row[j]; });
    return rec;
  });
  ctx.memo[key] = { name: name, headers: headers, records: records };
  return ctx.memo[key];
}

/** Builds a row in the tab's actual column order, preserving columns the app doesn't know about. */
function toRow(table, rec) {
  return table.headers.map(function (h, j) {
    if (Object.prototype.hasOwnProperty.call(rec, h)) return rec[h] === undefined ? '' : rec[h];
    return rec._raw ? rec._raw[j] : '';
  });
}

function saveRecord(ctx, table, rec) {
  ctx.store.updateRow(table.name, rec._i, toRow(table, rec));
}

function appendRecord(ctx, table, rec) {
  ctx.store.appendRows(table.name, [toRow(table, rec)]);
  rec._i = table.records.length;
  table.records.push(rec);
}

function getSettings(ctx) {
  if (ctx.memo.settings) return ctx.memo.settings;
  var t = loadTable(ctx, 'Settings');
  var raw = {};
  t.records.forEach(function (r) { if (str(r.key)) raw[str(r.key)] = r.value; });
  var s = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    s[k] = coerceSetting(k, Object.prototype.hasOwnProperty.call(raw, k) ? raw[k] : DEFAULT_SETTINGS[k]);
  });
  ctx.memo.settings = s;
  return s;
}

function coerceSetting(key, value) {
  var type = SETTING_TYPES[key];
  if (type === 'bool') return toBool(value, DEFAULT_SETTINGS[key]);
  if (type === 'number') return Math.max(0, toInt(value, DEFAULT_SETTINGS[key]));
  if (type === 'date') return isDateStr(str(value)) ? str(value) : '';
  if (key === 'nameFormat') return NAME_FORMATS.indexOf(str(value)) >= 0 ? str(value) : DEFAULT_SETTINGS.nameFormat;
  if (key === 'donationWidgetHtml') return value === null || value === undefined ? '' : String(value);
  return str(value);
}

function publicSettings(s) {
  return {
    readathonTitle: s.readathonTitle,
    schoolName: s.schoolName,
    startDate: s.startDate,
    endDate: s.endDate,
    schoolGoalMinutes: s.schoolGoalMinutes,
    maxMinutesPerDay: s.maxMinutesPerDay,
    editsLocked: s.editsLocked,
  };
}

/** Parses the school roster, tolerating common header spellings. */
function parseRoster(raw) {
  var norm = (raw.headers || []).map(normHeader);
  var find = function (cands) {
    for (var i = 0; i < cands.length; i++) {
      var j = norm.indexOf(cands[i]);
      if (j >= 0) return j;
    }
    return -1;
  };
  var iId = find(['studentid', 'id', 'studentnumber', 'studentno', 'sid']);
  var iFirst = find(['firstname', 'first', 'studentfirstname', 'givenname', 'preferredname']);
  var iLast = find(['lastname', 'last', 'studentlastname', 'surname', 'familyname']);
  var iName = find(['studentname', 'name', 'fullname']);
  var iGrade = find(['grade', 'gradelevel', 'gr']);
  var iTeacher = find(['teacher', 'teachername', 'homeroomteacher', 'homeroom', 'classroom', 'class']);
  if (iId < 0) throw new ApiError('The roster needs a "Student ID" column (any unique value per student).', 500);
  if (iFirst < 0 && iName < 0) throw new ApiError('The roster needs "First Name"/"Last Name" or "Student Name" columns.', 500);

  var list = [];
  var byId = {};
  (raw.rows || []).forEach(function (r) {
    var id = str(r[iId]);
    if (!id || byId[id]) return;
    var first = iFirst >= 0 ? str(r[iFirst]) : '';
    var last = iLast >= 0 ? str(r[iLast]) : '';
    if (!first && iName >= 0) {
      var full = str(r[iName]);
      if (full.indexOf(',') >= 0) {
        last = str(full.split(',')[0]);
        first = str(full.split(',').slice(1).join(','));
      } else {
        var parts = full.split(/\s+/);
        first = parts.shift() || '';
        last = parts.join(' ');
      }
    }
    if (!first && !last) return;
    var s = {
      studentId: id,
      firstName: first,
      lastName: last,
      grade: iGrade >= 0 ? str(r[iGrade]) : '',
      teacher: iTeacher >= 0 ? str(r[iTeacher]) : '',
    };
    byId[id] = s;
    list.push(s);
  });
  return { list: list, byId: byId };
}

function getRoster(ctx, fresh) {
  if (ctx.memo.roster && !fresh) return ctx.memo.roster;
  var raw = fresh ? null : cacheGet(ctx, ROSTER_CACHE_KEY);
  if (!raw) {
    raw = ctx.store.readRoster();
    cachePut(ctx, ROSTER_CACHE_KEY, raw, 300);
  }
  ctx.memo.roster = parseRoster(raw);
  return ctx.memo.roster;
}

function cacheGet(ctx, key) {
  try { return ctx.store.cacheGet ? ctx.store.cacheGet(key) : null; } catch (e) { return null; }
}

function cachePut(ctx, key, value, seconds) {
  try { if (ctx.store.cachePut) ctx.store.cachePut(key, value, seconds); } catch (e) { /* too big to cache */ }
}

function cacheRemove(ctx, key) {
  try { if (ctx.store.cacheRemove) ctx.store.cacheRemove(key); } catch (e) { /* ignore */ }
}

function classKey(student) {
  return student.teacher ? 't:' + student.teacher : 'g:' + student.grade;
}

/** Minutes totals per student and per class, counting only days inside the readathon. */
function getAggregates(ctx, useCache) {
  if (ctx.memo.agg) return ctx.memo.agg;
  var cached = useCache ? cacheGet(ctx, AGG_CACHE_KEY) : null;
  if (cached) return (ctx.memo.agg = cached);
  var settings = getSettings(ctx);
  var roster = getRoster(ctx);
  var byStudent = {};
  loadTable(ctx, 'Minutes').records.forEach(function (r) {
    var id = str(r.studentId);
    var date = str(r.date);
    var m = toInt(r.minutes, 0);
    if (!id || m <= 0 || !roster.byId[id]) return;
    if (settings.startDate && date < settings.startDate) return;
    if (settings.endDate && date > settings.endDate) return;
    var e = byStudent[id] || (byStudent[id] = { minutes: 0, days: 0 });
    e.minutes += m;
    e.days += 1;
  });
  var byClass = {};
  roster.list.forEach(function (s) {
    var k = classKey(s);
    var c = byClass[k] || (byClass[k] = { teacher: s.teacher, grade: s.grade, minutes: 0, students: 0, readers: 0 });
    var e = byStudent[s.studentId];
    c.students += 1;
    if (e) { c.minutes += e.minutes; c.readers += 1; }
  });
  ctx.memo.agg = { byStudent: byStudent, byClass: byClass };
  cachePut(ctx, AGG_CACHE_KEY, ctx.memo.agg, 60);
  return ctx.memo.agg;
}

function findStudentRecord(ctx, field, value) {
  var v = str(value);
  if (!v) return null;
  if (field === 'code') v = v.toUpperCase();
  var recs = loadTable(ctx, 'Students').records;
  for (var i = 0; i < recs.length; i++) {
    var rv = str(recs[i][field]);
    if (field === 'code') rv = rv.toUpperCase();
    if (rv === v) return recs[i];
  }
  return null;
}

/** Resolves a private student token to the roster entry + Students record. */
function requireStudent(ctx, token) {
  var rec = /^[A-Za-z0-9]{12,64}$/.test(str(token)) ? findStudentRecord(ctx, 'token', token) : null;
  var info = rec ? getRoster(ctx).byId[str(rec.studentId)] : null;
  if (!info) throw new ApiError('We could not find this reading log. Please check your link.', 404);
  return { rec: rec, info: withCode(info, rec) };
}

function withCode(info, rec) {
  var out = {};
  Object.keys(info).forEach(function (k) { out[k] = info[k]; });
  out.code = str(rec.code);
  return out;
}

function prefsOf(rec, settings) {
  return {
    showReadingList: toBool(rec.showReadingList, settings.defaultShowReadingList),
    showTotalMinutes: toBool(rec.showTotalMinutes, settings.defaultShowTotalMinutes),
    showClassMinutes: toBool(rec.showClassMinutes, settings.defaultShowClassMinutes),
    goalMinutes: Math.max(0, toInt(rec.goalMinutes, 0)),
  };
}

function booksFor(ctx, studentId) {
  return loadTable(ctx, 'Books').records
    .filter(function (b) { return str(b.studentId) === studentId; })
    .map(publicBook);
}

function publicBook(b) {
  return {
    bookId: str(b.bookId),
    title: str(b.title),
    author: str(b.author),
    status: str(b.status) === 'reading' ? 'reading' : 'finished',
    coverId: str(b.coverId),
    isbn: str(b.isbn),
    addedAt: str(b.addedAt),
    finishedAt: str(b.finishedAt),
  };
}

/** The days a student may log: readathon start through min(end, today). */
function loggableDays(settings, today) {
  var start = settings.startDate || today;
  var end = settings.endDate && settings.endDate < today ? settings.endDate : today;
  return start > end ? [] : dateRange(start, end);
}

function invalidateAggregates(ctx) {
  ctx.memo.agg = null;
  cacheRemove(ctx, AGG_CACHE_KEY);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

var ACTIONS = {
  home: function (ctx) {
    var s = getSettings(ctx);
    var roster = getRoster(ctx);
    var agg = getAggregates(ctx, true);
    var total = 0;
    var readers = 0;
    var grades = {};
    roster.list.forEach(function (st) {
      var e = agg.byStudent[st.studentId];
      var g = grades[st.grade] || (grades[st.grade] = { grade: st.grade, minutes: 0, students: 0, readers: 0 });
      g.students += 1;
      if (e) { total += e.minutes; readers += 1; g.minutes += e.minutes; g.readers += 1; }
    });
    var classes = s.homeShowClassTotals ? Object.keys(agg.byClass).map(function (k) { return agg.byClass[k]; })
      .sort(function (a, b) { return b.minutes - a.minutes || compareGrades(a.grade, b.grade); }) : null;
    return {
      settings: publicSettings(s),
      today: ctx.env.today(),
      totalMinutes: total,
      readers: readers,
      studentCount: roster.list.length,
      grades: Object.keys(grades).map(function (k) { return grades[k]; })
        .sort(function (a, b) { return compareGrades(a.grade, b.grade); }),
      classes: classes,
    };
  },

  'student.get': function (ctx, req) {
    var st = requireStudent(ctx, req.token);
    var s = getSettings(ctx);
    var today = ctx.env.today();
    var id = st.info.studentId;
    var logged = {};
    loadTable(ctx, 'Minutes').records.forEach(function (r) {
      if (str(r.studentId) === id) logged[str(r.date)] = toInt(r.minutes, 0);
    });
    var days = loggableDays(s, today).map(function (d) { return { date: d, minutes: logged[d] || 0 }; });
    var agg = getAggregates(ctx, false);
    var cls = agg.byClass[classKey(st.info)] || { minutes: 0, students: 0 };
    var mine = agg.byStudent[id] || { minutes: 0, days: 0 };
    return {
      student: {
        firstName: st.info.firstName,
        lastName: st.info.lastName,
        grade: st.info.grade,
        teacher: st.info.teacher,
        code: st.info.code,
      },
      settings: publicSettings(s),
      today: today,
      days: days,
      totalMinutes: mine.minutes,
      daysRead: mine.days,
      classMinutes: cls.minutes,
      classSize: cls.students,
      prefs: prefsOf(st.rec, s),
      books: booksFor(ctx, id),
    };
  },

  'student.setMinutes': function (ctx, req) {
    return ctx.store.withLock(function () {
      var st = requireStudent(ctx, req.token);
      var s = getSettings(ctx);
      if (s.editsLocked) throw new ApiError('The reading log is locked. Ask your teacher if something needs fixing.', 403);
      var date = str(req.date);
      if (loggableDays(s, ctx.env.today()).indexOf(date) < 0) {
        throw new ApiError('You can only log minutes for readathon days up to today.');
      }
      var minutes = Number(req.minutes);
      if (!isFinite(minutes) || minutes < 0 || Math.round(minutes) !== minutes) {
        throw new ApiError('Minutes must be a whole number.');
      }
      if (minutes > s.maxMinutesPerDay) {
        throw new ApiError('That is more than ' + s.maxMinutesPerDay + ' minutes in one day. Please double-check.');
      }
      var table = loadTable(ctx, 'Minutes');
      var id = st.info.studentId;
      var existing = null;
      for (var i = 0; i < table.records.length; i++) {
        var r = table.records[i];
        if (str(r.studentId) === id && str(r.date) === date) { existing = r; break; }
      }
      var now = ctx.env.now();
      if (existing) {
        existing.minutes = minutes;
        existing.updatedAt = now;
        saveRecord(ctx, table, existing);
      } else if (minutes > 0) {
        appendRecord(ctx, table, { studentId: id, date: date, minutes: minutes, updatedAt: now });
      }
      invalidateAggregates(ctx);
      var agg = getAggregates(ctx, false);
      var mine = agg.byStudent[id] || { minutes: 0, days: 0 };
      var cls = agg.byClass[classKey(st.info)] || { minutes: 0 };
      return { date: date, minutes: minutes, totalMinutes: mine.minutes, daysRead: mine.days, classMinutes: cls.minutes };
    });
  },

  'student.setPrefs': function (ctx, req) {
    return ctx.store.withLock(function () {
      var st = requireStudent(ctx, req.token);
      var s = getSettings(ctx);
      var rec = st.rec;
      var current = prefsOf(rec, s);
      ['showReadingList', 'showTotalMinutes', 'showClassMinutes'].forEach(function (k) {
        if (req[k] !== undefined) rec[k] = toBool(req[k], current[k]);
      });
      if (req.goalMinutes !== undefined) {
        var goal = toInt(req.goalMinutes, -1);
        if (goal < 0 || goal > 100000) throw new ApiError('Goal must be between 0 and 100,000 minutes.');
        rec.goalMinutes = goal;
      }
      rec.updatedAt = ctx.env.now();
      saveRecord(ctx, loadTable(ctx, 'Students'), rec);
      return { prefs: prefsOf(rec, s) };
    });
  },

  'student.addBook': function (ctx, req) {
    return ctx.store.withLock(function () {
      var st = requireStudent(ctx, req.token);
      var book = validateBook(req);
      var table = loadTable(ctx, 'Books');
      var id = st.info.studentId;
      var mine = table.records.filter(function (b) { return str(b.studentId) === id; });
      if (mine.length >= MAX_BOOKS_PER_STUDENT) throw new ApiError('That is a lot of books! The list is full.');
      if (book.status === 'reading') {
        // A student has one "currently reading" book; starting a new one replaces it.
        var stale = mine.filter(function (b) { return str(b.status) === 'reading'; }).map(function (b) { return b._i; });
        if (stale.length) {
          ctx.store.deleteRows('Books', stale);
          delete ctx.memo['table:Books'];
          table = loadTable(ctx, 'Books');
        }
      }
      var now = ctx.env.now();
      var rec = {
        bookId: randomString(ctx.env, 10, TOKEN_ALPHABET),
        studentId: id,
        title: book.title,
        author: book.author,
        status: book.status,
        coverId: book.coverId,
        isbn: book.isbn,
        addedAt: now,
        finishedAt: book.status === 'finished' ? now : '',
      };
      appendRecord(ctx, table, rec);
      return { book: publicBook(rec), books: booksFor(ctx, id) };
    });
  },

  'student.updateBook': function (ctx, req) {
    return ctx.store.withLock(function () {
      var st = requireStudent(ctx, req.token);
      var table = loadTable(ctx, 'Books');
      var rec = findBook(table, st.info.studentId, req.bookId);
      if (req.status === 'finished' && str(rec.status) !== 'finished') {
        rec.status = 'finished';
        rec.finishedAt = ctx.env.now();
      } else if (req.status === 'reading') {
        rec.status = 'reading';
        rec.finishedAt = '';
      }
      saveRecord(ctx, table, rec);
      return { books: booksFor(ctx, st.info.studentId) };
    });
  },

  'student.deleteBook': function (ctx, req) {
    return ctx.store.withLock(function () {
      var st = requireStudent(ctx, req.token);
      var table = loadTable(ctx, 'Books');
      var rec = findBook(table, st.info.studentId, req.bookId);
      ctx.store.deleteRows('Books', [rec._i]);
      delete ctx.memo['table:Books'];
      return { books: booksFor(ctx, st.info.studentId) };
    });
  },

  'donation.get': function (ctx, req) {
    var code = str(req.code).toUpperCase();
    var rec = /^[A-Z0-9]{4,12}$/.test(code) ? findStudentRecord(ctx, 'code', code) : null;
    var info = rec ? getRoster(ctx).byId[str(rec.studentId)] : null;
    if (!info) throw new ApiError('We could not find that reader. Please check the link.', 404);
    var student = withCode(info, rec);
    var s = getSettings(ctx);
    var prefs = prefsOf(rec, s);
    var agg = getAggregates(ctx, true);
    var mine = agg.byStudent[info.studentId] || { minutes: 0, days: 0 };
    var cls = agg.byClass[classKey(info)] || { minutes: 0, students: 0 };
    var out = {
      settings: publicSettings(s),
      student: {
        name: displayName(student, s.nameFormat),
        firstName: student.firstName,
        grade: student.grade,
        teacher: student.teacher,
        code: student.code,
      },
      prefs: {
        showReadingList: prefs.showReadingList,
        showTotalMinutes: prefs.showTotalMinutes,
        showClassMinutes: prefs.showClassMinutes,
      },
      widgetHtml: renderTemplate(s.donationWidgetHtml, templateVars(s, student, {
        totalMinutes: mine.minutes, goalMinutes: prefs.goalMinutes, classMinutes: cls.minutes,
      })),
    };
    if (prefs.showTotalMinutes) {
      out.totalMinutes = mine.minutes;
      out.daysRead = mine.days;
      out.goalMinutes = prefs.goalMinutes;
    }
    if (prefs.showClassMinutes) {
      out.classMinutes = cls.minutes;
      out.classSize = cls.students;
    }
    if (prefs.showReadingList) out.books = booksFor(ctx, info.studentId);
    return out;
  },

  'admin.login': function (ctx, req) {
    return { email: requireAdmin(ctx, req).email };
  },

  'admin.overview': function (ctx, req) {
    var admin = requireAdmin(ctx, req);
    var s = getSettings(ctx);
    var roster = getRoster(ctx, true);
    var agg = getAggregates(ctx, false);
    var recById = {};
    loadTable(ctx, 'Students').records.forEach(function (r) { recById[str(r.studentId)] = r; });
    var bookCounts = {};
    loadTable(ctx, 'Books').records.forEach(function (b) {
      var id = str(b.studentId);
      bookCounts[id] = (bookCounts[id] || 0) + 1;
    });
    var students = roster.list.map(function (st) {
      var rec = recById[st.studentId];
      var e = agg.byStudent[st.studentId] || { minutes: 0, days: 0 };
      return {
        studentId: st.studentId,
        firstName: st.firstName,
        lastName: st.lastName,
        grade: st.grade,
        teacher: st.teacher,
        token: rec ? str(rec.token) : '',
        code: rec ? str(rec.code) : '',
        minutes: e.minutes,
        days: e.days,
        books: bookCounts[st.studentId] || 0,
      };
    });
    var classes = Object.keys(agg.byClass).map(function (k) { return agg.byClass[k]; })
      .sort(function (a, b) { return compareGrades(a.grade, b.grade) || str(a.teacher).localeCompare(str(b.teacher)); });
    return {
      adminEmail: admin.email,
      settings: s,
      defaults: DEFAULT_SETTINGS,
      templateVars: TEMPLATE_VARS,
      today: ctx.env.today(),
      students: students,
      classes: classes,
      unlinked: students.filter(function (x) { return !x.token; }).length,
    };
  },

  'admin.saveSettings': function (ctx, req) {
    requireAdmin(ctx, req);
    var incoming = req.settings || {};
    var updates = {};
    Object.keys(incoming).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k)) return;
      var v = incoming[k];
      if (SETTING_TYPES[k] === 'date' && str(v) && !isDateStr(str(v))) throw new ApiError('Dates must look like 2026-10-09.');
      if (k === 'donationWidgetHtml' && String(v || '').length > MAX_WIDGET_LENGTH) {
        throw new ApiError('The donation widget HTML is too long (max ' + MAX_WIDGET_LENGTH + ' characters).');
      }
      updates[k] = coerceSetting(k, v);
    });
    var merged = Object.assign({}, getSettings(ctx), updates);
    if (merged.startDate && merged.endDate && merged.startDate > merged.endDate) {
      throw new ApiError('The start date must be on or before the end date.');
    }
    return ctx.store.withLock(function () {
      var table = loadTable(ctx, 'Settings');
      Object.keys(updates).forEach(function (k) {
        var rec = null;
        for (var i = 0; i < table.records.length; i++) {
          if (str(table.records[i].key) === k) { rec = table.records[i]; break; }
        }
        if (rec) {
          rec.value = updates[k];
          saveRecord(ctx, table, rec);
        } else {
          appendRecord(ctx, table, { key: k, value: updates[k] });
        }
      });
      ctx.memo.settings = null;
      invalidateAggregates(ctx);
      return { settings: getSettings(ctx) };
    });
  },

  'admin.syncRoster': function (ctx, req) {
    requireAdmin(ctx, req);
    return ctx.store.withLock(function () {
      var result = syncRoster(ctx);
      invalidateAggregates(ctx);
      return result;
    });
  },

  'admin.regenerateToken': function (ctx, req) {
    requireAdmin(ctx, req);
    return ctx.store.withLock(function () {
      var rec = findStudentRecord(ctx, 'studentId', req.studentId);
      if (!rec) throw new ApiError('Student not found.', 404);
      rec.token = randomString(ctx.env, 24, TOKEN_ALPHABET);
      rec.updatedAt = ctx.env.now();
      saveRecord(ctx, loadTable(ctx, 'Students'), rec);
      return { studentId: str(rec.studentId), token: rec.token };
    });
  },

  'admin.previewWidget': function (ctx, req) {
    requireAdmin(ctx, req);
    var s = getSettings(ctx);
    var roster = getRoster(ctx);
    var rec = findStudentRecord(ctx, 'studentId', req.studentId) || loadTable(ctx, 'Students').records[0];
    var info = rec && roster.byId[str(rec.studentId)];
    var student = info ? withCode(info, rec)
      : { firstName: 'Avery', lastName: 'Reader', grade: '3', teacher: 'Ms. Example', code: 'ABC123' };
    var agg = getAggregates(ctx, false);
    var mine = info && agg.byStudent[info.studentId] || { minutes: 0 };
    var cls = info && agg.byClass[classKey(info)] || { minutes: 0 };
    var html = req.html !== undefined ? String(req.html) : s.donationWidgetHtml;
    return {
      html: renderTemplate(html, templateVars(s, student, {
        totalMinutes: mine.minutes, goalMinutes: rec ? prefsOf(rec, s).goalMinutes : 0, classMinutes: cls.minutes,
      })),
    };
  },
};

/**
 * Organizers sign in with Google. The browser sends Google's ID token; we
 * accept it only if Google vouches for it, it was issued to our OAuth client,
 * it hasn't expired, and the email is an owner/editor of the data spreadsheet.
 */
function requireAdmin(ctx, req) {
  if (ctx.admin) return ctx.admin;
  var clientId = str(ctx.env.googleClientId);
  if (!clientId) throw new ApiError('Google sign-in is not configured. Set GOOGLE_CLIENT_ID in Apps Script.', 500);
  var token = str(req.idToken);
  if (!token) throw new ApiError('Please sign in.', 401);
  var info = token.length <= 4096 ? ctx.env.verifyGoogleIdToken(token) : null;
  var nowSeconds = Date.parse(ctx.env.now()) / 1000;
  if (!info || str(info.aud) !== clientId || GOOGLE_ISSUERS.indexOf(str(info.iss)) < 0 ||
      !(Number(info.exp) > nowSeconds) || !toBool(info.email_verified, false) || !str(info.email)) {
    throw new ApiError('Your sign-in has expired. Please sign in again.', 401);
  }
  var email = str(info.email).toLowerCase();
  var allowed = (ctx.store.adminEmails() || []).map(function (e) { return str(e).toLowerCase(); });
  if (allowed.indexOf(email) < 0) {
    throw new ApiError(email + ' doesn\'t have edit access to the readathon data spreadsheet. ' +
      'Ask the organizer to share it with you as an editor.', 403);
  }
  ctx.admin = { email: email };
  return ctx.admin;
}

function validateBook(req) {
  var title = str(req.title).replace(/\s+/g, ' ');
  var author = str(req.author).replace(/\s+/g, ' ');
  if (!title) throw new ApiError('Please enter the book title.');
  if (title.length > 200) throw new ApiError('That title is too long.');
  if (author.length > 150) throw new ApiError('That author name is too long.');
  var coverId = str(req.coverId);
  var isbn = str(req.isbn).replace(/[^0-9Xx]/g, '').toUpperCase();
  return {
    title: title,
    author: author,
    status: req.status === 'reading' ? 'reading' : 'finished',
    coverId: /^\d{1,12}$/.test(coverId) ? coverId : '',
    isbn: isbn.length === 10 || isbn.length === 13 ? isbn : '',
  };
}

function findBook(table, studentId, bookId) {
  var id = str(bookId);
  for (var i = 0; i < table.records.length; i++) {
    var b = table.records[i];
    if (str(b.bookId) === id && str(b.studentId) === studentId) return b;
  }
  throw new ApiError('Book not found.', 404);
}

/**
 * Gives every roster student a private token and a short donation code, and
 * refreshes the informational name/grade/teacher columns. Rewrites the
 * Students tab in one batch. Call while holding the lock.
 */
function syncRoster(ctx) {
  var roster = getRoster(ctx, true);
  var table = loadTable(ctx, 'Students');
  var byId = {};
  var usedTokens = {};
  var usedCodes = {};
  table.records.forEach(function (r) {
    byId[str(r.studentId)] = r;
    usedTokens[str(r.token)] = true;
    usedCodes[str(r.code).toUpperCase()] = true;
  });
  var unique = function (len, alphabet, used) {
    for (;;) {
      var v = randomString(ctx.env, len, alphabet);
      if (!used[v]) { used[v] = true; return v; }
    }
  };
  var now = ctx.env.now();
  var created = 0;
  var updated = 0;
  roster.list.forEach(function (st) {
    var name = (st.firstName + ' ' + st.lastName).trim();
    var rec = byId[st.studentId];
    if (!rec) {
      rec = { _raw: null, studentId: st.studentId, token: '', code: '', goalMinutes: '', showReadingList: '',
        showTotalMinutes: '', showClassMinutes: '', createdAt: now, updatedAt: now };
      table.records.push(rec);
      byId[st.studentId] = rec;
      created++;
    } else if (str(rec.studentName) !== name || str(rec.grade) !== st.grade || str(rec.teacher) !== st.teacher) {
      updated++;
    }
    if (!str(rec.token)) rec.token = unique(24, TOKEN_ALPHABET, usedTokens);
    if (!str(rec.code)) rec.code = unique(6, CODE_ALPHABET, usedCodes);
    rec.studentName = name;
    rec.grade = st.grade;
    rec.teacher = st.teacher;
  });
  ctx.store.replaceRows('Students', table.records.map(function (r) { return toRow(table, r); }));
  delete ctx.memo['table:Students'];
  var orphaned = table.records.filter(function (r) { return !roster.byId[str(r.studentId)]; }).length;
  return { created: created, updated: updated, total: roster.list.length, orphaned: orphaned };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    handleApi: handleApi,
    renderTemplate: renderTemplate,
    parseRoster: parseRoster,
    SCHEMA: SCHEMA,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    ApiError: ApiError,
  };
}
