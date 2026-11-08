// TV Home helper service.
// TizenBrew runs this file inside its own background service (Node, with `require` and the `tizen` API).
// The home page cannot read the TV's own app API (no CORS headers) and cannot press remote keys,
// so it asks this service, which can.
//
//   GET http://127.0.0.1:8091/open?id=<tv id>&ids=<id,id>&match=<name>
//        start an app through the TV's app API (port 8001), then report whether it took the screen;
//        if the TV does not know that ID, fall back to tizen.application.launch with ids / match
//   GET http://127.0.0.1:8091/launch?ids=<id,id>&match=<name>   only the tizen.application fallback
//   GET http://127.0.0.1:8091/key?k=KEY_HDMI1                    press a remote key (HDMI 1, Menu, ...)
//   GET http://127.0.0.1:8091/apps                               installed apps the user would open
//
// Written in ES5 on purpose: older TizenBrew builds run services on Node 4.
'use strict';

var http = require('http');
var url = require('url');

var PORT = 8091;
var TV_API = { host: '127.0.0.1', port: 8001, path: '/api/v2/applications/' };
var REMOTE = 'wss://127.0.0.1:8002/api/v2/channels/samsung.remote.control?name=VFYgSG9tZQ==';   // name: base64 of "TV Home"
var CHECKS = 8, CHECK_MS = 600;   // look up to ~5 s for the app to come to the front

function send(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

// ----- The TV's app API: POST starts an app, GET says whether it runs and is in front. -----
function tvApi(method, id, done) {
  var finished = false;
  function end(err, status, json) { if (!finished) { finished = true; done(err, status, json); } }
  try {
    var req = http.request({ host: TV_API.host, port: TV_API.port, method: method,
                             path: TV_API.path + encodeURIComponent(id) }, function (r) {
      var body = '';
      r.on('data', function (c) { body += c; });
      r.on('end', function () {
        var json = null;
        try { json = JSON.parse(body); } catch (e) {}
        end(null, r.statusCode, json);
      });
    });
    req.on('error', function (e) { end(e); });
    req.setTimeout(4000, function () { req.abort(); end(new Error('timeout')); });
    req.end();
  } catch (e) { end(e); }
}

function openByTvApi(id, done) {
  tvApi('POST', id, function (err, status) {
    if (err) return done(err);
    if (status === 404) return done(null, { ok: false, error: 'not_installed' });
    if (status !== 200) return done(new Error('tv api ' + status));
    var n = 0;
    (function check() {
      tvApi('GET', id, function (e, s, app) {
        if (!e && app && app.visible) return done(null, { ok: true, id: id, name: app.name, visible: true, via: 'tv' });
        if (++n >= CHECKS) return done(null, { ok: true, id: id, name: app && app.name, visible: false, running: !!(app && app.running), via: 'tv' });
        setTimeout(check, CHECK_MS);
      });
    })();
  });
}

// ----- tizen.application, the fallback. Every call is wrapped: an uncaught error here would stop TizenBrew's whole service. -----
function installedApps(done) {
  try {
    tizen.application.getAppsInfo(function (list) {
      try { done(null, list.map(function (a) { return { id: a.id, name: a.name, show: a.show }; })); } catch (e) { done(e); }
    }, function (err) { done(err); });
  } catch (e) { done(e); }
}

// Pick the first preferred ID that is installed, otherwise the first app whose name contains `match`.
function pick(apps, ids, match) {
  var i, j;
  for (i = 0; i < ids.length; i++) {
    for (j = 0; j < apps.length; j++) if (apps[j].id === ids[i]) return apps[j];
  }
  if (match) {
    match = match.toLowerCase();
    for (j = 0; j < apps.length; j++) {
      if (String(apps[j].name || '').toLowerCase().indexOf(match) >= 0) return apps[j];
    }
  }
  return null;
}

function openByTizen(ids, match, done) {
  installedApps(function (err, apps) {
    if (err) return done(err);
    var app = pick(apps, ids, match);
    if (!app) return done(null, { ok: false, error: 'not_installed' });
    try {
      tizen.application.launch(app.id, function () {
        done(null, { ok: true, id: app.id, name: app.name, via: 'tizen' });
      }, function (e) { done(e); });
    } catch (e) { done(e); }
  });
}

// Apps a person opens: hide system parts, helpers and widgets. Samsung marks user-facing apps with show = true.
var HIDDEN = /^(org\.tizen\.|com\.samsung\.|com\.tizen\.|org\.volt\.|com\.wssyncmldm|tizenbrew|xvvl3S1TT1\.TizenBrew)/i;
function userApps(apps) {
  var seen = {};
  return apps.filter(function (a) {
    if (!a.name || a.show === false || HIDDEN.test(a.id) || /service|widget|helper/i.test(a.id)) return false;
    if (seen[a.name]) return false;
    seen[a.name] = 1;
    return true;
  }).map(function (a) { return { id: a.id, name: a.name }; });
}

// ----- Remote keys: the TV's remote-control channel on port 8002. -----
// The first time, the TV asks on screen whether to allow "TV Home"; the token it gives back is kept in memory
// and in TizenBrew's storage folder so the question does not come again.
var token = '';
var TOKEN_FILE = '/opt/usr/home/owner/share/tvhome-token';
try { token = String(require('fs').readFileSync(TOKEN_FILE)).trim(); } catch (e) {}

function wsLib() {
  var names = ['ws-new', 'ws', 'ws-old'];
  for (var i = 0; i < names.length; i++) { try { return require(names[i]); } catch (e) {} }
  return null;
}

function pressKey(key, done) {
  var WS = wsLib();
  if (!WS) return done(new Error('no_websocket'));
  var finished = false, ws;
  function end(err, body) {
    if (finished) return;
    finished = true; clearTimeout(timer);
    try { ws.close(); } catch (e) {}
    done(err, body);
  }
  var timer = setTimeout(function () { end(new Error('pairing_timeout')); }, 35000);   // the on-screen question waits ~30 s
  try {
    ws = new WS(REMOTE + (token ? '&token=' + token : ''), { rejectUnauthorized: false });
  } catch (e) { return end(e); }
  ws.on('error', function (e) { end(e); });
  ws.on('message', function (raw) {
    var m;
    try { m = JSON.parse(String(raw)); } catch (e) { return; }
    if (m.event === 'ms.channel.connect') {
      if (m.data && m.data.token && m.data.token !== token) {
        token = String(m.data.token);
        try { require('fs').writeFileSync(TOKEN_FILE, token); } catch (e) {}
      }
      ws.send(JSON.stringify({ method: 'ms.remote.control',
        params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' } }));
      setTimeout(function () { end(null, { ok: true, key: key }); }, 300);
    } else if (m.event === 'ms.channel.unauthorized' || m.event === 'ms.channel.timeOut') {
      end(new Error(m.event === 'ms.channel.timeOut' ? 'pairing_timeout' : 'unauthorized'));
    }
  });
}

// ----- HTTP routes -----
var server = http.createServer(function (req, res) {
  try { route(req, res); } catch (e) { send(res, 500, { ok: false, error: String(e.message || e) }); }
});

function reply(res) {
  return function (err, body) {
    if (err) return send(res, 500, { ok: false, error: String(err.message || err) });
    send(res, body.ok ? 200 : 404, body);
  };
}

function route(req, res) {
  var q = url.parse(req.url, true);
  var ids = String(q.query.ids || '').split(',').filter(Boolean);
  var match = String(q.query.match || '');

  if (q.pathname === '/apps') {
    return installedApps(function (err, apps) {
      if (err) return send(res, 500, { ok: false, error: String(err.message || err) });
      send(res, 200, { ok: true, apps: userApps(apps) });
    });
  }

  if (q.pathname === '/open') {
    var id = String(q.query.id || '');
    var fallback = function () { openByTizen(ids.length ? ids : (id ? [id] : []), match, reply(res)); };
    if (!id) return fallback();
    return openByTvApi(id, function (err, body) {
      if (!err && body.ok) return send(res, 200, body);
      fallback();   // the TV's API is off or does not know the ID: try the tizen launcher
    });
  }

  if (q.pathname === '/launch') return openByTizen(ids, match, reply(res));

  if (q.pathname === '/key') {
    var key = String(q.query.k || '');
    if (!/^KEY_[A-Z0-9_]+$/.test(key)) return send(res, 400, { ok: false, error: 'bad_key' });
    return pressKey(key, reply(res));
  }

  send(res, 200, { ok: true, service: 'tvhome' });
}

// TizenBrew restarts a crashed service on the next launch, so a busy port (already running) is fine.
server.on('error', function (e) { console.log('tvhome service: ' + e.message); });
server.listen(PORT, '127.0.0.1');
