'use strict';

// VrBridge: the loopback HTTP + WebSocket server that mirrors a graph
// panel into the system browser for WebXR. Pins the page and media
// routes, the token gate, the Host/Origin checks (DNS rebinding and
// cross-site sockets stay out), the two-way message mirror, the close
// code that tells a page its panel is gone, the /lib/ libraries (vendor
// copy, verified download, CDN fallback) and the fixed port.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { VrBridge, VR_SESSION_CLOSED, questAdbSteps, questAdbCommand } = require('../out/src/webview/vrBridge');

const extensionRoot = path.join(__dirname, '..');
const host = { pageHtml: () => '<!DOCTYPE html>', onMessage: () => {} };
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// A one-off server on a free port, resolving with it
const listen = (server) => new Promise((resolve) => {
	server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const get = (url, headers = {}) => new Promise((resolve, reject) => {
	const req = http.get(url, { headers }, (res) => {
		let body = '';
		res.setEncoding('utf8');
		res.on('data', (chunk) => { body += chunk; });
		res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
	});
	req.on('error', reject);
});

// Resolves with the open socket, or with the HTTP status of a refused upgrade
const connect = (url, origin) => new Promise((resolve) => {
	const socket = new WebSocket(url, { origin });
	socket.on('open', () => resolve({ socket }));
	socket.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
	socket.on('error', () => resolve({ status: 0 }));
});

const nextMessage = (socket) => new Promise((resolve) => {
	socket.once('message', (data) => resolve(JSON.parse(data.toString())));
});

const nextClose = (socket) => new Promise((resolve) => {
	socket.once('close', (code) => resolve(code));
});

async function runTests () {
	console.log('=== VrBridge Tests ===\n');

	const received = [];
	const bridge = new VrBridge({ extensionRoot });
	const opened = await bridge.open({
		pageHtml  : () => '<!DOCTYPE html><title>vr page</title>',
		onMessage : (client, message) => {
			received.push(message);
			// Echo back so the test sees the per-client reply path
			client.post({ command: 'echo', data: message });
		}
	});
	const { token, url } = opened;
	const base = new URL(url).origin;
	const port = new URL(url).port;
	assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/vr\/[0-9a-f]{48}$/, 'loopback page URL with a 48-hex token');

	// Page route
	const page = await get(url);
	assert.strictEqual(page.status, 200, 'the page serves for its token');
	assert.strictEqual(page.body, '<!DOCTYPE html><title>vr page</title>');
	assert.strictEqual(page.headers['referrer-policy'], 'no-referrer', 'the token never leaks as a Referer');
	assert.strictEqual(page.headers['cache-control'], 'no-store');
	assert.strictEqual((await get(`${base}/vr/${'0'.repeat(48)}`)).status, 404, 'an unknown token has no page');
	console.log('  ✓ page route: token-gated, no-referrer, no-store');

	// Media route: the two whitelisted files only
	const script = await get(`${base}/media/webview.js`);
	assert.strictEqual(script.status, 200);
	assert.match(script.headers['content-type'], /^text\/javascript/);
	assert.ok(script.body.includes('Graph3DRenderer'), 'serves the real app script');
	assert.strictEqual((await get(`${base}/media/webview.css`)).status, 200);
	assert.strictEqual((await get(`${base}/media/icon.png`)).status, 404, 'media outside the whitelist is not served');
	assert.strictEqual((await get(`${base}/media/..%2Fpackage.json`)).status, 404, 'no path traversal');
	console.log('  ✓ media route: webview.js / webview.css only');

	// Host check: a foreign hostname resolving to 127.0.0.1 is refused
	assert.strictEqual((await get(url, { Host: `evil.example:${port}` })).status, 403, 'DNS-rebinding Host refused');
	assert.strictEqual((await get(url, { Host: `localhost:${port}` })).status, 200, 'localhost Host accepted');
	console.log('  ✓ Host header check');

	// Socket gate: token + Origin
	const wsUrl = url.replace(/^http:/, 'ws:').replace('/vr/', '/ws/');
	assert.strictEqual((await connect(wsUrl, 'http://evil.example')).status, 403, 'foreign Origin refused');
	assert.strictEqual((await connect(wsUrl.replace(token, '0'.repeat(48)), base)).status, 403, 'unknown token refused');
	const { socket } = await connect(wsUrl, base);
	assert.ok(socket, 'same-origin socket with the token connects');
	console.log('  ✓ socket gate: token + Origin');

	// Page → host, host → that page
	const echo = nextMessage(socket);
	socket.send(JSON.stringify({ command: 'ready' }));
	assert.deepStrictEqual(await echo, { command: 'echo', data: { command: 'ready' } });
	assert.deepStrictEqual(received, [{ command: 'ready' }]);
	socket.send('not json');
	// Broadcast reaches every page of the session
	const second = (await connect(wsUrl, base)).socket;
	const toFirst = nextMessage(socket);
	const toSecond = nextMessage(second);
	bridge.broadcast(token, { command: 'traceEvent', data: { edges: [] } });
	assert.deepStrictEqual(await toFirst, { command: 'traceEvent', data: { edges: [] } });
	assert.deepStrictEqual(await toSecond, { command: 'traceEvent', data: { edges: [] } });
	assert.deepStrictEqual(received, [{ command: 'ready' }], 'non-JSON frames are dropped');
	console.log('  ✓ two-way mirror: per-page replies and session broadcast');

	// Closing the session closes its pages with the stop code
	const closed = Promise.all([nextClose(socket), nextClose(second)]);
	bridge.close(token);
	assert.deepStrictEqual(await closed, [VR_SESSION_CLOSED, VR_SESSION_CLOSED]);
	assert.strictEqual((await get(url)).status, 404, 'a closed session has no page');
	console.log('  ✓ close: pages get VR_SESSION_CLOSED, the page is gone\n');

	// No vendor copy, no cache directory: the page stays on the CDN
	assert.strictEqual(bridge.libraryUrl('three.min.js'), null, 'no local three → CDN');
	assert.strictEqual(bridge.has(token), false);
	bridge.dispose();

	// Libraries: a verified vendor/ copy serves; a vendor copy with the
	// wrong hash is replaced by a verified download into the cache; a
	// download with the wrong hash or a failing one leaves the CDN
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-bridge-'));
	const libRoot = path.join(scratch, 'ext');
	const cacheDir = path.join(scratch, 'cache');
	fs.mkdirSync(path.join(libRoot, 'vendor'), { recursive: true });
	fs.writeFileSync(path.join(libRoot, 'vendor', 'vendored.js'), 'vendored();');
	fs.writeFileSync(path.join(libRoot, 'vendor', 'stale.js'), 'stale();');
	const cdn = http.createServer((req, res) => {
		const bodies = { '/stale.js': 'fresh();', '/tampered.js': 'evil();' };
		if (bodies[req.url]) {
			res.end(bodies[req.url]);
		} else {
			res.statusCode = 404;
			res.end();
		}
	});
	const cdnPort = await listen(cdn);
	const cdnUrl = (name) => `http://127.0.0.1:${cdnPort}/${name}`;
	const libBridge = new VrBridge({
		extensionRoot : libRoot,
		cacheDir,
		libraries     : [
			{ name: 'vendored.js', url: cdnUrl('vendored.js'), sha256: sha256('vendored();') },
			{ name: 'stale.js', url: cdnUrl('stale.js'), sha256: sha256('fresh();') },
			{ name: 'tampered.js', url: cdnUrl('tampered.js'), sha256: sha256('genuine();') },
			{ name: 'gone.js', url: cdnUrl('gone.js'), sha256: sha256('gone();') }
		]
	});
	const libOpened = await libBridge.open(host);
	const libBase = new URL(libOpened.url).origin;
	assert.strictEqual(libBridge.libraryUrl('vendored.js'), '/lib/vendored.js', 'verified vendor copy');
	assert.strictEqual((await get(`${libBase}/lib/vendored.js`)).body, 'vendored();');
	assert.strictEqual(libBridge.libraryUrl('stale.js'), '/lib/stale.js', 'wrong-hash vendor copy → verified download');
	assert.strictEqual((await get(`${libBase}/lib/stale.js`)).body, 'fresh();');
	assert.strictEqual(fs.readFileSync(path.join(cacheDir, 'stale.js'), 'utf8'), 'fresh();', 'the download is cached');
	assert.strictEqual(libBridge.libraryUrl('tampered.js'), null, 'a download with the wrong hash is refused');
	assert.ok(!fs.existsSync(path.join(cacheDir, 'tampered.js')), 'and never written');
	assert.strictEqual(libBridge.libraryUrl('gone.js'), null, 'a failed download leaves the CDN');
	assert.strictEqual((await get(`${libBase}/lib/gone.js`)).status, 404);
	libBridge.dispose();
	cdn.close();
	// The cache serves the next start without the network
	const offline = new VrBridge({
		extensionRoot : libRoot,
		cacheDir,
		libraries     : [{ name: 'stale.js', url: 'http://127.0.0.1:1/stale.js', sha256: sha256('fresh();') }]
	});
	await offline.open(host);
	assert.strictEqual(offline.libraryUrl('stale.js'), '/lib/stale.js', 'cached copy reused offline');
	offline.dispose();
	console.log('  ✓ /lib/: vendor copy, verified download + cache, wrong hash refused, CDN fallback');

	// A stalled CDN never holds open() past libraryWaitMs, concurrent
	// opens share ONE download, and the download timeout ends the stall
	let stalledRequests = 0;
	const stalledCdn = http.createServer(() => { stalledRequests++; });
	const stalledPort = await listen(stalledCdn);
	const slow = new VrBridge({
		extensionRoot  : libRoot,
		cacheDir       : path.join(scratch, 'slow-cache'),
		libraryWaitMs  : 200,
		fetchTimeoutMs : 600,
		libraries      : [{ name: 'slow.js', url: `http://127.0.0.1:${stalledPort}/slow.js`, sha256: sha256('slow();') }]
	});
	const openedAt = Date.now();
	await Promise.all([slow.open(host), slow.open(host)]);
	assert.ok(Date.now() - openedAt < 550, 'open() returns after libraryWaitMs while the download stalls');
	assert.strictEqual(slow.libraryUrl('slow.js'), null, 'the page uses the CDN meanwhile');
	assert.strictEqual(stalledRequests, 1, 'concurrent opens share one download');
	await new Promise(resolve => setTimeout(resolve, 800));
	await slow.open(host);
	assert.strictEqual(stalledRequests, 2, 'the timed-out download is retried by the next open()');
	slow.dispose();
	stalledCdn.closeAllConnections();
	stalledCdn.close();
	fs.rmSync(scratch, { recursive: true, force: true });
	console.log('  ✓ /lib/: a stalled download never blocks open(), one download at a time, timeout');

	// Fixed port: the bridge listens where it is told; a taken port fails
	// open() and the next open() retries
	const probe = http.createServer();
	const fixedPort = await listen(probe);
	const blocked = new VrBridge({ extensionRoot, port: () => fixedPort });
	await assert.rejects(blocked.open(host), /EADDRINUSE/, 'a taken fixed port fails open()');
	await new Promise(resolve => probe.close(resolve));
	const fixed = await blocked.open(host);
	assert.strictEqual(new URL(fixed.url).port, String(fixedPort), 'listens on the configured port');
	assert.strictEqual((await get(fixed.url)).status, 200);
	blocked.dispose();
	console.log('  ✓ fixed port: configured port, EADDRINUSE then retry');

	// Quest on USB: argv steps for a shell-free run, and paste-able text
	// with one command per line — no `&&`, no quotes (PowerShell 5.1 safe)
	const questUrl = 'http://127.0.0.1:9240/vr/ab12';
	assert.deepStrictEqual(questAdbSteps(questUrl), [
		['reverse', 'tcp:9240', 'tcp:9240'],
		['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', questUrl, 'com.oculus.browser']
	]);
	const pasted = questAdbCommand(questUrl);
	assert.strictEqual(pasted.split('\n').length, 2, 'one command per line');
	assert.ok(!/&&|'|"/.test(pasted), 'no shell-specific syntax');
	console.log('  ✓ Quest adb steps: argv for execFile, paste-able in any shell\n');

	console.log('=== All Tests Passed ===');
}

runTests().catch(err => {
	console.error('Test failed:', err);
	process.exit(1);
});
