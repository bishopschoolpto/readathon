const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { handleApi, renderTemplate, parseRoster } = require('../../apps-script/Core.js');
const { createFileStore } = require('../../dev/store.js');

const ROSTER = {
  headers: ['Student ID', 'First Name', 'Last Name', 'Grade', 'Teacher'],
  rows: [
    [1, 'Avery', 'Example', 'K', 'Ms. Rivera'],
    [2, 'Jordan', 'Sample', '3', 'Mr. Chen'],
    [3, 'Riley', 'Test', '3', 'Mr. Chen'],
  ],
};

const NOW = Date.parse('2026-10-09T12:00:00.000Z') / 1000;
const CLIENT_ID = 'client-123.apps.googleusercontent.com';

// Claims Google's tokeninfo would return for each fake ID token.
const TOKENS = {
  organizer: { aud: CLIENT_ID, iss: 'https://accounts.google.com', exp: String(NOW + 3000), email: 'Organizer@Example.com', email_verified: 'true' },
  stranger: { aud: CLIENT_ID, iss: 'accounts.google.com', exp: String(NOW + 3000), email: 'parent@example.com', email_verified: 'true' },
  otherApp: { aud: 'someone-else', iss: 'accounts.google.com', exp: String(NOW + 3000), email: 'organizer@example.com', email_verified: 'true' },
  expired: { aud: CLIENT_ID, iss: 'accounts.google.com', exp: String(NOW - 10), email: 'organizer@example.com', email_verified: 'true' },
  unverified: { aud: CLIENT_ID, iss: 'accounts.google.com', exp: String(NOW + 3000), email: 'organizer@example.com', email_verified: 'false' },
  badIssuer: { aud: CLIENT_ID, iss: 'evil.example', exp: String(NOW + 3000), email: 'organizer@example.com', email_verified: 'true' },
};
const ADMIN = { idToken: 'organizer' };

function setup(today = '2026-10-09') {
  const store = createFileStore(null, ROSTER, ['organizer@example.com', 'cochair@example.com']);
  const env = {
    today: () => today,
    now: () => '2026-10-09T12:00:00.000Z',
    randomBytes: (n) => [...crypto.randomBytes(n)],
    googleClientId: CLIENT_ID,
    verifyGoogleIdToken: (t) => TOKENS[t] || null,
    log: () => {},
  };
  const call = (action, params) => handleApi(store, env, { action, ...params });
  const ok = (action, params) => {
    const r = call(action, params);
    assert.ok(r.ok, `${action} failed: ${r.error}`);
    return r.data;
  };
  ok('admin.saveSettings', { ...ADMIN, settings: { startDate: '2026-10-05', endDate: '2026-10-15' } });
  ok('admin.syncRoster', ADMIN);
  const students = ok('admin.overview', ADMIN).students;
  return { store, env, call, ok, students };
}

test('sync gives each student a unique token and short code', () => {
  const { students } = setup();
  assert.strictEqual(students.length, 3);
  const tokens = new Set(students.map((s) => s.token));
  const codes = new Set(students.map((s) => s.code));
  assert.strictEqual(tokens.size, 3);
  assert.strictEqual(codes.size, 3);
  students.forEach((s) => {
    assert.match(s.token, /^[A-Za-z0-9]{24}$/);
    assert.match(s.code, /^[A-Z2-9]{6}$/);
  });
});

test('sync is idempotent', () => {
  const { ok, students } = setup();
  const r = ok('admin.syncRoster', ADMIN);
  assert.strictEqual(r.created, 0);
  const again = ok('admin.overview', ADMIN).students;
  assert.deepStrictEqual(again.map((s) => s.token), students.map((s) => s.token));
});

test('student logs minutes for today and past days, totals add up', () => {
  const { ok, students } = setup();
  const [, jordan, riley] = students;
  ok('student.setMinutes', { token: jordan.token, date: '2026-10-09', minutes: 30 });
  ok('student.setMinutes', { token: jordan.token, date: '2026-10-06', minutes: 20 });
  const r = ok('student.setMinutes', { token: jordan.token, date: '2026-10-09', minutes: 45 }); // update, not add
  assert.strictEqual(r.totalMinutes, 65);
  ok('student.setMinutes', { token: riley.token, date: '2026-10-08', minutes: 10 });
  const view = ok('student.get', { token: jordan.token });
  assert.strictEqual(view.totalMinutes, 65);
  assert.strictEqual(view.daysRead, 2);
  assert.strictEqual(view.classMinutes, 75); // Mr. Chen's class
  assert.strictEqual(view.days.length, 5); // Oct 5..9
  assert.strictEqual(view.days.find((d) => d.date === '2026-10-06').minutes, 20);
});

test('minutes are rejected for future days, outside the range, bad values, or when locked', () => {
  const { call, ok, students } = setup();
  const t = students[0].token;
  assert.ok(!call('student.setMinutes', { token: t, date: '2026-10-10', minutes: 10 }).ok);
  assert.ok(!call('student.setMinutes', { token: t, date: '2026-10-01', minutes: 10 }).ok);
  assert.ok(!call('student.setMinutes', { token: t, date: '2026-10-09', minutes: -5 }).ok);
  assert.ok(!call('student.setMinutes', { token: t, date: '2026-10-09', minutes: 2.5 }).ok);
  assert.ok(!call('student.setMinutes', { token: t, date: '2026-10-09', minutes: 9999 }).ok);
  ok('admin.saveSettings', { ...ADMIN, settings: { editsLocked: true } });
  const r = call('student.setMinutes', { token: t, date: '2026-10-09', minutes: 10 });
  assert.ok(!r.ok);
  assert.match(r.error, /locked/);
});

test('unknown tokens and codes are not found', () => {
  const { call } = setup();
  assert.strictEqual(call('student.get', { token: 'x'.repeat(24) }).status, 404);
  assert.strictEqual(call('student.get', { token: '' }).status, 404);
  assert.strictEqual(call('donation.get', { code: 'ZZZZZZ' }).status, 404);
});

test('donation page respects the student privacy toggles', () => {
  const { ok, students } = setup();
  const s = students[1];
  ok('student.setMinutes', { token: s.token, date: '2026-10-09', minutes: 30 });
  ok('student.addBook', { token: s.token, title: 'Charlotte\'s Web', author: 'E. B. White', status: 'finished' });

  let d = ok('donation.get', { code: s.code.toLowerCase() });
  assert.strictEqual(d.student.name, 'Jordan S.');
  assert.strictEqual(d.totalMinutes, 30);
  assert.strictEqual(d.classMinutes, 30);
  assert.strictEqual(d.books.length, 1);
  assert.ok(!('token' in d.student));

  ok('student.setPrefs', { token: s.token, showReadingList: false, showTotalMinutes: false, showClassMinutes: false });
  d = ok('donation.get', { code: s.code });
  assert.strictEqual(d.totalMinutes, undefined);
  assert.strictEqual(d.classMinutes, undefined);
  assert.strictEqual(d.books, undefined);
});

test('books: one current book, finish it, delete it, other students cannot touch it', () => {
  const { ok, call, students } = setup();
  const [a, b] = students;
  ok('student.addBook', { token: a.token, title: 'Book One', status: 'reading', coverId: '12345' });
  let r = ok('student.addBook', { token: a.token, title: 'Book Two', status: 'reading' });
  assert.deepStrictEqual(r.books.map((x) => x.title), ['Book Two']);
  const id = r.books[0].bookId;
  assert.ok(!call('student.deleteBook', { token: b.token, bookId: id }).ok);
  r = ok('student.updateBook', { token: a.token, bookId: id, status: 'finished' });
  assert.strictEqual(r.books[0].status, 'finished');
  r = ok('student.deleteBook', { token: a.token, bookId: id });
  assert.strictEqual(r.books.length, 0);
  assert.ok(!call('student.addBook', { token: a.token, title: '   ' }).ok);
});

test('widget template values are escaped, url-encoded, or JSON-encoded', () => {
  const vars = { studentName: 'Zoë <b>&"', studentTeacher: 'Mr. O\'Neil' };
  assert.strictEqual(renderTemplate('{studentName}', vars), 'Zoë &lt;b&gt;&amp;&quot;');
  assert.strictEqual(renderTemplate('?n={studentName:url}', vars), '?n=Zo%C3%AB%20%3Cb%3E%26%22');
  assert.strictEqual(renderTemplate('{studentName:json}', vars), '"Zoë \\u003cb\\u003e&\\""');
  assert.strictEqual(renderTemplate('.a{color:red} {unknown} {studentTeacher}', vars), '.a{color:red} {unknown} Mr. O&#39;Neil');
});

test('donation widget is rendered for the student', () => {
  const { ok, students } = setup();
  ok('admin.saveSettings', {
    ...ADMIN,
    settings: { donationWidgetHtml: '<a href="https://give.example/?for={studentName:url}">{studentName} · {studentGrade} · {studentTeacher}</a>' },
  });
  const d = ok('donation.get', { code: students[0].code });
  assert.strictEqual(d.widgetHtml, '<a href="https://give.example/?for=Avery%20E.">Avery E. · K · Ms. Rivera</a>');
});

test('admin actions require a Google sign-in from a spreadsheet editor', () => {
  const { call, ok } = setup();
  assert.strictEqual(ok('admin.login', ADMIN).email, 'organizer@example.com'); // case-insensitive match
  assert.strictEqual(call('admin.overview', {}).status, 401);
  assert.strictEqual(call('admin.overview', { idToken: 'forged' }).status, 401);
  assert.strictEqual(call('admin.overview', { idToken: 'otherApp' }).status, 401);
  assert.strictEqual(call('admin.overview', { idToken: 'expired' }).status, 401);
  assert.strictEqual(call('admin.overview', { idToken: 'unverified' }).status, 401);
  assert.strictEqual(call('admin.overview', { idToken: 'badIssuer' }).status, 401);
  const r = call('admin.syncRoster', { idToken: 'stranger' });
  assert.strictEqual(r.status, 403);
  assert.match(r.error, /parent@example\.com doesn't have edit access/);
  assert.ok(!call('admin.saveSettings', { ...ADMIN, settings: { startDate: '2026-10-20', endDate: '2026-10-01' } }).ok);
});

test('regenerating a token invalidates the old link but keeps the donation code', () => {
  const { ok, call, students } = setup();
  const s = students[0];
  const r = ok('admin.regenerateToken', { ...ADMIN, studentId: s.studentId });
  assert.notStrictEqual(r.token, s.token);
  assert.strictEqual(call('student.get', { token: s.token }).status, 404);
  assert.strictEqual(ok('student.get', { token: r.token }).student.code, s.code);
});

test('roster parsing tolerates header variants and "Last, First" names', () => {
  const r = parseRoster({
    headers: ['ID', 'Student Name', 'Grade Level', 'Homeroom Teacher'],
    rows: [['7', 'Lopez, Maya', '2', 'Ms. Lee'], ['8', 'Leo Kim', '2', 'Ms. Lee'], ['', 'No Id', '2', 'x']],
  });
  assert.deepStrictEqual(r.list.map((s) => [s.studentId, s.firstName, s.lastName, s.teacher]), [
    ['7', 'Maya', 'Lopez', 'Ms. Lee'],
    ['8', 'Leo', 'Kim', 'Ms. Lee'],
  ]);
});

test('admin sign-in fails closed when GOOGLE_CLIENT_ID is not configured', () => {
  const { store, env } = setup();
  const r = handleApi(store, { ...env, googleClientId: '' }, { action: 'admin.overview', ...ADMIN });
  assert.strictEqual(r.status, 500);
  assert.match(r.error, /GOOGLE_CLIENT_ID/);
});
