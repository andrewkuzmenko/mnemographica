'use strict';

// VrBridge: the loopback HTTP + WebSocket server that mirrors a graph
// panel into the system browser for WebXR. Pins the page and media
// routes, the token gate, the Host/Origin checks (DNS rebinding and
// cross-site sockets stay out), the two-way message mirror, and the
// close code that tells a page its panel is gone.

const assert = require('assert');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { VrBridge, VR_SESSION_CLOSED } = require('../out/src/webview/vrBridge');

const mediaRoot = path.join(__dirname, '..', 'media');

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
	const bridge = new VrBridge(mediaRoot);
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

	bridge.dispose();
	console.log('=== All Tests Passed ===');
}

runTests().catch(err => {
	console.error('Test failed:', err);
	process.exit(1);
});
