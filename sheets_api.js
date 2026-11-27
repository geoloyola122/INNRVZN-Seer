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
  var SCOPE = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive';
  var WEB_VERSION = '2026.11.27.0743';   // stamped by release.py
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  var LINK_COLS = {
    'CAMPAIGNS': { L: 'master', M: 'deck', AD: 'infl', AO: 'bill', AP: 'folder' },
    'PME CLIENTS': { Q: 'bill', R: 'folder' },
    'AGENCIES': { Z: 'bill', AA: 'folder' },
    'CLIENTS & PARTNERSHIPS': { AE: 'folder' },
    'BRAND OUTREACH CLIENTS': { AD: 'folder' }
  };
  var FOLDER_COL = { 'CAMPAIGNS': 'AP', 'PME CLIENTS': 'R', 'AGENCIES': 'AA', 'CLIENTS & PARTNERSHIPS': 'AE', 'BRAND OUTREACH CLIENTS': 'AD' };
  var LINK_LABEL = { master: 'Master file', deck: 'Deck', infl: 'Influencers', bill: 'Billing', folder: 'Folder' };
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
  // remember the session across reloads / app restarts: reuse the saved token until it expires, and the account for re-sign-in
  (function () { var t = lsGet('ta_tok'), x = +lsGet('ta_exp') || 0; if (t && Date.now() < x) { token = t; tokenExp = x; } var p = null; try { p = JSON.parse(lsGet('seer.profile') || 'null'); } catch (e) { } email = (p && p.email) || ''; })();

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
  // ------------------------------------------------------------ Profiles instead of Google sign-in.
  // The Seer Apps Script (runs as SEER.innrvzn@gmail.com) lists the team and hands out a short-lived Seer key.
  var RELAY = 'https://script.google.com/macros/s/AKfycbwy5PgwEXgDL7z5Jb2uKE7-isc-8ly-Y7UK5ydcAdd4LSLKOMD98Zoo8Y03nHhVQQuGEw/exec',
    RELAY_KEY = 'fUE0mi0P-xuwofPZyZVtqDqwYB9RaF9s';
  function relay(action, extra) {
    var body = Object.assign({ key: RELAY_KEY, action: action }, extra || {});
    return fetch(RELAY, { method: 'POST', body: JSON.stringify(body) }).then(function (r) { return r.json(); })
      .then(function (o) { if (!o || !o.ok) throw new Error((o && o.error) || 'Seer server refused the request'); return o; });
  }
  function profile() { try { return JSON.parse(lsGet('seer.profile') || 'null'); } catch (e) { return null; } }
  function ensureToken() {
    if (CFG.NO_AUTH) return Promise.resolve('');
    var pr = profile();
    if (!pr || !pr.email) return Promise.reject(new Error('SIGNIN_REQUIRED: Pick your profile.'));
    email = pr.email;
    if (token && Date.now() < tokenExp) return Promise.resolve(token);
    if (pending) return pending;
    pending = relay('token').then(function (o) {
      token = o.token; tokenExp = Date.now() + ((o.expiresIn || 3000) - 60) * 1000;
      lsSet('ta_tok', token); lsSet('ta_exp', String(tokenExp)); return token;
    }).finally(function () { pending = null; });
    return pending;
  }
  window.__signin = function () { };

  // ------------------------------------------------------------ REST helpers
  function qs(o) {
    var p = new URLSearchParams();
    Object.keys(o || {}).forEach(function (k) {
      [].concat(o[k]).forEach(function (v) { if (v !== undefined) p.append(k, v); });
    });
    var s = p.toString();
    return s ? '?' + s : '';
  }
  var CRED_ID = CFG.CREDENTIALS_SHEET_ID || '1K8ZtXLIb45AZkAolzjycjY-Uaj1ErXGpCgo2y35BqoU', ACCESS = null, accessP = null;
  function normEmail_(e) {
    e = String(e || '').trim().toLowerCase(); var p = e.split('@'); if (p.length < 2) return e;
    var l = p[0].split('+')[0], d = p[1]; if (d === 'gmail.com' || d === 'googlemail.com') { l = l.replace(/\./g, ''); d = 'gmail.com'; } return l + '@' + d;
  }
  function accessFrom_(rows, mail) {
    var key = normEmail_(mail);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i] || []; if (!key || normEmail_(r[0]) !== key) continue;
      if (/^(no|false|off|0|inactive)$/i.test(String(r[3] || '').trim())) return { ok: false, reason: 'This account has been switched off. Ask an admin.' };
      return { ok: true, name: String(r[1] || '').trim(), role: String(r[2] || '').trim() || 'Member', email: mail };
    }
    return { ok: false, reason: 'This Google account (' + (mail || 'unknown') + ') is not on the Seer team.' };
  }
  function accessCheck_() {
    if (CFG.NO_AUTH) return Promise.resolve({ ok: true });
    if (!accessP) accessP = (async function () {
      var rows;
      try { rows = (await apiOn(CRED_ID, 'GET', '/values/' + encodeURIComponent('USERS!A2:E'), { valueRenderOption: 'FORMATTED_VALUE' })).values || []; }
      catch (e) {
        accessP = null;
        if (/403|404|not found|permission|shared with your/i.test(String(e && e.message || e))) { ACCESS = { ok: false, reason: 'This Google account (' + (email || 'unknown') + ') is not on the Seer team.' }; accessP = Promise.resolve(ACCESS); return ACCESS; }
        throw e;
      }
      ACCESS = accessFrom_(rows, email); return ACCESS;
    })();
    return accessP;
  }
  async function apiOn(sid, method, path, query, body, retried) {
    if (sid !== CRED_ID) { var ac = await accessCheck_(); if (!ac.ok) throw new Error('NO_ACCESS: ' + ac.reason); }
    var t = await ensureToken();
    var headers = { 'Content-Type': 'application/json' };
    if (t) headers.Authorization = 'Bearer ' + t;
    var r = await fetch(BASE + '/' + sid + path + qs(query), { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401 && !retried && !CFG.NO_AUTH) { token = ''; return apiOn(sid, method, path, query, body, true); }
    if (!r.ok) {
      var j = null; try { j = await r.json(); } catch (e) { }
      var msg = (j && j.error && j.error.message) || ('Google Sheets returned ' + r.status);
      if (r.status === 403) msg += ' (is the sheet shared with your Google account?)';
      throw new Error(msg);
    }
    return r.json();
  }
  function api(method, path, query, body, retried) { return apiOn(SHEET_ID, method, path, query, body, retried); }
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
    if (ACCESS && ACCESS.ok && ACCESS.name) { var pp = await people_(); if (pp.indexOf(ACCESS.name) > -1) return ACCESS.name; }
    var loc = (email || '').toLowerCase().split('@')[0].replace(/[^a-z0-9]/g, ''), p = await people_(), cl = function (s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); };
    for (var i = 0; i < p.length; i++) if (cl(p[i]) && loc.indexOf(cl(p[i])) > -1) return p[i];
    for (var j = 0; j < p.length; j++) { var f = cl(String(p[j]).split(/\s+/)[0]); if (f && loc.indexOf(f) > -1) return p[j]; }
    return '';
  }

  // ------------------------------------------------------------ reads
  async function links_() {
    var out = {};
    try {
      var specs = [['CAMPAIGNS', 'L2:M'], ['CAMPAIGNS', 'AD2:AD'], ['CAMPAIGNS', 'AO2:AP'], ['PME CLIENTS', 'Q2:R'], ['AGENCIES', 'Z2:AA'],
        ['CLIENTS & PARTNERSHIPS', 'AE2:AE'], ['BRAND OUTREACH CLIENTS', 'AD2:AD']];
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
    var ranges = ['TASKS!A2:M', 'CAMPAIGNS!A2:AS', 'LISTS!A2:E', "'CLIENTS & PARTNERSHIPS'!A2:R", "'BRAND OUTREACH CLIENTS'!A2:P",
      'MEETINGS!A2:O', "'ACCOUNT MANAGERS'!A2:K", "'PME CLIENTS'!A2:P", 'AGENCIES!A2:Y'];
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
        contact: pstr_(r[13]), contactInfo: pstr_(r[14]), projects: pstr_(r[15]), notes: pstr_(r[16]), links: lk['CLIENTS & PARTNERSHIPS|' + (i + 2)] || {} });
    });
    bo.forEach(function (r, i) {
      r = pad_(r, 16);
      if (r[2]) clients.push({ src: 'Brand Outreach', kind: 'Prospect', row: i + 2, priority: pstr_(r[1]), name: pstr_(r[2]),
        tier: pstr_(r[3]), am: pstr_(r[4]), status: pstr_(r[5]) || 'No status', biz: pstr_(r[7]), deal: pstr_(r[8]), desc: pstr_(r[9]),
        contact: pstr_(r[12]), contactInfo: pstr_(r[13]), projects: pstr_(r[14]) || pstr_(r[10]), notes: pstr_(r[15]), links: lk['BRAND OUTREACH CLIENTS|' + (i + 2)] || {} });
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
      r = pad_(r, 15);
      if (r[0] || r[1]) meetings.push({ row: i + 2, client: pstr_(r[0]), subject: pstr_(r[1]), status: pstr_(r[2]), date: serialToIso_(r[3]),
        time: timeStr_(r[4]), attendees: pstr_(r[5]), link: pstr_(r[6]), project: pstr_(r[7]), agenda: pstr_(r[8]), outcome: pstr_(r[9]),
        end: timeStr_(r[11]), category: pstr_(r[12]), reminder: pstr_(r[13]), by: pstr_(r[14]) });
    });
    var ams = [];
    am.forEach(function (r, i) {
      r = pad_(r, 11);
      if (r[1]) ams.push({ row: i + 2, team: pstr_(r[0]), name: pstr_(r[1]), known: pstr_(r[2]), accounts: pstr_(r[3]), count: pstr_(r[4]),
        email: pstr_(r[6]), contact: pstr_(r[7]), where: pstr_(r[8]), tz: pstr_(r[9]), notes: pstr_(r[10]) });
    });
    var tasks = [];
    t.forEach(function (r, i) {
      r = pad_(r, 13);
      if (!r[2] || r[0] === true || r[1] === true) return;
      tasks.push({ row: i + 2, task: pstr_(r[2]), forName: pstr_(r[3]), type: pstr_(r[4]), owner: pstr_(r[5]), due: serialToIso_(r[6]),
        dueTime: timeStr_(r[7]), notes: pstr_(r[8]), bump: /^bump/i.test(pstr_(r[2])), deliv: r[10] === true, delivUrl: pstr_(r[11]).trim(), added: serialToIso_(r[9]), addedBy: pstr_(r[12]).trim() });
    });
    var camps = [];
    c.forEach(function (r, i) {
      r = pad_(r, 45);
      if (!r[4]) return;
      camps.push({ row: i + 2, line: pstr_(r[1]), priority: pstr_(r[2]), code: pstr_(r[3]), name: pstr_(r[4]), lead: pstr_(r[5]),
        type: pstr_(r[42]).trim(), parent: pstr_(r[43]).trim(), payment: pstr_(r[44]).trim(),
        status: pstr_(r[6]) || 'No status', client: pstr_(r[8]), clipping: pstr_(r[9]), am: pstr_(r[20]), start: serialToIso_(r[17]),
        end: serialToIso_(r[18]), flag: r[0] === true, links: lk['CAMPAIGNS|' + (i + 2)] || {}, notes: pstr_(r[13]), next: pstr_(r[14]) });
    });
    var forOpts = [], people = [];
    l.forEach(function (r) { r = pad_(r, 5); if (r[0]) forOpts.push(pstr_(r[0])); if (r[4]) people.push(pstr_(r[4])); });
    var me = '';
    if (ACCESS && ACCESS.ok && ACCESS.name && people.indexOf(ACCESS.name) > -1) me = ACCESS.name;
    else {
      var loc = (email || '').toLowerCase().split('@')[0].replace(/[^a-z0-9]/g, ''), cl = function (x) { return String(x).toLowerCase().replace(/[^a-z0-9]/g, ''); };
      for (var i = 0; i < people.length && !me; i++) if (cl(people[i]) && loc.indexOf(cl(people[i])) > -1) me = people[i];
      for (var j = 0; j < people.length && !me; j++) { var f = cl(String(people[j]).split(/\s+/)[0]); if (f && loc.indexOf(f) > -1) me = people[j]; }
    }
    return { tasks: tasks, campaigns: camps, forOptions: forOpts, people: people, clients: clients, meetings: meetings, ams: ams,
      log: log, me: me, email: email, loaded: Date.now() / 1000 };
  }

  // ------------------------------------------------------------ task writes
  async function addTask(task) {
    if (!task || !task.task) throw new Error('Task name is required.');
    var row = (await vals_('TASKS!C:C')).length + 1, added = dateNow(), by = (await meName_()) || email;
    await vBatch([
      { range: 'TASKS!A' + row + ':D' + row, values: [[false, false, task.task, task.forName || 'Internal']] },
      { range: 'TASKS!F' + row + ':J' + row, values: [[task.owner || '', task.due || '', task.dueTime || '', task.notes || '', added]] },
      { range: 'TASKS!M' + row, values: [[by]] }], 'USER_ENTERED');
    return { ok: true, row: row };
  }
  async function completeTask(row, expected, deliverable) {
    var r = await vals_('TASKS!A' + row + ':L' + row);
    r = r.length ? pad_(r[0], 12).slice(0, 12) : [];
    if (!r.length || pstr_(r[2]) !== expected) throw new Error('Rows moved. Refresh and try again.');
    deliverable = String(deliverable || pstr_(r[11]) || '').trim();
    if (r[10] === true && !deliverable) throw new Error('This task is deliverable-sensitive: submit the deliverable to complete it.');
    var who = (await meName_() || email || 'APP'), due = serialToIso_(r[6]);
    if (/^\d{4}-\d\d-\d\d/.test(due)) due = dueFmt(due);
    await vAppend('TASK HISTORY!A:J', [[stampNow(), who, r[2], r[3], 'TASKS', r[5], due, timeStr_(r[7]), '', deliverable]], 'RAW');
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
    var who = (await meName_() || email || 'APP'), stamp = stampNow(), entry;
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
    var row = (await vals_("'" + tab + "'!" + sch.key + ':' + sch.key)).length + 1, data = [], gen = CODE_COLS[tab];
    if (gen) {                                   // project codes: blank = next free PLS number, typed = must be unused
      var typed = String(values[gen[0]] || '').trim().toUpperCase(), used = await codeList_(tab);
      if (typed && used.indexOf(typed) > -1) throw new Error('Code ' + typed + ' is already used. Leave it blank to get the next one.');
      values = Object.assign({}, values); values[gen[0]] = typed || await nextCode_(tab);
    }
    sch.cols.forEach(function (c) {
      var v = values[c.col];
      if (c.readonly || !(c.col in values) || v === '' || v == null) return;
      data.push({ range: "'" + tab + "'!" + c.col + row, values: [[v]] });
    });
    sch.cols.forEach(function (c) {
      if (c.kind === 'bool' && !c.readonly && !(c.col in values)) data.push({ range: "'" + tab + "'!" + c.col + row, values: [[false]] });
    });
    await vBatch(data, 'USER_ENTERED');
    if (gen) {                                   // two people adding at once could pick the same number: the later row takes the next one
      var after = await codeList_(tab, true), mine = values[gen[0]];
      if (mine && after.filter(function (x) { return x === mine; }).length > 1 && after.indexOf(mine) + 2 !== row) {
        values[gen[0]] = await nextCode_(tab);
        await vUpdate("'" + tab + "'!" + gen[0] + row, [[values[gen[0]]]], 'RAW');
      }
    }
    return { ok: true, row: row, code: gen ? values[gen[0]] : '' };
  }

  // ------------------------------------------------------------ calendar / meetings (one record per meeting: the MEETINGS tab)
  var MEET_STATUS = ['To Set', 'To Bump', 'Confirmed', 'Canceled'], MEET_CATS = ['Meeting', 'Internal Discussion', 'Project Deadline', 'Production Schedule', 'General Event'],
    MEET_REMS = ['None', '15 minutes before', '1 hour before', '1 day before'];
  function tmins_(s) {
    var m = String(s || '').match(/^\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i);
    return m ? ((+m[1] % 12) + (/pm/i.test(m[3]) ? 12 : 0)) * 60 + (+m[2]) : null;
  }
  function meetCheck_(e) {
    var title = String(e.title || '').trim();
    if (!title) throw new Error('Give the meeting a title.');
    var date = String(e.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Pick a date.');
    var start = String(e.time || '').trim(), end = String(e.endTime || '').trim();
    if (start && tmins_(start) === null) throw new Error('The start time looks wrong. Use a time like 3:30 PM.');
    if (end && !start) throw new Error('Add a start time before the end time.');
    if (end && (tmins_(end) === null || tmins_(end) <= tmins_(start))) throw new Error('The end time must be after the start time.');
    return { title: title, date: date, start: start, end: end };
  }
  async function meetingSave(e) {
    var c = meetCheck_(e), status = String(e.status || (c.start ? 'Confirmed' : 'To Set'));
    if (MEET_STATUS.indexOf(status) < 0) throw new Error('Unknown status.');
    var cat = MEET_CATS.indexOf(e.category) > -1 ? e.category : 'Meeting', rem = MEET_REMS.indexOf(e.reminder) > -1 ? e.reminder : 'None';
    var project = String(e.project || '').trim(), row = e.row ? +e.row : null;
    var rows = await vals_("'MEETINGS'!A2:H");
    if (!e.force) rows.forEach(function (r, i) {
      r = pad_(r, 8);
      if (row === i + 2 || pstr_(r[2]) === 'Canceled') return;
      if (pstr_(r[1]).trim().toLowerCase() === c.title.toLowerCase() && serialToIso_(r[3]) === c.date && timeStr_(r[4]) === c.start && pstr_(r[7]).trim().toLowerCase() === project.toLowerCase())
        throw new Error('DUPLICATE: "' + c.title + '" is already scheduled at that time. Save it anyway?');
    });
    var who = (await meName_()) || email;
    if (row) await check_("'MEETINGS'", row, 'B', e.expected);
    else row = (await vals_("'MEETINGS'!B:B")).length + 1;
    var f = { A: String(e.client || (project ? '' : 'Internal')).trim(), B: c.title, C: status, D: c.date, E: c.start, F: String(e.attendees || ''), G: String(e.place || ''),
      H: project, I: String(e.agenda || ''), L: c.end, M: cat, N: rem }, data = Object.keys(f).map(function (k) { return { range: "'MEETINGS'!" + k + row, values: [[f[k]]] }; });
    if ('outcome' in e) data.push({ range: "'MEETINGS'!J" + row, values: [[String(e.outcome || '')]] });
    if (!e.row) {
      data.push({ range: "'MEETINGS'!O" + row, values: [[who]] });
      data.push({ range: "'MEETINGS'!K" + row, values: [['=IF(AND($A' + row + '="",$B' + row + '=""),"",IFERROR(MATCH($C' + row + ',{"Confirmed";"To Bump";"To Set";"Canceled"},0),5)*100000+IF(ISNUMBER($D' + row + '),$D' + row + '+IFERROR(TIMEVALUE($E' + row + '&""),0.9999),99999))']] });
    }
    await vBatch(data, 'USER_ENTERED');
    return { ok: true, row: row };
  }
  async function meetingMove(row, expected, date, time, endTime) {
    meetCheck_({ title: expected, date: date, time: time, endTime: endTime });
    await check_("'MEETINGS'", row, 'B', expected);
    await vBatch([{ range: "'MEETINGS'!D" + row, values: [[date]] }, { range: "'MEETINGS'!E" + row, values: [[time || '']] }, { range: "'MEETINGS'!L" + row, values: [[endTime || '']] }], 'USER_ENTERED');
    return { ok: true };
  }

  // ------------------------------------------------------------ project codes
  var CODE_COLS = { 'CAMPAIGNS': ['D', 'PLS', 4] };
  async function codeList_(tab, keepBlanks) {
    var col = CODE_COLS[tab][0], rows = await vals_("'" + tab + "'!" + col + '2:' + col);
    var all = rows.map(function (r) { return r && r.length ? pstr_(r[0]).trim().toUpperCase() : ''; });
    return keepBlanks ? all : all.filter(function (x) { return x; });
  }
  async function nextCode_(tab) {                // highest existing PLS number + 1 (gaps stay: a used number is never reissued)
    var g = CODE_COLS[tab], max = 0, re = new RegExp('^' + g[1] + '(\\d+)$', 'i');
    (await codeList_(tab)).forEach(function (x) { var m = re.exec(x); if (m) max = Math.max(max, parseInt(m[1], 10)); });
    return g[1] + String(max + 1).padStart(g[2], '0');
  }
  async function nextCode(tab) { tab = tab || 'CAMPAIGNS'; return { code: CODE_COLS[tab] ? await nextCode_(tab) : '' }; }

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
  var REPORTS_ID = CFG.REPORTS_SHEET_ID || '1swif2gvwYU8a91sHUr_Aj2bRNRpVj8rT0QAuU_edcwQ';
  async function connections() {
    var defs = [['INNRVZN Plus', 'Tasks, clients, campaigns, meetings', SHEET_ID], ['INNRVZN Music', 'Music projects and tasks', MUSIC_ID],
      ['INNRVZN Label', 'Artists, songs, releases, stats, playlists', LABEL_ID], ['INNRVZN Reports', 'Dashboard report form', REPORTS_ID], ['INNRVZN Credentials', 'Who may use Seer (admins edit)', CRED_ID]];
    var items = await Promise.all(defs.map(async function (d) {
      var row = { name: d[0], what: d[1], url: 'https://docs.google.com/spreadsheets/d/' + d[2] + '/edit' };
      try { var m = await apiOn(d[2], 'GET', '', { fields: 'properties.title' }); row.ok = true; row.title = m.properties.title; }
      catch (e) { row.ok = false; row.error = /403|404/.test(String(e && e.message || e)) ? 'No access: share this sheet with ' + (email || 'your account') : String(e && e.message || e).slice(0, 120); }
      return row;
    }));
    return { account: email, items: items };
  }
  async function reportsData() {
    var rows = await sv_(REPORTS_ID, 'REPORTS!A2:K'), out = [], me = String((await meName_()) || '').trim().toLowerCase(), em = String(email || '').toLowerCase();
    rows.forEach(function (r, i) {
      r = pad_(r, 11);
      if (pstr_(r[4]).trim()) out.push({ rid: pstr_(r[10]).trim(), row: i + 2, date: pstr_(r[0]).slice(0, 10), by: pstr_(r[1]), added: pstr_(r[5]), meeting: pstr_(r[7]),
        seen: pstr_(r[8]).split('|').map(function (t) { return t.trim(); }).filter(Boolean), done: pstr_(r[9]).split('|').map(function (t) { return t.trim(); }).filter(Boolean),
        tags: pstr_(r[2]).split('|').map(function (t) { return t.trim(); }).filter(Boolean),
        people: pstr_(r[3]).split('|').map(function (t) { return t.trim(); }).filter(Boolean), text: pstr_(r[4]),
        mine: !!((pstr_(r[6]).trim() && pstr_(r[6]).trim().toLowerCase() === em) || (me && pstr_(r[1]).trim().toLowerCase() === me)) });
    });
    return { reports: out };
  }
  async function reportAdd(entry) {
    var text = String((entry && entry.text) || '').trim();
    if (!text) throw new Error('Write the report first.');
    var who = (await meName_()) || email, day = String(entry.date || dateNow()).slice(0, 10), n = new Date();
    var r = await sAppend_(REPORTS_ID, 'REPORTS!A:G', [[day, who, (entry.tags || []).join(' | '), (entry.people || []).join(' | '), text,
      dateNow() + ' ' + ('0' + n.getHours()).slice(-2) + ':' + ('0' + n.getMinutes()).slice(-2), email || '']]);
    var m = /!A(\d+)/.exec(((r && r.updates) || {}).updatedRange || '');
    if (m && entry.rid) await apiOn(REPORTS_ID, 'PUT', '/values/' + encodeURIComponent('REPORTS!K' + m[1]), { valueInputOption: 'RAW' }, { values: [[String(entry.rid)]] });
    return { ok: true, row: m ? +m[1] : null };
  }
  async function repRow_(row, expected, own) {
    var r = pad_((await sv_(REPORTS_ID, 'REPORTS!A' + row + ':H' + row))[0] || [], 8);
    if (pstr_(r[4]).trim() !== String(expected).trim()) throw new Error('That report changed or moved. Refresh and try again.');
    if (own) { var me = String((await meName_()) || '').trim().toLowerCase(), em = String(email || '').toLowerCase();
      if (!((pstr_(r[6]).trim().toLowerCase() === em && em) || (me && pstr_(r[1]).trim().toLowerCase() === me))) throw new Error('Only the person who wrote this report can change or delete it.'); }
    return r.slice(0, 8).map(pstr_);
  }
  async function reportEdit(row, expected, entry) {
    var text = String((entry && entry.text) || '').trim(); if (!text) throw new Error('The report cannot be empty.');
    await repRow_(row, expected, false);   // anyone may edit; delete stays with the author
    await sUpdate_(REPORTS_ID, 'REPORTS!C' + row + ':E' + row, [[(entry.tags || []).join(' | '), (entry.people || []).join(' | '), text]]);
    return { ok: true };
  }
  async function reportDelete(row, expected) {
    var old = await repRow_(row, expected, true), n = new Date();
    await sAppend_(REPORTS_ID, 'REMOVED!A:J', [old.concat([(await meName_()) || email, dateNow() + ' ' + ('0' + n.getHours()).slice(-2) + ':' + ('0' + n.getMinutes()).slice(-2)])]);
    await sDelRow_(REPORTS_ID, 'REPORTS', row);
    return { ok: true };
  }
  async function reportMark(row, expected, kind, on) {
    var col = { seen: 'I', done: 'J' }[kind]; await repRow_(row, expected, false);
    var me = (await meName_()) || email, cur = pstr_(((await sv_(REPORTS_ID, 'REPORTS!' + col + row))[0] || [''])[0]);
    var names = cur.split('|').map(function (t) { return t.trim(); }).filter(function (n) { return n && n.toLowerCase() !== me.toLowerCase(); });
    if (on !== false) names.push(me);
    await apiOn(REPORTS_ID, 'PUT', '/values/' + encodeURIComponent('REPORTS!' + col + row), { valueInputOption: 'RAW' }, { values: [[names.join(' | ')]] });
    return { ok: true };
  }
  async function reportMeeting(row, expected, label) {
    await repRow_(row, expected, false);
    await sUpdate_(REPORTS_ID, 'REPORTS!H' + row, [[String(label).slice(0, 200)]]);
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

  // ---------------------------------------------------------------- Google Drive: settings, folders, deliverables (same rules as the desktop app)
  var FOLDER_MIME = 'application/vnd.google-apps.folder';
  async function drv(method, path, query, body, raw, retried) {
    var t = await ensureToken();
    var o = { method: method, headers: {} };
    if (t) o.headers.Authorization = 'Bearer ' + t;
    if (raw) { o.headers['Content-Type'] = raw.type; o.body = raw.body; }
    else if (body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    var base = raw ? 'https://www.googleapis.com/upload/drive/v3' : 'https://www.googleapis.com/drive/v3';
    var r = await fetch(base + path + qs(Object.assign({ supportsAllDrives: true }, query || {})), o);
    if ((r.status === 401 || r.status === 403) && !retried) {          // old sign-in without Drive: ask again once
      var j0 = null; try { j0 = await r.clone().json(); } catch (e) { }
      if (r.status === 401 || /scope/i.test(JSON.stringify(j0 || ''))) { token = ''; return drv(method, path, query, body, raw, true); }
    }
    if (!r.ok) { var j = null; try { j = await r.json(); } catch (e) { } throw new Error((j && j.error && j.error.message) || ('Google Drive returned ' + r.status)); }
    return r.json();
  }
  async function settings_() {
    if (!((await sheetIds_())['SETTINGS'] >= 0)) return {};
    var o = {};
    (await vals_("'SETTINGS'!A2:B")).forEach(function (r) { if (r && pstr_(r[0]).trim()) o[pstr_(r[0]).trim()] = r.length > 1 ? pstr_(r[1]) : ''; });
    return o;
  }
  async function setSetting_(key, value) {
    if (!((await sheetIds_())['SETTINGS'] >= 0)) {
      await sBatch([{ addSheet: { properties: { title: 'SETTINGS', gridProperties: { frozenRowCount: 1 } } } }]);
      await vUpdate("'SETTINGS'!A1:C1", [['KEY', 'VALUE', 'NOTE']], 'RAW');
    }
    var keys = (await vals_("'SETTINGS'!A2:A")).map(function (r) { return r && r.length ? pstr_(r[0]).trim() : ''; });
    var i = keys.indexOf(key), row = i > -1 ? i + 2 : keys.length + 2;
    await vUpdate("'SETTINGS'!A" + row + ':C' + row, [[key, value, 'Set from INNRVZN Seer > More > Settings']], 'RAW');
  }
  function folderOut_(f) { return { id: f.id, name: f.name || '', url: f.webViewLink || 'https://drive.google.com/drive/folders/' + f.id, owner: ((f.owners || [{}])[0] || {}).emailAddress || '' }; }
  function folderId_(s) {
    s = String(s || '').trim();
    var m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
    if (m) return m[1];
    if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
    throw new Error('Paste a Google Drive folder link.');
  }
  function q_(s) { var BS = String.fromCharCode(92); return String(s).split(BS).join('').split("'").join(BS + "'"); }
  async function driveStatus() {
    var rootId = (await settings_())['DRIVE_ROOT'] || '';
    var out = { connected: true, web: true, email: '', root: null, rootId: rootId, error: '' };
    try { out.email = (await drv('GET', '/about', { fields: 'user(emailAddress)' })).user.emailAddress; } catch (e) { }
    if (rootId) {
      try { var f = await drv('GET', '/files/' + rootId, { fields: 'id,name,webViewLink,owners(emailAddress),trashed' }); out.root = folderOut_(f); if (f.trashed) out.error = 'This folder is in the Drive trash.'; }
      catch (e) { out.error = "This Google account can't open the saved folder. Ask its owner to share it with you."; }
    }
    return out;
  }
  async function driveFind(name) {
    var r = await drv('GET', '/files', { q: "mimeType='" + FOLDER_MIME + "' and trashed=false and name='" + q_(name || 'INNRVZN Plus') + "'",
      fields: 'files(id,name,webViewLink,owners(emailAddress))', pageSize: 20, includeItemsFromAllDrives: true });
    return (r.files || []).map(folderOut_);
  }
  async function driveSetRoot(link) {
    var id = folderId_(link), f;
    try { f = await drv('GET', '/files/' + id, { fields: 'id,mimeType' }); } catch (e) { throw new Error("That folder can't be opened with this Google account."); }
    if (f.mimeType !== FOLDER_MIME) throw new Error('That link is a file, not a folder.');
    await setSetting_('DRIVE_ROOT', id);
    return driveStatus();
  }
  async function driveCreateRoot(name) {
    var f = await drv('POST', '/files', { fields: 'id' }, { name: String(name || '').trim() || 'INNRVZN Plus', mimeType: FOLDER_MIME });
    await setSetting_('DRIVE_ROOT', f.id);
    return driveStatus();
  }
  async function root_() {
    var id = (await settings_())['DRIVE_ROOT'] || '';
    if (!id) throw new Error('No main Drive folder is set. Choose one in More > Settings.');
    return id;
  }
  async function sub_(parent, name) {
    var r = await drv('GET', '/files', { q: "'" + parent + "' in parents and mimeType='" + FOLDER_MIME + "' and trashed=false and name='" + q_(name) + "'",
      fields: 'files(id,webViewLink)', pageSize: 1, includeItemsFromAllDrives: true });
    if (r.files && r.files.length) return r.files[0];
    return drv('POST', '/files', { fields: 'id,webViewLink' }, { name: name, mimeType: FOLDER_MIME, parents: [parent] });
  }
  async function ensureFolder_(tab, row, expected) {
    var col = FOLDER_COL[tab];
    if (!col) throw new Error('This tab has no folder column.');
    var root = await root_();
    await check_("'" + tab + "'", row, EDIT_TABS[tab][0], expected);
    var cur = (((await links_())[tab + '|' + row]) || {}).folder || {};
    var m = String(cur.url || '').match(/\/folders\/([A-Za-z0-9_-]{10,})/);
    if (m) return { id: m[1], url: cur.url, created: false };
    var name, group;
    if (tab === 'CAMPAIGNS') { var code = pstr_(((await vals_('CAMPAIGNS!D' + row))[0] || [''])[0]).trim(); name = (code ? code + ' · ' : '') + expected; group = 'Projects'; }
    else { name = expected; group = 'Clients'; }
    name = name.replace(/[\\\/]+/g, '-').trim();
    var f = await sub_((await sub_(root, group)).id, name);
    var url = f.webViewLink || 'https://drive.google.com/drive/folders/' + f.id;
    await setLink(tab, row, expected, col, url);
    return { id: f.id, url: url, created: true };
  }
  async function taskTarget_(forName) {
    var n = String(forName || '').trim().toLowerCase();
    if (!n) return null;
    var d = await getData(), i;
    for (i = 0; i < d.campaigns.length; i++) { var c = d.campaigns[i]; if (n === String(c.name || '').trim().toLowerCase() || n === String(c.code || '').trim().toLowerCase()) return ['CAMPAIGNS', c.row, c.name]; }
    var tabs = { 'Clients & Partnerships': 'CLIENTS & PARTNERSHIPS', 'Brand Outreach': 'BRAND OUTREACH CLIENTS', 'PME': 'PME CLIENTS', 'Agencies': 'AGENCIES' };
    for (i = 0; i < d.clients.length; i++) { var e = d.clients[i]; if (tabs[e.src] && n === String(e.name || '').trim().toLowerCase()) return [tabs[e.src], e.row, e.name]; }
    return null;
  }
  async function submitDeliverable(row, expected, url) {
    url = String(url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('Paste a full link starting with http:// or https://');
    await check_('TASKS', row, 'C', expected);
    await vUpdate('TASKS!L' + row, [[url]], 'RAW');
    return completeTask(row, expected, url);
  }
  async function uploadDeliverableData(row, expected, name, mime, b64) {
    var r = await vals_('TASKS!C' + row + ':D' + row);
    r = r.length ? pad_(r[0], 2) : ['', ''];
    if (pstr_(r[0]) !== expected) throw new Error('Rows moved. Refresh and try again.');
    var t = await taskTarget_(pstr_(r[1])), parent;
    if (t) parent = (await sub_((await ensureFolder_(t[0], t[1], t[2])).id, 'Deliverables')).id;
    else parent = (await sub_((await sub_(await root_(), 'Deliverables')).id, 'Unassigned')).id;
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    var bnd = 'seer' + Date.now();
    var body = new Blob(['--' + bnd + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name: name || 'deliverable', parents: [parent] }) +
      '\r\n--' + bnd + '\r\nContent-Type: ' + (mime || 'application/octet-stream') + '\r\n\r\n', bytes, '\r\n--' + bnd + '--']);
    var f = await drv('POST', '/files', { uploadType: 'multipart', fields: 'id,webViewLink' }, null, { type: 'multipart/related; boundary=' + bnd, body: body });
    var url = f.webViewLink || 'https://drive.google.com/file/d/' + f.id + '/view';
    var out = await submitDeliverable(row, expected, url);
    out.url = url;
    return out;
  }


  // ------------------------------------------------------------ INNRVZN Music + INNRVZN Label (their own sheets)
  var MUSIC_ID = CFG.MUSIC_SHEET_ID || '1tPnrzTf3h_oUDnCM93gnCovCDMt6f-mWIDaD4wtHYcQ';
  var LABEL_ID = CFG.LABEL_SHEET_ID || '1hmsrljx7QzJqwUyofbW0M7Yjou2OPjk2OS2cioebu7k';
  async function sv_(sid, rng) {
    var r = await apiOn(sid, 'GET', '/values/' + encodeURIComponent(rng), { valueRenderOption: 'FORMATTED_VALUE' });
    return r.values || [];
  }
  function sAppend_(sid, rng, values) {
    return apiOn(sid, 'POST', '/values/' + encodeURIComponent(rng) + ':append', { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' }, { values: values });
  }
  function sUpdate_(sid, rng, values) {
    return apiOn(sid, 'PUT', '/values/' + encodeURIComponent(rng), { valueInputOption: 'USER_ENTERED' }, { values: values });
  }
  async function sDelRow_(sid, title, row) {
    var meta = await apiOn(sid, 'GET', '', { fields: 'sheets.properties(sheetId,title)' }), id = null;
    (meta.sheets || []).forEach(function (x) { if (x.properties.title === title) id = x.properties.sheetId; });
    if (id === null) throw new Error('No such tab: ' + title);
    await apiOn(sid, 'POST', ':batchUpdate', null, { requests: [{ deleteDimension: { range: { sheetId: id, dimension: 'ROWS', startIndex: row - 1, endIndex: row } } }] });
  }
  function zip_(keys, r) { var o = {}, a = pad_(r, keys.length); keys.forEach(function (k, i) { o[k] = pstr_(a[i]); }); return o; }
  function anyCell_(r) { return r && r.some(function (x) { return String(x == null ? '' : x).trim() !== ''; }); }

  var MUSIC_COLS = { status: 'D', owner: 'E', due: 'F', link: 'G', notes: 'H', task: 'C' };
  async function musicData() {
    var a = await sv_(MUSIC_ID, 'ARTISTS!A2:E'), t = await sv_(MUSIC_ID, 'PROJECTS!A2:H'), arts = [], tasks = [];
    a.forEach(function (r) { if (r && String(r[0] || '').trim()) arts.push(zip_(['name', 'status', 'contact', 'folder', 'notes'], r)); });
    t.forEach(function (r, i) { if (anyCell_(r)) { var o = zip_(['artist', 'project', 'task', 'status', 'owner', 'due', 'link', 'notes'], r); o.row = i + 2; tasks.push(o); } });
    return { artists: arts, tasks: tasks, url: 'https://docs.google.com/spreadsheets/d/' + MUSIC_ID + '/edit' };
  }
  var DB_TABS = [['talent', 'TALENT', ['name', 'category', 'agency', 'handle', 'tier', 'region', 'notes']],
  ['brands', 'BRANDS', ['type', 'region', 'org', 'notes']],
  ['contacts', 'CONTACTS', ['section', 'type', 'name', 'org', 'handle', 'region', 'reach', 'notes']]];
  async function databaseData() {
    var out = { url: 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit' };
    for (var i = 0; i < DB_TABS.length; i++) {
      var t = DB_TABS[i], rows = [];
      try { rows = await sv_(SHEET_ID, "'" + t[1] + "'!A2:" + String.fromCharCode(64 + t[2].length)); } catch (e) { rows = []; }
      out[t[0]] = rows.filter(anyCell_).map(function (r) { return zip_(t[2], r); });
    }
    return out;
  }
  async function mCheck_(row, expected) {
    var cur = await sv_(MUSIC_ID, 'PROJECTS!C' + row);
    if (!cur.length || !cur[0].length || pstr_(cur[0][0]).trim() !== String(expected).trim()) throw new Error('That task moved in the sheet. Refresh and try again.');
  }
  async function musicSet(row, expected, field, value) {
    var col = MUSIC_COLS[field]; if (!col) throw new Error('Unknown field');
    await mCheck_(row, expected);
    await sUpdate_(MUSIC_ID, 'PROJECTS!' + col + row, [[value]]);
    return { ok: true };
  }
  async function musicAddTask(artist, project, task, owner, due) {
    var v = [artist, project, task, owner, due].map(function (x) { return String(x || '').trim(); });
    if (!(v[0] && v[1] && v[2])) throw new Error('Artist, project and task are all needed.');
    await sAppend_(MUSIC_ID, 'PROJECTS!A:H', [[v[0], v[1], v[2], 'Not started', v[3], v[4], '', '']]);
    return { ok: true };
  }
  async function musicAddArtist(name) {
    name = String(name || '').trim(); if (!name) throw new Error('Name needed.');
    var d = await musicData();
    if (d.artists.some(function (a) { return a.name.toLowerCase() === name.toLowerCase(); })) throw new Error(name + ' is already listed.');
    await sAppend_(MUSIC_ID, 'ARTISTS!A:E', [[name, 'Active', '', '', '']]);
    return { ok: true };
  }
  async function musicDelTask(row, expected) { await mCheck_(row, expected); await sDelRow_(MUSIC_ID, 'PROJECTS', row); return { ok: true }; }

  var LABEL_TABS = {
    songs: ['SONGS', ['acode', 'artist', 'song', 'release', 'status', 'demo', 'mix', 'splitsheet', 'ingestion', 'master', 'visual', 'notes', 'tiktok'], 'C',
      { release: 'D', status: 'E', demo: 'F', mix: 'G', splitsheet: 'H', ingestion: 'I', master: 'J', visual: 'K', notes: 'L', tiktok: 'M' }],
    releases: ['RELEASES', ['acode', 'artist', 'release', 'type', 'date', 'status', 'folder', 'notes', 'spotify'], 'C',
      { type: 'D', date: 'E', status: 'F', folder: 'G', notes: 'H', spotify: 'I' }],
    assets: ['RELEASE_ASSETS', ['acode', 'artist', 'release', 'item', 'desc', 'due', 'owner', 'link', 'progress'], 'D',
      { desc: 'E', due: 'F', owner: 'G', link: 'H', progress: 'I' }],
    playlists: ['PLAYLISTS', ['url', 'playlist', 'curator', 'type', 'acode', 'artist', 'song', 'status', 'pitched', 'added', 'checked', 'notes'], 'A',
      { playlist: 'B', curator: 'C', type: 'D', status: 'H', pitched: 'I', added: 'J', notes: 'L' }],
    stats: ['STATS', ['date', 'acode', 'artist', 'release', 'metric', 'value', 'source', 'song'], 'E', {}]
  };
  var LABEL_ASSET_TEMPLATE = [['Song Master', 'Highest quality export'], ['Cover Art', 'Cover artwork, 3000x3000px, 300dpi'],
    ['Spotify Canvas', '9x16, 7 second clip'], ['Metadata', ''], ['Split Sheet', 'A signed document to protect all parties']];
  var LABEL_EP_EXTRA = [['Brand Book', ''], ['Press Kit', '']];
  var LABEL_ART_KEYS = ['code', 'name', 'status', 'contact', 'folder', 'notes', 'spotify'];
  function colLetter_(n) { return String.fromCharCode(64 + n); }
  async function labelData() {
    var names = Object.keys(LABEL_TABS);
    var res = await Promise.all([sv_(LABEL_ID, 'ARTISTS!A2:G')].concat(names.map(function (k) { var t = LABEL_TABS[k]; return sv_(LABEL_ID, t[0] + '!A2:' + colLetter_(t[1].length)); })));
    var arts = [];
    res[0].forEach(function (r, i) { if (r && String(r[0] || '').trim()) { var o = zip_(LABEL_ART_KEYS, r); o.row = i + 2; arts.push(o); } });
    var out = { artists: arts, url: 'https://docs.google.com/spreadsheets/d/' + LABEL_ID + '/edit' };
    names.forEach(function (k, n) { out[k] = []; res[n + 1].forEach(function (r, i) { if (anyCell_(r)) { var o = zip_(LABEL_TABS[k][1], r); o.row = i + 2; out[k].push(o); } }); });
    return out;
  }
  async function lCheck_(tab, row, expected) {
    var t = LABEL_TABS[tab]; if (!t) throw new Error('Unknown tab');
    var cur = await sv_(LABEL_ID, t[0] + '!' + t[2] + row);
    if (!cur.length || !cur[0].length || pstr_(cur[0][0]).trim() !== String(expected).trim()) throw new Error('That row moved in the sheet. Refresh and try again.');
  }
  async function labelSet(tab, row, expected, field, value) {
    var t = LABEL_TABS[tab]; if (!t || !t[3][field]) throw new Error('Unknown field');
    await lCheck_(tab, row, expected);
    await sUpdate_(LABEL_ID, t[0] + '!' + t[3][field] + row, [[value]]);
    return { ok: true };
  }
  async function labelNextCode() {
    var r = await sv_(LABEL_ID, 'ARTISTS!A2:A'), mx = 0;
    r.forEach(function (x) { var m = /^LBL(\d+)$/i.exec(pstr_(x && x[0]).trim()); if (m) mx = Math.max(mx, +m[1]); });
    return 'LBL' + ('0000' + (mx + 1)).slice(-4);
  }
  async function lArtist_(code) {
    var d = await labelData(), a = d.artists.filter(function (x) { return x.code === code; })[0];
    if (!a) throw new Error('Unknown artist code ' + code);
    return { a: a, d: d };
  }
  async function historyStats() {
    var rows = await sv_(SHEET_ID, "'TASK HISTORY'!A2:J"), pp = await people_(), out = [];
    var cl = function (v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
    function canon(x) { x = String(x || '').trim(); var low = x.toLowerCase(); if (low === 'migo') return 'Emilio Constantino';
      for (var i = 0; i < pp.length; i++) if (pp[i].toLowerCase() === low) return pp[i];
      var loc = cl(low.split('@')[0]), h = pp.filter(function (p) { return cl(p) && (loc.indexOf(cl(p)) > -1 || loc === cl(p.split(' ')[0])); });
      if (!h.length) h = pp.filter(function (p) { var f = cl(p.split(' ')[0]); return f && loc.indexOf(f) > -1; });
      return h.length === 1 ? h[0] : x; }
    var MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
    rows.forEach(function (r) { r = pad_(r, 10); var m = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/.exec(pstr_(r[0])); if (!m || !MON[m[1]]) return;
      var by = canon(r[1]); if (/^REMOVED|^\(/.test(pstr_(r[1]))) return;
      out.push({ date: m[3] + '-' + ('0' + MON[m[1]]).slice(-2) + '-' + ('0' + m[2]).slice(-2), by: by, task: pstr_(r[2]), forName: pstr_(r[3]), owner: pstr_(r[5]), deliv: pstr_(r[9]).trim() }); });
    return { done: out };
  }
  async function dbAdd(kind, name) {
    name = String(name || '').trim(); if (!name) throw new Error('Name needed.');
    var tc = { talent: ['TALENT', 'A'], brands: ['BRANDS', 'C'], contacts: ['CONTACTS', 'C'] }[kind];
    var row = (await vals_("'" + tc[0] + "'!" + tc[1] + ':' + tc[1])).length + 1;
    await apiOn(SHEET_ID, 'PUT', '/values/' + encodeURIComponent("'" + tc[0] + "'!" + tc[1] + row), { valueInputOption: 'RAW' }, { values: [[name]] });
    return { ok: true };
  }
  async function labelAddArtist(name) {
    name = String(name || '').trim(); if (!name) throw new Error('Name needed.');
    var d = await labelData();
    if (d.artists.some(function (a) { return a.name.toLowerCase() === name.toLowerCase(); })) throw new Error(name + ' is already listed.');
    var code = await labelNextCode();
    await sAppend_(LABEL_ID, 'ARTISTS!A:F', [[code, name, 'Active', '', '', '']]);
    return { ok: true, code: code };
  }
  async function labelAddSong(acode, song, release) {
    song = String(song || '').trim(); if (!song) throw new Error('Song title needed.');
    var x = await lArtist_(acode);
    if (x.d.songs.some(function (s) { return s.acode === acode && s.song.toLowerCase() === song.toLowerCase(); })) throw new Error(song + ' is already on ' + x.a.name + "'s list.");
    await sAppend_(LABEL_ID, 'SONGS!A:L', [[acode, x.a.name, song, String(release || '').trim(), 'Idea', '', '', '', '', '', '', '']]);
    return { ok: true };
  }
  async function labelAddRelease(acode, name, rtype, date) {
    name = String(name || '').trim(); if (!name) throw new Error('Release name needed.');
    var x = await lArtist_(acode);
    if (x.d.releases.some(function (r) { return r.acode === acode && r.release.toLowerCase() === name.toLowerCase(); })) throw new Error(name + ' already exists for ' + x.a.name + '.');
    rtype = ['Single', 'EP', 'Album'].indexOf(rtype) > -1 ? rtype : 'Single';
    await sAppend_(LABEL_ID, 'RELEASES!A:I', [[acode, x.a.name, name, rtype, String(date || ''), 'Planning', '', '', '']]);
    var items = (rtype !== 'Single' ? LABEL_EP_EXTRA : []).concat(LABEL_ASSET_TEMPLATE);
    await sAppend_(LABEL_ID, 'RELEASE_ASSETS!A:I', items.map(function (it) { return [acode, x.a.name, name, it[0], it[1], '', '', '', 'Not started']; }));
    return { ok: true };
  }
  async function labelAddStat(acode, metric, value, release, date, source, song) {
    if (['Monthly listeners', 'Followers', 'Streams', 'Listeners', 'TikTok creates'].indexOf(metric) === -1) throw new Error('Unknown metric.');
    var n = parseFloat(String(value).replace(/,/g, '')); if (isNaN(n)) throw new Error('The value must be a number.');
    var x = await lArtist_(acode);
    await sAppend_(LABEL_ID, 'STATS!A:H', [[date || dateNow(), acode, x.a.name, release || '', metric, n, source || 'Entered in Seer', song || '']]);
    return { ok: true };
  }
  async function labelAddPlaylist(acode, song, url, name, curator, ptype, status) {
    var m = /open\.spotify\.com\/(?:intl-[a-z]+\/)?playlist\/([A-Za-z0-9]+)/.exec(String(url || ''));
    if (!m) throw new Error('Paste a Spotify playlist link (open.spotify.com/playlist/...).');
    var link = 'https://open.spotify.com/playlist/' + m[1], d = await labelData(), a = { name: '' };
    if (acode) { a = d.artists.filter(function (x) { return x.code === acode; })[0]; if (!a) throw new Error('Unknown artist code ' + acode); }
    song = String(song || '').trim();
    if (song && !d.songs.some(function (s) { return s.acode === acode && s.song === song; })) throw new Error('Unknown song.');
    if (d.playlists.some(function (r) { return r.url.replace(/\?.*/, '') === link && r.acode === (acode || '') && r.song === song; })) throw new Error('That playlist is already listed' + (song ? ' for this song.' : '.'));
    status = ['Pitched', 'Added', 'Declined', 'Removed'].indexOf(status) > -1 ? status : 'Pitched';
    var today = dateNow();
    await sAppend_(LABEL_ID, 'PLAYLISTS!A:L', [[link, name || '', curator || '', ptype || '', acode || '', a.name, song, song ? status : '', status === 'Pitched' && song ? today : '', status === 'Added' && song ? today : '', '', '']]);
    return { ok: true };
  }
  async function labelDel(tab, row, expected) { await lCheck_(tab, row, expected); await sDelRow_(LABEL_ID, LABEL_TABS[tab][0], row); return { ok: true }; }

  async function subprojectAdd(parent, name) {
    parent = String(parent || '').trim(); name = String(name || '').trim().replace(/_/g, ' ');
    if (!parent || !name) throw new Error('Project and sub-project name are required.');
    var camps = (await getData()).campaigns || [], lc = function (x) { return String(x || '').toLowerCase(); };
    var par = camps.filter(function (c) { return lc(c.name) === lc(parent) && !c.parent; })[0];
    if (!par) throw new Error('Unknown project: ' + parent);
    var old = camps.filter(function (c) { return lc(c.name) === lc(name) && lc(c.parent) === lc(parent); })[0];
    if (old) return { ok: true, exists: true, name: old.name, row: old.row };
    var r = await addRecord('CAMPAIGNS', { E: name, G: 'Doing', I: par.client || '', F: par.lead || '', U: par.am || '' });
    await sUpdate_(SHEET_ID, 'CAMPAIGNS!AQ' + r.row + ':AR' + r.row, [['Sub-project', par.name]]);
    return { ok: true, name: name, row: r.row, code: r.code || '' };
  }
  async function projectSet(name, field, value) {
    var col = { status: 'G', payment: 'AS', type: 'AQ' }[field]; if (!col) throw new Error('Unknown field.');
    var c = ((await getData()).campaigns || []).filter(function (x) { return String(x.name).toLowerCase() === String(name || '').trim().toLowerCase(); })[0];
    if (!c) throw new Error('Unknown project: ' + name);
    await sUpdate_(SHEET_ID, 'CAMPAIGNS!' + col + c.row, [[String(value)]]);
    return { ok: true };
  }
  var A = {
    subprojectAdd: subprojectAdd, projectSet: projectSet,
    getData: getData, addTask: addTask, completeTask: completeTask, snoozeTask: snoozeTask, setCampaignStatus: setCampaignStatus,
    driveStatus: driveStatus, driveConnect: driveStatus, driveDisconnect: driveStatus, driveFind: driveFind, driveSetRoot: driveSetRoot,
    driveCreateRoot: driveCreateRoot, createFolder: ensureFolder_, submitDeliverable: submitDeliverable, uploadDeliverableData: uploadDeliverableData,
    authStatus: async function () { var pr = profile(); if (!pr || !pr.email) return { ok: false, email: '' };
      try { var a = await accessCheck_(); return { ok: !!a.ok, email: email, name: a.name || pr.name || '', role: a.role || '' }; } catch (e) { return { ok: false, email: '', error: String(e && e.message || e) }; } },
    profiles: function () { return relay('users').then(function (o) { var seen = {}; return (o.users || []).filter(function (u) { var k = String(u.name || '').trim().toLowerCase(); if (!k || seen[k]) return false; seen[k] = 1; return true; }); }); },
    signIn: function (em) { return A.profiles().then(function (ps) { var p = ps.filter(function (u) { return String(u.email).toLowerCase() === String(em || '').toLowerCase(); })[0];
      if (!p) throw new Error('Pick a profile.'); lsSet('seer.profile', JSON.stringify(p)); email = p.email; ACCESS = null; accessP = null; token = ''; tokenExp = 0; return { ok: true, email: p.email, name: p.name }; }); },
    appVersion: function () { return Promise.resolve({ version: WEB_VERSION, web: true }); },
    checkUpdate: function () { return Promise.resolve({ newer: false }); },
    databaseData: databaseData,
    musicData: musicData, musicSet: musicSet, musicAddTask: musicAddTask, musicAddArtist: musicAddArtist, musicDelTask: musicDelTask,
    labelData: labelData, labelSet: labelSet, labelNextCode: labelNextCode, labelAddArtist: labelAddArtist, dbAdd: dbAdd, historyStats: historyStats, labelAddSong: labelAddSong,
    labelAddRelease: labelAddRelease, labelAddStat: labelAddStat, labelAddPlaylist: labelAddPlaylist, labelDel: labelDel,
    labelCheckPlaylists: function () { return Promise.reject(new Error('Checking playlists runs in the Seer desktop app (Windows or Mac). Playlists you add here are kept and checked from there.')); },
    getSchema: getSchema, nextCode: nextCode, getRecord: getRecord, updateCell: updateCell, deleteRecord: deleteRecord, addRecord: addRecord,
    addLog: addLog, meetingSave: meetingSave, meetingMove: meetingMove, connections: connections, reportsData: reportsData, reportAdd: reportAdd, reportEdit: reportEdit, reportDelete: reportDelete, reportMeeting: reportMeeting, reportMark: reportMark, setClientStatus: setClientStatus, setLink: setLink, getBacklog: getBacklog, saveBacklog: saveBacklog,
    setBackdrop: function () { return Promise.resolve({ ok: true, skipped: true }); },
    getBackdrop: function () { return Promise.resolve({ mode: 'solid', theme: 'dark' }); },
    endSplash: function () { return Promise.resolve({ ok: true }); },
    splashPlate: function () { return Promise.resolve({ ok: false }); },
    openUrl: function (u) { window.open(u, '_blank', 'noopener'); return Promise.resolve({ ok: true }); },
    log: function () { return Promise.resolve({ ok: true }); },
    getWorkspace: function () { var w = lsGet('ta_ws'); return Promise.resolve(['dash', 'cal', 'plus', 'music', 'label', 'db', 'dev', 'more'].indexOf(w) > -1 ? w : ''); },
    setWorkspace: function (ws) { if (['dash', 'cal', 'plus', 'music', 'label', 'db', 'dev', 'more'].indexOf(ws) === -1) return Promise.reject(new Error('Unknown workspace')); lsSet('ta_ws', ws); return Promise.resolve({ ok: true }); },
    signOut: function () {
      lsSet('seer.profile', ''); lsSet('ta_tok', ''); lsSet('ta_exp', ''); token = ''; tokenExp = 0; email = ''; ACCESS = null; accessP = null;
      return Promise.resolve({ ok: true });
    }
  };
  window.__api = A;
})();
