// Runs service.js the way TizenBrew does (vm context with `require`, `module` and a `tizen` global),
// with a fake TV app list, then checks what it launches.
//   node test/service.test.js          run the checks and exit
//   node test/service.test.js --serve  keep the fake TV running, so the page can be tried in a browser
'use strict';

var fs = require('fs');
var vm = require('vm');
var http = require('http');
var path = require('path');

var launched = [];
var installed = [
  { id: '9Ur5IzDKqV.TizenYouTube', name: 'YouTube' },
  { id: '3201907018807', name: 'Netflix' },
  { id: '3201606009684', name: 'Spotify - Music and Podcasts' },
  { id: 'org.tizen.browser', name: 'Internet' }
];
var tizen = {
  application: {
    getAppsInfo: function (ok) { setTimeout(function () { ok(installed); }, 5); },
    launch: function (id, ok) {
      if (id === 'org.tizen.browser') throw new Error('SecurityError');   // a TV that refuses, to test the guard
      launched.push(id); console.log('  fake TV launched ' + id); setTimeout(ok, 5); }
  }
};

var sandbox = { require: require, console: console, setTimeout: setTimeout, tizen: tizen, module: { exports: {} } };
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'service.js'), 'utf8'), vm.createContext(sandbox));

function get(p) {
  return new Promise(function (resolve, reject) {
    http.get('http://127.0.0.1:8091' + p, function (res) {
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () { resolve({ status: res.statusCode, cors: res.headers['access-control-allow-origin'], json: JSON.parse(body) }); });
    }).on('error', reject);
  });
}

if (process.argv.indexOf('--serve') >= 0) {
  console.log('fake TV service on http://127.0.0.1:8091, press Ctrl+C to stop');
} else {
  var fails = 0;
  function check(name, cond) { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; }
  setTimeout(function () {
    get('/launch?ids=3201907018807,11101200001&match=netflix').then(function (r) {
      check('Netflix opens by its known ID', r.status === 200 && r.json.id === '3201907018807' && r.cors === '*');
      return get('/launch?ids=111299001912&match=youtube');
    }).then(function (r) {
      check('YouTube opens by name when the listed ID is not installed', r.json.ok && r.json.id === '9Ur5IzDKqV.TizenYouTube');
      return get('/launch?ids=AprZAARz4r.Jellyfin&match=jellyfin');
    }).then(function (r) {
      check('Missing app answers not_installed', r.status === 404 && r.json.error === 'not_installed');
      return get('/apps');
    }).then(function (r) {
      check('App list is available', r.json.ok && r.json.apps.length === installed.length);
      return get('/launch?ids=org.tizen.browser&match=internet');
    }).then(function (r) {
      check('A launch error is reported, not thrown', r.status === 500 && r.json.error === 'SecurityError');
      return get('/apps');
    }).then(function (r) {
      check('Service still answers after that error', r.json.ok);
      check('Exactly two launches happened', launched.length === 2);
      console.log(fails ? fails + ' check(s) failed' : 'all checks passed');
      process.exit(fails ? 1 : 0);
    }).catch(function (e) { console.log('FAIL ' + e.message); process.exit(1); });
  }, 200);
}
