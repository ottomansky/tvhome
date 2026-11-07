// TV Home helper service.
// TizenBrew runs this file inside its own background service, where the `tizen` API is available.
// Module pages opened by TizenBrew lose that API, so the home screen asks this service to start apps.
//
//   GET http://127.0.0.1:8091/launch?ids=<id,id>&match=<name>  -> start the first installed match
//   GET http://127.0.0.1:8091/apps                             -> installed apps, for finding IDs
//
// Written in ES5 on purpose: older TizenBrew builds run services on Node 4.
'use strict';

var http = require('http');
var url = require('url');

var PORT = 8091;

function send(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

// Every call into tizen is wrapped: an uncaught error here would stop TizenBrew's whole background service.
function installedApps(done) {
  try {
    tizen.application.getAppsInfo(function (list) {
      try { done(null, list.map(function (a) { return { id: a.id, name: a.name }; })); } catch (e) { done(e); }
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

var server = http.createServer(function (req, res) {
  try { route(req, res); } catch (e) { send(res, 500, { ok: false, error: String(e.message || e) }); }
});

function route(req, res) {
  var q = url.parse(req.url, true);

  if (q.pathname === '/apps') {
    return installedApps(function (err, apps) {
      if (err) return send(res, 500, { ok: false, error: String(err.message || err) });
      send(res, 200, { ok: true, apps: apps });
    });
  }

  if (q.pathname === '/launch') {
    var ids = String(q.query.ids || '').split(',').filter(Boolean);
    var match = String(q.query.match || '');
    return installedApps(function (err, apps) {
      if (err) return send(res, 500, { ok: false, error: String(err.message || err) });
      var app = pick(apps, ids, match);
      if (!app) return send(res, 404, { ok: false, error: 'not_installed' });
      try {
        tizen.application.launch(app.id, function () {
          send(res, 200, { ok: true, id: app.id, name: app.name });
        }, function (e) {
          send(res, 500, { ok: false, error: String(e.message || e), id: app.id });
        });
      } catch (e) {
        send(res, 500, { ok: false, error: String(e.message || e), id: app.id });
      }
    });
  }

  send(res, 200, { ok: true, service: 'tvhome' });
}

// TizenBrew restarts a crashed service on the next launch, so a busy port (already running) is fine.
server.on('error', function (e) { console.log('tvhome service: ' + e.message); });
server.listen(PORT, '127.0.0.1');
