// Runs service.js the way TizenBrew does (vm context with `require`, `module` and a `tizen` global),
// next to a fake TV app API on port 8001, then checks what it launches.
//   node test/service.test.js          run the checks and exit
//   node test/service.test.js --serve  keep the fake TV running, so the page can be tried in a browser
'use strict';

var fs = require('fs');
var vm = require('vm');
var http = require('http');
var path = require('path');

// ----- Fake TV app API (port 8001): the IDs this TV reports, POST brings an app to the front. -----
var tvApps = {
  'rTn6ClEurC.Jellyfin': { name: 'Jellyfin' },
  '3201907018807': { name: 'Netflix' },
  'xvvl3S1TT1.TizenTubeStandalone': { name: 'TizenTube' },
  'lazy.App': { name: 'Lazy', neverVisible: true }
};
var tvPosts = [];
var tvApi = http.createServer(function (req, res) {
  var id = decodeURIComponent(req.url.replace('/api/v2/applications/', ''));
  var app = tvApps[id];
  if (!app) { res.writeHead(404); return res.end('{"code":404}'); }
  if (req.method === 'POST') {
    tvPosts.push(id);
    Object.keys(tvApps).forEach(function (k) { tvApps[k].visible = false; });
    if (!app.neverVisible) { app.running = true; app.visible = true; }
    console.log('  fake TV API opened ' + id);
    res.writeHead(200); return res.end('true');
  }
  res.writeHead(200);
  res.end(JSON.stringify({ id: id, name: app.name, running: !!app.running, visible: !!app.visible }));
});

// ----- Fake tizen.application, the fallback launcher -----
var launched = [];
var installed = [
  { id: '9Ur5IzDKqV.TizenYouTube', name: 'YouTube', show: true },
  { id: '3201907018807', name: 'Netflix', show: true },
  { id: '3201606009684', name: 'Spotify - Music and Podcasts', show: true },
  { id: 'org.tizen.browser', name: 'Internet', show: true },
  { id: 'com.samsung.tv.store', name: 'Apps', show: true },
  { id: 'abc.HiddenHelper', name: 'Helper', show: false }
];
var tizen = {
  application: {
    getAppsInfo: function (ok) { setTimeout(function () { ok(installed); }, 5); },
    launch: function (id, ok) {
      if (id === 'org.tizen.browser') throw new Error('SecurityError');   // a TV that refuses, to test the guard
      launched.push(id); console.log('  fake tizen launched ' + id); setTimeout(ok, 5); }
  }
};

function startService() {
  var sandbox = { require: require, console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
                  Buffer: Buffer, tizen: tizen, module: { exports: {} } };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'service.js'), 'utf8'), vm.createContext(sandbox));
}

function get(p) {
  return new Promise(function (resolve, reject) {
    http.get('http://127.0.0.1:8091' + p, function (res) {
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () { resolve({ status: res.statusCode, cors: res.headers['access-control-allow-origin'], json: JSON.parse(body) }); });
    }).on('error', reject);
  });
}

tvApi.listen(8001, '127.0.0.1', function () {
  startService();
  if (process.argv.indexOf('--serve') >= 0) return console.log('fake TV on http://127.0.0.1:8091 and :8001, press Ctrl+C to stop');

  var fails = 0;
  function check(name, cond) { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; }
  setTimeout(function () {
    get('/open?id=rTn6ClEurC.Jellyfin&ids=rTn6ClEurC.Jellyfin&match=jellyfin').then(function (r) {
      check('Jellyfin opens through the TV API and is reported in front', r.status === 200 && r.json.via === 'tv' && r.json.visible === true && r.cors === '*');
      return get('/open?id=lazy.App');
    }).then(function (r) {
      check('An app that never starts falls back to tizen, which does not have it', r.status === 404 && r.json.error === 'not_installed');
      return get('/open?id=111299001912&ids=111299001912&match=youtube');
    }).then(function (r) {
      check('Unknown TV ID falls back to the tizen launcher by name', r.json.ok && r.json.via === 'tizen' && r.json.id === '9Ur5IzDKqV.TizenYouTube');
      return get('/open?id=AprZAARz4r.Jellyfin&ids=AprZAARz4r.Jellyfin&match=nothing');
    }).then(function (r) {
      check('Missing app answers not_installed', r.status === 404 && r.json.error === 'not_installed');
      return get('/launch?ids=3201907018807&match=netflix');
    }).then(function (r) {
      check('Old /launch route still works', r.status === 200 && r.json.id === '3201907018807');
      return get('/apps');
    }).then(function (r) {
      var ids = r.json.apps.map(function (a) { return a.id; });
      check('App list hides system parts and hidden helpers', r.json.ok && ids.length === 3 && ids.indexOf('com.samsung.tv.store') < 0 && ids.indexOf('abc.HiddenHelper') < 0);
      return get('/launch?ids=org.tizen.browser&match=internet');
    }).then(function (r) {
      check('A launch error is reported, not thrown', r.status === 500 && r.json.error === 'SecurityError');
      return get('/key?k=rm%20-rf');
    }).then(function (r) {
      check('Only KEY_ names are accepted as keys', r.status === 400 && r.json.error === 'bad_key');
      return get('/apps');
    }).then(function (r) {
      check('Service still answers after those errors', r.json.ok);
      check('TV API got two launches, tizen two', tvPosts.length === 2 && launched.length === 2);
      console.log(fails ? fails + ' check(s) failed' : 'all checks passed');
      process.exit(fails ? 1 : 0);
    }).catch(function (e) { console.log('FAIL ' + e.message); process.exit(1); });
  }, 200);
});
