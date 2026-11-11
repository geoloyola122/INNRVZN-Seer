/**
 * INNRVZN Seer: browser backend. A port of apps_script/Code.gs (itself a port of native/app.py) that runs IN THE BROWSER and
 * talks straight to the Google Sheets API with the signed-in person's own Google access. No server in between: the host only
 * delivers these files. Same sheet as the exe / Apps Script version, so everything stays in sync.
 * Same safety rules: writes only to input columns, never TASKS E (TYPE) or CAMPAIGNS O (NEXT TASK), and every row write
 * re-checks the row's name first (the team edits the sheet live).
 *
 * Needs window.TRACKER_CONFIG = { CLIENT_ID, SHEET_ID }  (config.js).
 * Test hook: TRACKER_CONFIG.API_BASE + NO_AUTH point it at a local proxy instead of Google (used by the verification harness).
 */
(function () {
  'use strict';
  var CFG = window.TRACKER_CONFIG || {};
  var SHEET_ID = CFG.SHEET_ID, TZ = 'Asia/Manila';
  var BASE = CFG.API_BASE || 'https://sheets.googleapis.com/v4/spreadsheets';
  var SCOPE = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email';
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  var LINK_COLS = {
    'CAMPAIGNS': { L: 'master', M: 'deck', AD: 'infl', AO: 'bill' },
    'PME CLIENTS': { Q: 'bill' },
    'AGENCIES': { Z: 'bill' }
  };
  var LINK_LABEL = { master: 'Master file', deck: 'Deck', infl: 'Influencers', bill: 'Billing' };
  var EDIT_TABS = {
    'TASKS': ['C', ['E']],
    'CAMPAIGNS': ['E', ['O']],
    'CLIENTS & PARTNERSHIPS': ['C', ['L', 'P', 'R']],
    'BRAND OUTREACH CLIENTS': ['C', []],
    'PME CLIENTS': ['C', ['O', 'P']],
    'AGENCIES': ['C', ['P', 'U', 'Y']],
    'MEETINGS': ['B', ['K']],
    'ACCOUNT MANAGERS': ['B', []]
  };
  var LOG_TAB = 'CRM LOG', BACKLOG_TAB = 'DEV BACKLOG';
  var CLIENT_TABS = {
    'Clients & Partnerships': ['CLIENTS & PARTNERSHIPS', 'G'],
    'Brand Outreach': ['BRAND OUTREACH CLIENTS', 'F'],
    'PME': ['PME CLIENTS', 'E'],
    'Agencies': ['AGENCIES', 'E']
  };

  // ------------------------------------------------------------ Google sign-in (token flow, no server)
  var token = '', tokenExp = 0, email = '', tc = null, pending = null, waiters = [];
  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { } }

  function signinUI(show, msg) {
    var el = document.getElementById('signin');
    if (!el) return;
    el.style.display = show ? 'flex' : 'none';
    var m = document.getElementById('signin-msg');
    if (m) m.textContent = msg || '';
  }
  function waitGIS() {
    return new Promise(function (ok, no) {
      var n = 0;
      (function poll() {
        if (window.google && google.accounts && google.accounts.oauth2) return ok();
        if (++n > 100) return no(new Error('Google sign-in did not load. Check your connection and refresh.'));
        setTimeout(poll, 100);
      })();
    });
  }
  function requestToken(prompt) {
    return waitGIS().then(function () {
      if (!CFG.CLIENT_ID || /^YOUR_/.test(CFG.CLIENT_ID)) throw new Error('Google sign-in is not set up yet (config.js has no CLIENT_ID).');
      if (!tc) tc = google.accounts.oauth2.initTokenClient({ client_id: CFG.CLIENT_ID, scope: SCOPE, callback: function () { } });
      return new Promise(function (res, rej) {
        tc.callback = function (r) {
          if (r.error) return rej(new Error(r.error_description || r.error));
          token = r.access_token; tokenExp = Date.now() + ((r.expires_in || 3600) - 90) * 1000;
          fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } })
            .then(function (x) { return x.json(); }).then(function (u) { email = (u && u.email) || ''; }).catch(function () { })
            .then(function () { res(token); });
        };
        tc.error_callback = function (e) { rej(new Error((e && (e.message || e.type)) || 'Sign-in was cancelled')); };
        tc.requestAccessToken({ prompt: prompt });
      });
    });
  }
  function ensureToken() {
    if (CFG.NO_AUTH) return Promise.resolve('');
    if (token && Date.now() < tokenExp) return Promise.resolve(token);
    if (pending) return pending;
    pending = (async function () {
      try {
        if (lsGet('ta_signed')) {            // came back after a refresh or an hour: try silently first
          try { await requestToken(''); signinUI(false); return token; } catch (e) { }
        }
        signinUI(true, lsGet('ta_signed') ? 'Your session ended. Sign in again to continue.' : '');
        await new Promise(function (res) { waiters.push(res); });
        return token;
      } finally { pending = null; }
    })();
    return pending;
  }
  // the sign-in button (needs a real click, so browsers allow the Google popup)
  window.__signin = function () {
    var b = document.getElementById('signin-btn');
    if (b) b.disabled = true;
    requestToken(lsGet('ta_signed') ? '' : 'select_account').then(function () {
      lsSet('ta_signed', '1'); signinUI(false);
      var w = waiters; waiters = []; w.forEach(function (f) { f(); });
    }).catch(function (e) {
      signinUI(true, e.message || 'Sign-in failed. Try again.');
    }).then(function () { if (b) b.disabled = false; });
  };

  // ------------------------------------------------------------ REST helpers
  function qs(o) {
    var p = new URLSearchParams();
    Object.keys(o || {}).forEach(function (k) {
      [].concat(o[k]).forEach(function (v) { if (v !== undefined) p.append(k, v); });
    });
    var s = p.toString();
    return s ? '?' + s : '';
  }
  async function api(method, path, query, body, retried) {
    var t = await ensureToken();
    var headers = { 'Content-Type': 'application/json' };
    if (t) headers.Authorization = 'Bearer ' + t;
    var r = await fetch(BASE + '/' + SHEET_ID + path + qs(query), { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401 && !retried && !CFG.NO_AUTH) { token = ''; return api(method, path, query, body, true); }
    if (!r.ok) {
      var j = null; try { j = await r.json(); } catch (e) { }
      var msg = (j && j.error && j.error.message) || ('Google Sheets returned ' + r.status);
      if (r.status === 403) msg += ' (is the sheet shared with your Google account?)';
      throw new Error(msg);
    }
    return r.json();
  }
  var VR = { valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' };
  async function vals_(rng) {
    var r = await api('GET', '/values/' + encodeURIComponent(rng), VR);
    return r.values || [];
  }
  function vUpdate(rng, values, input) { return api('PUT', '/values/' + encodeURIComponent(rng), { valueInputOption: input }, { values: values }); }
  function vAppend(rng, values, input) {
    return api('POST', '/values/' + encodeURIComponent(rng) + ':append', { valueInputOption: input, insertDataOption: 'INSERT_ROWS' }, { values: values });
  }
  function vBatch(data, input) { return api('POST', '/values:batchUpdate', null, { valueInputOption: input, data: data }); }
  function sBatch(requests) { return api('POST', ':batchUpdate', null, { requests: requests }); }

  // ------------------------------------------------------------ helpers (same behaviour as Code.gs)
  function pstr_(v) { if (v === true) return 'True'; if (v === false) return 'False'; return v == null ? '' : String(v); }
  function pad_(r, n) { var o = (r || []).slice(); while (o.length < n) o.push(''); return o; }
  function col_(i) { var s = ''; i += 1; while (i) { var r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; }
  function colNum_(L) { var n = 0; for (var i = 0; i < L.length; i++) n = n * 26 + (L.charCodeAt(i) - 64); return n - 1; }
  function serialToIso_(v) {
    if (typeof v === 'number' && v > 30000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000).toISOString().slice(0, 10);
    return (v === '' || v == null) ? '' : pstr_(v);
  }
  function timeStr_(v) {
    if (typeof v === 'number' && v >= 0 && v < 1) {
      var m = Math.round(v * 1440), h = Math.floor(m / 60), mi = m % 60;
      return ((h % 12) || 12) + ':' + (mi < 10 ? '0' : '') + mi + ' ' + (h < 12 ? 'AM' : 'PM');
    }
    return pstr_(v ? v : '');
  }
  function nowParts() {   // "now" in Manila, the sheet's timezone
    var o = {};
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
      .formatToParts(new Date()).forEach(function (p) { o[p.type] = p.value; });
    o.mon = MON[+o.month - 1];
    return o;
  }
  function stampNow() { var p = nowParts(); return p.weekday + ', ' + p.mon + ' ' + p.day + ', ' + p.year + ' · ' + p.hour + ':' + p.minute + ' ' + String(p.dayPeriod || '').toUpperCase(); }
  function dateNow() { var p = nowParts(); return p.year + '-' + ('0' + p.month).slice(-2) + '-' + ('0' + p.day).slice(-2); }
  function dueFmt(iso) { var d = new Date(iso.slice(0, 10) + 'T00:00:00Z'); return DOW[d.getUTCDay()] + ', ' + MON[d.getUTCMonth()] + ' ' + d.getUTCDate(); }
  async function sheetIds_() {
    var meta = await api('GET', '', { fields: 'sheets.properties(sheetId,title)' });
    var o = {}; (meta.sheets || []).forEach(function (s) { o[s.properties.title] = s.properties.sheetId; });
    return o;
  }
  async function sheetId_(title) { var ids = await sheetIds_(); if (!(title in ids)) throw new Error('No such tab: ' + title); return ids[title]; }
  async function check_(sheet, row, col, expected) {
    var cur = await vals_(sheet + '!' + col + row);
    if (!cur.length || !cur[0].length || pstr_(cur[0][0]) !== expected) throw new Error('Rows moved. Refresh and try again.');
  }
  async function people_() { return (await vals_('LISTS!E2:E')).map(function (r) { return pstr_(r[0]); }).filter(function (x) { return x; }); }
  async function meName_() {
    var e = (email || '').toLowerCase(), p = await people_();
    for (var i = 0; i < p.length; i++) if (e.indexOf(p[i].toLowerCase()) > -1) return p[i];
    return '';
  }

  // ------------------------------------------------------------ reads
  async function links_() {
    var out = {};
    try {
      var specs = [['CAMPAIGNS', 'L2:M'], ['CAMPAIGNS', 'AD2:AD'], ['CAMPAIGNS', 'AO2:AO'], ['PME CLIENTS', 'Q2:Q'], ['AGENCIES', 'Z2:Z']];
      var res = await api('GET', '', {
        ranges: specs.map(function (s) { return "'" + s[0] + "'!" + s[1]; }), includeGridData: 'true',
        fields: 'sheets(properties.title,data(startRow,startColumn,rowData.values(formattedValue,hyperlink,chipRuns)))'
      });
      (res.sheets || []).forEach(function (sh) {
        var t = sh.properties.title, names = LINK_COLS[t] || {};
        (sh.data || []).forEach(function (blk) {
          var r0 = blk.startRow || 0, c0 = blk.startColumn || 0;
          (blk.rowData || []).forEach(function (rd, i) {
            (rd.values || []).forEach(function (v, j) {
              var key = names[col_(c0 + j)];
              if (!key) return;
              var text = v.formattedValue || '', url = v.hyperlink || '';
              if (!url) {
                (v.chipRuns || []).some(function (cr) {
                  var u = cr.chip && cr.chip.richLinkProperties && cr.chip.richLinkProperties.uri;
                  if (u) { url = u; return true; }
                  return false;
                });
              }
              if (!url && /^https?:\/\//.test(String(text))) url = String(text).trim();
              if (text || url) { var k = t + '|' + (r0 + i + 1); (out[k] = out[k] || {})[key] = { text: String(text), url: url }; }
            });
          });
        });
      });
    } catch (e) { }
    return out;
  }
  async function readLog_() {
    var ids = await sheetIds_();
    if (!(LOG_TAB in ids)) return [];
    return (await vals_("'" + LOG_TAB + "'!A2:F")).map(function (r) {
      r = pad_(r, 6);
      return r[1] ? { date: serialToIso_(r[0]), client: pstr_(r[1]), type: pstr_(r[2]), summary: pstr_(r[3]), by: pstr_(r[4]), followUp: serialToIso_(r[5]) } : null;
    }).filter(function (x) { return x; });
  }

  async function getData() {
    var ranges = ['TASKS!A2:J', 'CAMPAIGNS!A2:U', 'LISTS!A2:E', "'CLIENTS & PARTNERSHIPS'!A2:R", "'BRAND OUTREACH CLIENTS'!A2:P",
      'MEETINGS!A2:J', "'ACCOUNT MANAGERS'!A2:K", "'PME CLIENTS'!A2:P", 'AGENCIES!A2:Y'];
    var q = { ranges: ranges, valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' };
    var all = await Promise.all([api('GET', '/values:batchGet', q), links_(), readLog_()]);
    var vr = all[0].valueRanges.map(function (x) { return x.values || []; }), lk = all[1], log = all[2];
    var t = vr[0], c = vr[1], l = vr[2], cp = vr[3], bo = vr[4], mt = vr[5], am = vr[6], pme = vr[7], ag = vr[8];
    var clients = [];
    cp.forEach(function (r, i) {
      r = pad_(r, 18);
      var ty = pstr_(r[3]).trim().toLowerCase();
      if (r[2]) clients.push({ src: 'Clients & Partnerships', kind: ty === 'client' ? 'Client' : ty === 'partner' ? 'Partner' : 'Prospect',
        sub: ty === 'partner' ? pstr_(r[8]) : '', row: i + 2, priority: pstr_(r[1]), name: pstr_(r[2]),
        tier: pstr_(r[4]), am: pstr_(r[5]), status: pstr_(r[6]) || 'No status', biz: pstr_(r[8]), deal: pstr_(r[9]), desc: pstr_(r[10]),
        contact: pstr_(r[13]), contactInfo: pstr_(r[14]), projects: pstr_(r[15]), notes: pstr_(r[16]) });
    });
    bo.forEach(function (r, i) {
      r = pad_(r, 16);
      if (r[2]) clients.push({ src: 'Brand Outreach', kind: 'Prospect', row: i + 2, priority: pstr_(r[1]), name: pstr_(r[2]),
        tier: pstr_(r[3]), am: pstr_(r[4]), status: pstr_(r[5]) || 'No status', biz: pstr_(r[7]), deal: pstr_(r[8]), desc: pstr_(r[9]),
        contact: pstr_(r[12]), contactInfo: pstr_(r[13]), projects: pstr_(r[14]) || pstr_(r[10]), notes: pstr_(r[15]) });
    });
    pme.forEach(function (r, i) {
      r = pad_(r, 16);
      if (r[2]) clients.push({ src: 'PME', kind: 'PME', row: i + 2, priority: pstr_(r[1]), name: pstr_(r[2]),
        tier: '', am: pstr_(r[3]), status: pstr_(r[4]) || 'No status', biz: pstr_(r[7]), deal: pstr_(r[10]), desc: '',
        contact: pstr_(r[8]), contactInfo: pstr_(r[9]), projects: '', notes: pstr_(r[5]), value: r[11], paid: r[13],
        links: lk['PME CLIENTS|' + (i + 2)] || {}, money: r[14], moneyLabel: 'Owed to us', currency: pstr_(r[12]) });
    });
    ag.forEach(function (r, i) {
      r = pad_(r, 25);
      if (r[2]) clients.push({ src: 'Agencies', kind: 'Partner', sub: 'Clipping Agency', row: i + 2, priority: pstr_(r[1]), name: pstr_(r[2]),
        tier: '', am: pstr_(r[3]), status: pstr_(r[4]) || 'No status', biz: pstr_(r[7]), deal: pstr_(r[6]), desc: pstr_(r[7]),
        contact: pstr_(r[12]), contactInfo: pstr_(r[13]), projects: pstr_(r[16]), notes: pstr_(r[14]), money: r[20], moneyLabel: 'We owe',
        currency: '', links: lk['AGENCIES|' + (i + 2)] || {} });
    });
    var meetings = [];
    mt.forEach(function (r, i) {
      r = pad_(r, 10);
      if (r[0] || r[1]) meetings.push({ row: i + 2, client: pstr_(r[0]), subject: pstr_(r[1]), status: pstr_(r[2]), date: serialToIso_(r[3]),
        time: timeStr_(r[4]), attendees: pstr_(r[5]), link: pstr_(r[6]), project: pstr_(r[7]), agenda: pstr_(r[8]), outcome: pstr_(r[9]) });
    });
    var ams = [];
    am.forEach(function (r, i) {
      r = pad_(r, 11);
      if (r[1]) ams.push({ row: i + 2, team: pstr_(r[0]), name: pstr_(r[1]), known: pstr_(r[2]), accounts: pstr_(r[3]), count: pstr_(r[4]),
        email: pstr_(r[6]), contact: pstr_(r[7]), where: pstr_(r[8]), tz: pstr_(r[9]), notes: pstr_(r[10]) });
    });
    var tasks = [];
    t.forEach(function (r, i) {
      r = pad_(r, 10);
      if (!r[2] || r[0] === true || r[1] === true) return;
      tasks.push({ row: i + 2, task: pstr_(r[2]), forName: pstr_(r[3]), type: pstr_(r[4]), owner: pstr_(r[5]), due: serialToIso_(r[6]),
        dueTime: timeStr_(r[7]), notes: pstr_(r[8]), bump: /^bump/i.test(pstr_(r[2])) });
    });
    var camps = [];
    c.forEach(function (r, i) {
      r = pad_(r, 21);
      if (!r[4]) return;
      camps.push({ row: i + 2, line: pstr_(r[1]), priority: pstr_(r[2]), code: pstr_(r[3]), name: pstr_(r[4]), lead: pstr_(r[5]),
        status: pstr_(r[6]) || 'No status', client: pstr_(r[8]), clipping: pstr_(r[9]), am: pstr_(r[20]), start: serialToIso_(r[17]),
        end: serialToIso_(r[18]), flag: r[0] === true, links: lk['CAMPAIGNS|' + (i + 2)] || {}, notes: pstr_(r[13]), next: pstr_(r[14]) });
    });
    var forOpts = [], people = [];
    l.forEach(function (r) { r = pad_(r, 5); if (r[0]) forOpts.push(pstr_(r[0])); if (r[4]) people.push(pstr_(r[4])); });
    var me = '';
    for (var i = 0; i < people.length; i++) if (email.toLowerCase().indexOf(people[i].toLowerCase()) > -1) { me = people[i]; break; }
    return { tasks: tasks, campaigns: camps, forOptions: forOpts, people: people, clients: clients, meetings: meetings, ams: ams,
      log: log, me: me, email: email, loaded: Date.now() / 1000 };
  }

  // ------------------------------------------------------------ task writes
  async function addTask(task) {
    if (!task || !task.task) throw new Error('Task name is required.');
    var row = (await vals_('TASKS!C:C')).length + 1, added = (function () { var p = nowParts(); return p.mon + ' ' + p.day; })();
    await vBatch([
      { range: 'TASKS!A' + row + ':D' + row, values: [[false, false, task.task, task.forName || 'Internal']] },
      { range: 'TASKS!F' + row + ':J' + row, values: [[task.owner || '', task.due || '', task.dueTime || '', task.notes || '', added]] }], 'USER_ENTERED');
    return { ok: true, row: row };
  }
  async function completeTask(row, expected) {
    var r = await vals_('TASKS!A' + row + ':J' + row);
    r = r.length ? pad_(r[0], 10).slice(0, 10) : [];
    if (!r.length || pstr_(r[2]) !== expected) throw new Error('Rows moved. Refresh and try again.');
    var who = (await meName_() || email || 'APP').toUpperCase(), due = serialToIso_(r[6]);
    if (/^\d{4}-\d\d-\d\d/.test(due)) due = dueFmt(due);
    await vAppend('TASK HISTORY!A:I', [[stampNow(), who, r[2], r[3], 'TASKS', r[5], due, timeStr_(r[7]), '']], 'RAW');
    await sBatch([{ deleteDimension: { range: { sheetId: await sheetId_('TASKS'), dimension: 'ROWS', startIndex: row - 1, endIndex: row } } }]);
    return { ok: true };
  }
  async function snoozeTask(row, expected, days) {
    var r = await vals_('TASKS!C' + row + ':G' + row);
    r = r.length ? pad_(r[0], 5) : [];
    if (!r.length || pstr_(r[0]) !== expected) throw new Error('Rows moved. Refresh and try again.');
    var p = nowParts(), todaySerial = Math.floor((Date.UTC(+p.year, +p.month - 1, +p.day) - Date.UTC(1899, 11, 30)) / 86400000);
    var base = (typeof r[4] === 'number' && r[4] > 30000) ? r[4] : todaySerial;
    await vUpdate('TASKS!G' + row, [[Math.floor(base) + parseInt(days, 10)]], 'RAW');
    return { ok: true };
  }
  async function setCampaignStatus(row, expected, status) {
    await check_('CAMPAIGNS', row, 'E', expected);
    await vUpdate('CAMPAIGNS!G' + row, [[status]], 'USER_ENTERED');
    return { ok: true };
  }

  // ------------------------------------------------------------ generic editing
  async function getSchema() {
    try {
      var hit = JSON.parse(sessionStorage.getItem('schema_v1') || 'null');
      if (hit && Date.now() - hit.t < 600000) return hit.v;
    } catch (e) { }
    var tabs = Object.keys(EDIT_TABS);
    var res = await api('GET', '', {
      includeGridData: 'true', ranges: tabs.map(function (t) { return "'" + t + "'!A1:AP3"; }),
      fields: 'sheets(properties.title,data.rowData.values(formattedValue,userEnteredValue,dataValidation))'
    });
    var out = {};
    res.sheets.forEach(function (sh) {
      var t = sh.properties.title, rows = ((sh.data || [{}])[0].rowData) || [];
      var hdrCells = rows.length ? (rows[0].values || []) : [];
      var hdr = hdrCells.map(function (v) { return v.formattedValue || ''; });
      var key = EDIT_TABS[t][0], blocked = EDIT_TABS[t][1], cols = [];
      hdr.forEach(function (h, i) {
        var L = col_(i), opts = null, ro = blocked.indexOf(L) > -1, kind = 'text', hv = hdrCells[i] || {};
        if (hv.userEnteredValue && 'formulaValue' in hv.userEnteredValue) ro = true;
        rows.slice(1).forEach(function (r) {
          var vs = r.values || [];
          if (i < vs.length) {
            var cell = vs[i], uev = cell.userEnteredValue || {};
            if ('formulaValue' in uev) ro = true;
            var dv = (cell.dataValidation || {}).condition || {};
            if (dv.type === 'ONE_OF_LIST') opts = (dv.values || []).map(function (x) { return x.userEnteredValue || ''; });
            else if (dv.type === 'BOOLEAN') kind = 'bool';
            else if ((dv.type || '').indexOf('DATE') === 0) kind = 'date';
          }
        });
        if (!h || h.indexOf('▸') > -1) ro = true;
        var islink = !!(LINK_COLS[t] && LINK_COLS[t][L]);
        if (islink) ro = true;
        var hu = h.toUpperCase();
        if (kind === 'text' && (hu.indexOf('DUE') > -1 || hu.indexOf('DATE') > -1 || h.indexOf('📅') > -1 || hu === 'DEADLINE')) kind = 'date';
        if (hu === '✓' || hu === 'REMOVE' || hu === '!') kind = 'bool';
        if (hu.indexOf('TIME') > -1 && hu.indexOf('ZONE') === -1) kind = 'time';
        if (opts && opts.length) kind = 'select';
        if (hu.indexOf('NOTES') > -1 || hu.indexOf('AGENDA') > -1 || hu.indexOf('OUTCOME') > -1 || hu.indexOf('DESCRIPTION') > -1) kind = kind === 'text' ? 'long' : kind;
        cols.push({ col: L, label: h, kind: kind, options: opts, readonly: ro, link: islink });
      });
      out[t] = { key: key, cols: cols };
    });
    try { sessionStorage.setItem('schema_v1', JSON.stringify({ t: Date.now(), v: out })); } catch (e) { }
    return out;
  }
  async function getRecord(tab, row) {
    var sch = (await getSchema())[tab], last = sch.cols.length ? sch.cols[sch.cols.length - 1].col : 'Z';
    var raw = await vals_("'" + tab + "'!A" + row + ':' + last + row);
    raw = raw.length ? raw[0].slice() : [];
    var out = sch.cols.map(function (c, i) {
      var v = i < raw.length ? raw[i] : '';
      if (c.kind === 'date') v = serialToIso_(v); else if (c.kind === 'time') v = timeStr_(v); else if (c.kind === 'bool') v = v === true;
      return v;
    });
    return { tab: tab, row: row, values: out, schema: sch };
  }
  async function updateCell(tab, row, expected, col, value) {
    var sch = (await getSchema())[tab], c = null;
    sch.cols.forEach(function (x) { if (x.col === col) c = x; });
    if (!c || c.readonly) throw new Error("That column is calculated by the sheet and can't be edited.");
    if (c.options && c.options.indexOf(value) === -1 && value !== '') throw new Error('"' + value + '" isn\'t one of the allowed values.');
    await check_("'" + tab + "'", row, sch.key, expected);
    await vUpdate("'" + tab + "'!" + col + row, [[value]], 'USER_ENTERED');
    return { ok: true };
  }
  async function deleteRecord(tab, row, expected) {
    var sch = (await getSchema())[tab];
    await check_("'" + tab + "'", row, sch.key, expected);
    var v = await vals_("'" + tab + "'!A" + row + ':J' + row);
    v = v.length ? pad_(v[0], 10) : pad_([], 10);
    var who = (await meName_() || email || 'APP').toUpperCase(), stamp = stampNow(), entry;
    if (tab === 'TASKS') {
      var due = serialToIso_(v[6]);
      if (/^\d{4}-\d\d-\d\d/.test(due)) due = dueFmt(due);
      entry = [stamp, who, 'REMOVED · ' + pstr_(v[2]), v[3], 'TASKS', v[5], due, timeStr_(v[7]), ''];
    } else entry = [stamp, who, 'REMOVED · ' + expected, '', tab, '', '', '', tab !== 'MEETINGS' ? pstr_(v[1]) : ''];
    await vAppend("'TASK HISTORY'!A:I", [entry], 'RAW');
    await sBatch([{ deleteDimension: { range: { sheetId: await sheetId_(tab), dimension: 'ROWS', startIndex: row - 1, endIndex: row } } }]);
    return { ok: true };
  }
  async function addRecord(tab, values) {
    var sch = (await getSchema())[tab], name = values[sch.key] || '';
    if (!String(name).trim()) throw new Error('A name is required.');
    var row = (await vals_("'" + tab + "'!" + sch.key + ':' + sch.key)).length + 1, data = [];
    sch.cols.forEach(function (c) {
      var v = values[c.col];
      if (c.readonly || !(c.col in values) || v === '' || v == null) return;
      data.push({ range: "'" + tab + "'!" + c.col + row, values: [[v]] });
    });
    sch.cols.forEach(function (c) {
      if (c.kind === 'bool' && !c.readonly && !(c.col in values)) data.push({ range: "'" + tab + "'!" + c.col + row, values: [[false]] });
    });
    await vBatch(data, 'USER_ENTERED');
    return { ok: true, row: row };
  }

  // ------------------------------------------------------------ CRM
  async function ensureLogTab_() {
    if (LOG_TAB in await sheetIds_()) return;
    await sBatch([{ addSheet: { properties: { title: LOG_TAB, gridProperties: { frozenRowCount: 1 } } } }]);
    await vUpdate("'" + LOG_TAB + "'!A1:F1", [['DATE', 'NAME', 'TYPE', 'SUMMARY', 'BY', 'FOLLOW-UP']], 'RAW');
  }
  async function addLog(entry) {
    if (!entry || !entry.client) throw new Error('Client is required.');
    await ensureLogTab_();
    var who = (await meName_()) || email;
    await vAppend("'" + LOG_TAB + "'!A:F", [[dateNow(), entry.client, entry.type || 'Note', entry.summary || '', who, entry.followUp || '']], 'USER_ENTERED');
    return { ok: true };
  }
  async function setClientStatus(src, row, expected, status) {
    var tc_ = CLIENT_TABS[src], tab = tc_[0], col = tc_[1];
    await check_("'" + tab + "'", row, 'C', expected);
    await vUpdate("'" + tab + "'!" + col + row, [[status]], 'USER_ENTERED');
    return { ok: true };
  }
  async function setLink(tab, row, expected, col, url) {
    var key = (LINK_COLS[tab] || {})[col];
    if (!key) throw new Error('That column is not a link column.');
    url = String(url || '').trim();
    if (url && !/^https?:\/\//i.test(url)) throw new Error('Paste a full web link starting with http:// or https://');
    await check_("'" + tab + "'", row, EDIT_TABS[tab][0], expected);
    var ci = colNum_(col), cell = {};
    if (url) cell = { userEnteredValue: { stringValue: LINK_LABEL[key] }, textFormatRuns: [{ startIndex: 0, format: { link: { uri: url } } }] };
    await sBatch([{ updateCells: { range: { sheetId: await sheetId_(tab), startRowIndex: row - 1, endRowIndex: row, startColumnIndex: ci, endColumnIndex: ci + 1 },
      rows: [{ values: [cell] }], fields: 'userEnteredValue,textFormatRuns' } }]);
    return { ok: true };
  }

  // ------------------------------------------------------------ dev backlog (shared in the sheet)
  var BACKLOG_SEED = '# INNRVZN Seer: dev backlog\n\n## Data (sheet)\n- [ ] Add items here\n';
  async function getBacklog() {
    if (!(BACKLOG_TAB in await sheetIds_())) {
      await sBatch([{ addSheet: { properties: { title: BACKLOG_TAB } } }]);
      await vUpdate("'" + BACKLOG_TAB + "'!A1", [[BACKLOG_SEED]], 'RAW');
    }
    var v = await vals_("'" + BACKLOG_TAB + "'!A1");
    return { text: v.length && v[0].length ? pstr_(v[0][0]) : BACKLOG_SEED, path: 'Sheet tab: ' + BACKLOG_TAB };
  }
  async function saveBacklog(text) {
    await getBacklog();
    await vUpdate("'" + BACKLOG_TAB + "'!A1", [[String(text)]], 'RAW');
    return { ok: true };
  }

  // ------------------------------------------------------------ browser-side stand-ins for desktop calls
  var A = {
    getData: getData, addTask: addTask, completeTask: completeTask, snoozeTask: snoozeTask, setCampaignStatus: setCampaignStatus,
    getSchema: getSchema, getRecord: getRecord, updateCell: updateCell, deleteRecord: deleteRecord, addRecord: addRecord,
    addLog: addLog, setClientStatus: setClientStatus, setLink: setLink, getBacklog: getBacklog, saveBacklog: saveBacklog,
    setBackdrop: function () { return Promise.resolve({ ok: true, skipped: true }); },
    getBackdrop: function () { return Promise.resolve({ mode: 'solid', theme: 'dark' }); },
    endSplash: function () { return Promise.resolve({ ok: true }); },
    splashPlate: function () { return Promise.resolve({ ok: false }); },
    openUrl: function (u) { window.open(u, '_blank', 'noopener'); return Promise.resolve({ ok: true }); },
    log: function () { return Promise.resolve({ ok: true }); },
    getWorkspace: function () { var w = lsGet('ta_ws'); return Promise.resolve(w === 'plus' || w === 'music' ? w : ''); },
    setWorkspace: function (ws) { if (ws !== 'plus' && ws !== 'music') return Promise.reject(new Error('Unknown workspace')); lsSet('ta_ws', ws); return Promise.resolve({ ok: true }); },
    signOut: function () {
      try { if (token && window.google && google.accounts) google.accounts.oauth2.revoke(token, function () { }); } catch (e) { }
      token = ''; lsSet('ta_signed', ''); try { sessionStorage.clear(); } catch (e) { }
      setTimeout(function () { location.reload(); }, 150);
      return Promise.resolve({ ok: true });
    }
  };
  window.__api = A;
})();
