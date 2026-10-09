// Organizer dashboard: /admin
(function () {
  var TOKEN_STORAGE = 'readathon.idToken';
  var config = window.READATHON_CONFIG || {};
  var idToken = '';
  var data = null;

  function $(id) { return document.getElementById(id); }
  function getStored() { try { return sessionStorage.getItem(TOKEN_STORAGE) || ''; } catch (e) { return ''; } }
  function setStored(v) { try { v ? sessionStorage.setItem(TOKEN_STORAGE, v) : sessionStorage.removeItem(TOKEN_STORAGE); } catch (e) { /* ignore */ } }
  async function adminApi(action, params) {
    try {
      return await RA.api(action, Object.assign({ idToken: idToken }, params || {}));
    } catch (err) {
      // Google ID tokens last about an hour; ask the organizer to sign in again.
      if (err.status === 401) showLogin(err.message);
      throw err;
    }
  }
  function setStatus(el, text, ok) {
    el.textContent = text;
    el.className = 'status ' + (ok ? 'ok' : 'err');
  }
  function studentUrl(s) { return location.origin + '/s/' + s.token; }
  function donateUrl(s) { return location.origin + '/d/' + s.code; }

  // --- Sign in ------------------------------------------------------------
  // Organizers sign in with Google. The server checks Google's ID token and
  // that the account can edit the readathon data spreadsheet.

  function showLogin(message) {
    idToken = '';
    setStored('');
    $('login').hidden = false;
    $('dash').hidden = true;
    $('logout').hidden = true;
    $('who').textContent = 'Organizer';
    setStatus($('login-status'), message || '', false);
    setupSignInButton();
  }

  var buttonReady = false;
  function setupSignInButton() {
    if (buttonReady) return;
    buttonReady = true;
    if (config.devSignIn) {
      $('dev-signin').hidden = false;
      $('dev-signin').onsubmit = function (e) {
        e.preventDefault();
        signIn('dev:' + $('dev-email').value.trim());
      };
      return;
    }
    if (!config.googleClientId || /REPLACE_WITH/.test(config.googleClientId)) {
      setStatus($('login-status'), 'Google sign-in is not set up yet: add googleClientId to config.js.', false);
      return;
    }
    var script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = function () {
      google.accounts.id.initialize({
        client_id: config.googleClientId,
        callback: function (response) { signIn(response.credential); },
        auto_select: true,
      });
      google.accounts.id.renderButton($('google-button'), { theme: 'filled_blue', size: 'large', text: 'signin_with' });
      google.accounts.id.prompt(); // One Tap: returning organizers may be signed straight back in
    };
    script.onerror = function () { setStatus($('login-status'), 'Could not load Google sign-in. Check your connection.', false); };
    document.head.appendChild(script);
  }

  $('logout').onclick = function () {
    if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
    setStored('');
    location.reload();
  };

  async function signIn(token) {
    idToken = token;
    setStatus($('login-status'), '', true);
    try {
      await load();
      setStored(token);
      $('login').hidden = true;
      $('dash').hidden = false;
      $('logout').hidden = false;
      $('who').textContent = data.adminEmail;
    } catch (err) {
      showLogin(err.message);
    }
  }

  var stored = getStored();
  if (stored) signIn(stored); else showLogin('');

  async function load() {
    data = await adminApi('admin.overview');
    $('site-title').textContent = data.settings.readathonTitle;
    renderOverview();
    renderStudents();
    renderSettings();
    renderWidget();
  }

  // --- Tabs ----------------------------------------------------------------

  document.querySelectorAll('[data-tab]').forEach(function (btn) {
    btn.onclick = function () {
      document.querySelectorAll('[data-tab]').forEach(function (b) { b.setAttribute('aria-selected', String(b === btn)); });
      document.querySelectorAll('[data-panel]').forEach(function (p) { p.hidden = p.dataset.panel !== btn.dataset.tab; });
    };
  });

  // --- Overview ------------------------------------------------------------

  function renderOverview() {
    var total = 0, readers = 0, books = 0;
    data.students.forEach(function (s) {
      total += s.minutes;
      books += s.books;
      if (s.minutes > 0) readers++;
    });
    var tiles = [
      [RA.fmt(total), 'total minutes'],
      [RA.fmt(readers) + ' / ' + RA.fmt(data.students.length), 'students reading'],
      [RA.fmt(books), 'books logged'],
      [data.settings.schoolGoalMinutes ? RA.percent(total, data.settings.schoolGoalMinutes) + '%' : '—', 'of school goal'],
    ];
    $('overview-stats').innerHTML = tiles.map(function (t) {
      return '<div class="stat"><div class="value">' + RA.esc(t[0]) + '</div><div class="label">' + RA.esc(t[1]) + '</div></div>';
    }).join('');
    $('class-rows').innerHTML = data.classes.map(function (c) {
      return '<tr><td>' + RA.esc(c.grade) + '</td><td>' + RA.esc(c.teacher) + '</td><td class="num">' + RA.fmt(c.students) +
        '</td><td class="num">' + RA.fmt(c.readers) + '</td><td class="num">' + RA.fmt(c.minutes) +
        '</td><td class="num">' + (c.readers ? RA.fmt(Math.round(c.minutes / c.readers)) : '—') + '</td></tr>';
    }).join('');
  }

  // --- Students --------------------------------------------------------------

  function className(s) { return [s.grade, s.teacher].filter(Boolean).join(' · '); }

  function renderStudents() {
    var select = $('student-class');
    var current = select.value;
    var classes = [];
    data.students.forEach(function (s) { if (classes.indexOf(className(s)) < 0) classes.push(className(s)); });
    select.innerHTML = '<option value="">All classes</option>' + classes.map(function (c) {
      return '<option>' + RA.esc(c) + '</option>';
    }).join('');
    select.value = current;
    $('sync-notice').innerHTML = data.unlinked
      ? '<div class="notice" style="margin:1rem 0 0">' + data.unlinked + ' student(s) in the roster don\'t have links yet. Click <strong>Sync roster</strong>.</div>'
      : '';
    filterStudents();
  }

  function visibleStudents() {
    var q = $('student-search').value.trim().toLowerCase();
    var cls = $('student-class').value;
    return data.students.filter(function (s) {
      if (cls && className(s) !== cls) return false;
      if (!q) return true;
      return [s.firstName, s.lastName, s.grade, s.teacher, s.code, s.studentId].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }

  function filterStudents() {
    var rows = visibleStudents();
    var body = $('student-rows');
    body.innerHTML = '';
    rows.forEach(function (s) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + RA.esc(s.firstName + ' ' + s.lastName) + '</td><td>' + RA.esc(s.grade) + '</td><td>' + RA.esc(s.teacher) +
        '</td><td class="num">' + RA.fmt(s.minutes) + '</td><td class="num">' + RA.fmt(s.books) + '</td><td><code>' + RA.esc(s.code || '—') + '</code></td><td></td>';
      var cell = tr.lastChild;
      if (s.token) {
        cell.innerHTML = '<div class="row">' +
          '<button class="btn btn-small" data-act="copy-log">Copy log link</button>' +
          '<button class="btn btn-small" data-act="copy-donate">Copy donation link</button>' +
          '<a class="btn btn-small btn-ghost" target="_blank" rel="noopener" href="' + RA.esc(studentUrl(s)) + '">Open log</a>' +
          '<button class="btn btn-small btn-danger" data-act="regen" title="Use if the private link was shared by mistake">New log link</button></div>';
        cell.querySelector('[data-act=copy-log]').onclick = function (e) { RA.copyText(studentUrl(s), e.target); };
        cell.querySelector('[data-act=copy-donate]').onclick = function (e) { RA.copyText(donateUrl(s), e.target); };
        cell.querySelector('[data-act=regen]').onclick = function (e) { regenerate(s, e.target); };
      } else {
        cell.innerHTML = '<span class="muted small">Sync roster to create</span>';
      }
      body.appendChild(tr);
    });
    if (!rows.length) body.innerHTML = '<tr><td colspan="7" class="muted">No students match.</td></tr>';
  }

  $('student-search').oninput = filterStudents;
  $('student-class').onchange = filterStudents;

  async function regenerate(s, btn) {
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = 'Old link stops working — confirm?';
      setTimeout(function () { delete btn.dataset.armed; btn.textContent = 'New log link'; }, 4000);
      return;
    }
    try {
      var r = await adminApi('admin.regenerateToken', { studentId: s.studentId });
      s.token = r.token;
      filterStudents();
    } catch (err) {
      btn.textContent = err.message;
    }
  }

  $('sync').onclick = async function () {
    var btn = $('sync');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    try {
      var r = await adminApi('admin.syncRoster');
      await load();
      $('sync-notice').innerHTML = '<div class="notice" style="margin:1rem 0 0">Roster synced: ' + r.total + ' students, ' +
        r.created + ' new link(s) created' + (r.orphaned ? ', ' + r.orphaned + ' student(s) no longer in the roster (their data is kept)' : '') + '.</div>';
    } catch (err) {
      $('sync-notice').innerHTML = '<div class="notice error" style="margin:1rem 0 0">' + RA.esc(err.message) + '</div>';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sync roster';
    }
  };

  $('export').onclick = function () {
    var head = ['Student ID', 'First Name', 'Last Name', 'Grade', 'Teacher', 'Minutes', 'Books', 'Donation Code', 'Private Log Link', 'Donation Link'];
    var lines = [head].concat(visibleStudents().map(function (s) {
      return [s.studentId, s.firstName, s.lastName, s.grade, s.teacher, s.minutes, s.books, s.code,
        s.token ? studentUrl(s) : '', s.code ? donateUrl(s) : ''];
    }));
    var csv = lines.map(function (r) {
      return r.map(function (v) {
        v = String(v === null || v === undefined ? '' : v);
        if (/^[=+\-@]/.test(v)) v = "'" + v; // keep spreadsheets from treating values as formulas
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    }).join('\r\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'readathon-links.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  $('print').onclick = function () {
    var title = data.settings.readathonTitle;
    $('slips').innerHTML = '<div class="slips">' + visibleStudents().filter(function (s) { return s.token; }).map(function (s) {
      return '<div class="slip"><strong>' + RA.esc(title) + '</strong><div class="slip-name">' + RA.esc(s.firstName + ' ' + s.lastName) +
        '</div><div class="muted small">' + RA.esc(className(s)) + '</div>' +
        '<div class="small"><b>My reading log (keep private):</b><br>' + RA.esc(studentUrl(s)) + '</div>' +
        '<div class="small"><b>My donation page (share this!):</b><br>' + RA.esc(donateUrl(s)) + '</div></div>';
    }).join('') + '</div>';
    window.print();
  };

  // --- Settings --------------------------------------------------------------

  function renderSettings() {
    var form = $('settings-form');
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || !(el.name in data.settings)) return;
      if (el.type === 'checkbox') el.checked = !!data.settings[el.name];
      else el.value = data.settings[el.name];
    });
  }

  $('settings-form').onsubmit = async function (e) {
    e.preventDefault();
    var settings = {};
    Array.prototype.forEach.call(e.target.elements, function (el) {
      if (!el.name) return;
      settings[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    });
    try {
      var r = await adminApi('admin.saveSettings', { settings: settings });
      data.settings = r.settings;
      setStatus($('settings-status'), 'Saved ✓', true);
      await load();
    } catch (err) {
      setStatus($('settings-status'), err.message, false);
    }
  };

  // --- Donation widget -------------------------------------------------------

  var previewTimer = null;

  function renderWidget() {
    var ta = $('widget-html');
    if (document.activeElement !== ta) ta.value = data.settings.donationWidgetHtml;
    $('var-list').innerHTML = data.templateVars.map(function (v) { return '<code>{' + RA.esc(v) + '}</code>'; }).join(' ');
    var sel = $('preview-student');
    var current = sel.value;
    sel.innerHTML = data.students.filter(function (s) { return s.token; }).slice(0, 500).map(function (s) {
      return '<option value="' + RA.esc(s.studentId) + '">' + RA.esc(s.firstName + ' ' + s.lastName) + '</option>';
    }).join('');
    if (current) sel.value = current;
    updatePreview();
  }

  async function updatePreview() {
    try {
      var r = await adminApi('admin.previewWidget', { html: $('widget-html').value, studentId: $('preview-student').value });
      $('preview').srcdoc = '<!doctype html><html><head><meta charset="utf-8">' +
        '<link rel="stylesheet" href="' + location.origin + '/css/style.css"></head>' +
        '<body style="padding:1rem;background:#fff"><div class="widget">' + r.html + '</div></body></html>';
    } catch (err) {
      setStatus($('widget-status'), err.message, false);
    }
  }

  $('widget-html').oninput = function () {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 500);
  };
  $('preview-student').onchange = updatePreview;
  $('widget-reset').onclick = function () {
    $('widget-html').value = data.defaults.donationWidgetHtml;
    updatePreview();
  };
  $('widget-form').onsubmit = async function (e) {
    e.preventDefault();
    try {
      var r = await adminApi('admin.saveSettings', { settings: { donationWidgetHtml: $('widget-html').value } });
      data.settings = r.settings;
      setStatus($('widget-status'), 'Saved ✓', true);
    } catch (err) {
      setStatus($('widget-status'), err.message, false);
    }
  };
})();
