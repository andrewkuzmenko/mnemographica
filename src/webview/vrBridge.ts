/**
 * The VR bridge: a loopback HTTP + WebSocket server that serves a graph
 * panel's page to the system browser, where WebXR reaches the headset
 * (Chrome/Edge with an OpenXR runtime such as Meta Quest Link). Editor
 * webviews cannot enter VR themselves: VS Code's webview iframe withholds
 * the xr-spatial-tracking permission.
 *
 * One bridge per extension host, started on first use. Each panel that
 * opens VR registers a session under a random token; the page lives at
 * /vr/<token> and its socket at /ws/<token>. Every socket of a session
 * mirrors the panel: it receives what the panel receives (broadcast) and
 * its messages reach the panel's own handler (host.onMessage). The token
 * is the only credential — 127.0.0.1 keeps the LAN out, the Host and
 * Origin checks keep other web pages (DNS rebinding, cross-site sockets)
 * out.
 *
 * vscode-free on purpose: the plain-node tests drive it directly.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { Duplex } from 'stream';
import * as ws from 'ws';
import type { WebSocket } from 'ws';

export type VrClient = {
	post: (message: unknown) => void;
};

export type VrSessionHost = {
	// The page served at /vr/<token>; its app script must load from
	// /media/webview.js and its stylesheet from /media/webview.css
	pageHtml: () => string;
	onMessage: (client: VrClient, message: unknown) => void;
};

type vrSession = {
	host: VrSessionHost;
	sockets: Set<WebSocket>;
};

// The files the bridge page loads besides itself — the panel's own
// stylesheet and app script, served from the extension's media folder
const MEDIA_TYPES = new Map([
	['webview.css', 'text/css; charset=utf-8'],
	['webview.js', 'text/javascript; charset=utf-8']
]);

// Close code the bridge sends when a panel goes away: the page stops
// reconnecting (VR_PAGE_BOOT)
export const VR_SESSION_CLOSED = 4001;

/**
 * The bridge page's stand-in for acquireVsCodeApi: posts travel over the
 * session's WebSocket, and every message the host broadcasts is
 * re-dispatched on window — the same MessageEvent the webview host
 * delivers, so webview.js runs unchanged. Posts made before the socket
 * opens queue up. A dropped socket reconnects; a closed session
 * (VR_SESSION_CLOSED) does not.
 */
export const VR_PAGE_BOOT = `
window.__MNEMO_VR_BRIDGE__ = true;
window.acquireVsCodeApi = function () {
	const url = 'ws://' + location.host + location.pathname.replace(/^\\/vr\\//, '/ws/');
	const outbox = [];
	let socket = null;
	let opened = false;
	const connect = function () {
		socket = new WebSocket(url);
		socket.onopen = function () {
			opened = true;
			while (outbox.length) { socket.send(outbox.shift()); }
		};
		socket.onmessage = function (event) {
			window.postMessage(JSON.parse(event.data), '*');
		};
		socket.onclose = function (event) {
			socket = null;
			if (event.code === ${VR_SESSION_CLOSED}) {
				document.title = 'Mnemonica Graph (closed in the editor)';
				return;
			}
			if (opened) { setTimeout(connect, 2000); }
		};
	};
	connect();
	return {
		getState : function () { return null; },
		setState : function () {},
		postMessage : function (message) {
			const text = JSON.stringify(message);
			if (socket && socket.readyState === 1) {
				socket.send(text);
			} else {
				outbox.push(text);
			}
		}
	};
};`;

export class VrBridge {
	private server: http.Server | null = null;
	private wsServer: ws.Server | null = null;
	private listening: Promise<number> | null = null;
	private readonly sessions = new Map<string, vrSession>();

	constructor (
		private readonly mediaRoot: string,
		private readonly log: (message: string) => void = () => undefined
	) {}

	/**
	 * Register a panel and return its page URL; starts the server on
	 * first use. The token stays valid until close(token).
	 */
	async open (host: VrSessionHost): Promise<{ token: string; url: string }> {
		const port = await this.start();
		const token = crypto.randomBytes(24).toString('hex');
		this.sessions.set(token, { host, sockets: new Set() });
		const opened = { token, url: `http://127.0.0.1:${port}/vr/${token}` };
		return opened;
	}

	// Send a message to every page of a session
	broadcast (token: string, message: unknown): void {
		const session = this.sessions.get(token);
		if (!session || session.sockets.size === 0) {
			return;
		}
		const text = JSON.stringify(message);
		for (const socket of session.sockets) {
			if (socket.readyState === ws.OPEN) {
				socket.send(text);
			}
		}
	}

	close (token: string): void {
		const session = this.sessions.get(token);
		if (!session) {
			return;
		}
		this.sessions.delete(token);
		for (const socket of session.sockets) {
			socket.close(VR_SESSION_CLOSED, 'panel closed');
		}
	}

	dispose (): void {
		for (const token of Array.from(this.sessions.keys())) {
			this.close(token);
		}
		if (this.wsServer) {
			this.wsServer.close();
			this.wsServer = null;
		}
		if (this.server) {
			this.server.close();
			this.server = null;
		}
		this.listening = null;
	}

	private start (): Promise<number> {
		if (this.listening) {
			return this.listening;
		}
		this.listening = new Promise<number>((resolve, reject) => {
			const server = http.createServer((req, res) => this.serve(req, res));
			this.wsServer = new ws.Server({ noServer: true });
			server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
			server.once('error', (err: Error) => {
				this.listening = null;
				reject(err);
			});
			// Port 0: the OS picks a free one — two windows never collide
			server.listen(0, '127.0.0.1', () => {
				const address = server.address();
				const port = address && typeof address === 'object' ? address.port : 0;
				this.log(`[VrBridge] listening on http://127.0.0.1:${port}`);
				resolve(port);
			});
			this.server = server;
		});
		return this.listening;
	}

	// The Host header must name this loopback server: a foreign hostname
	// resolving to 127.0.0.1 (DNS rebinding) is refused
	private hostAllowed (req: http.IncomingMessage): boolean {
		const address = this.server ? this.server.address() : null;
		const port = address && typeof address === 'object' ? address.port : -1;
		const host = req.headers.host;
		const allowed = host === `127.0.0.1:${port}` || host === `localhost:${port}`;
		return allowed;
	}

	private serve (req: http.IncomingMessage, res: http.ServerResponse): void {
		const send = (status: number, type: string, body: string | Buffer) => {
			res.writeHead(status, {
				'Content-Type'           : type,
				'Cache-Control'          : 'no-store',
				// The page URL carries the token; CDN script requests must
				// not leak it as a Referer
				'Referrer-Policy'        : 'no-referrer',
				'X-Content-Type-Options' : 'nosniff'
			});
			res.end(body);
		};
		if (req.method !== 'GET' || !this.hostAllowed(req)) {
			send(403, 'text/plain; charset=utf-8', 'Forbidden');
			return;
		}
		const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
		const page = /^\/vr\/([0-9a-f]+)$/.exec(pathname);
		if (page) {
			const session = this.sessions.get(page[1]);
			if (!session) {
				send(404, 'text/plain; charset=utf-8', 'This graph is no longer open in the editor');
				return;
			}
			send(200, 'text/html; charset=utf-8', session.host.pageHtml());
			return;
		}
		const media = /^\/media\/([a-z.]+)$/.exec(pathname);
		const mediaType = media ? MEDIA_TYPES.get(media[1]) : undefined;
		if (media && mediaType) {
			fs.readFile(path.join(this.mediaRoot, media[1]), (err, body) => {
				if (err) {
					send(404, 'text/plain; charset=utf-8', 'Not found');
					return;
				}
				send(200, mediaType, body);
			});
			return;
		}
		send(404, 'text/plain; charset=utf-8', 'Not found');
	}

	private upgrade (req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
		const address = this.server ? this.server.address() : null;
		const port = address && typeof address === 'object' ? address.port : -1;
		const origin = req.headers.origin;
		const originAllowed = origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
		const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
		const match = /^\/ws\/([0-9a-f]+)$/.exec(pathname);
		const session = match ? this.sessions.get(match[1]) : undefined;
		if (!this.wsServer || !this.hostAllowed(req) || !originAllowed || !session) {
			socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
			socket.destroy();
			return;
		}
		this.wsServer.handleUpgrade(req, socket, head, (client: WebSocket) => {
			session.sockets.add(client);
			const handle: VrClient = {
				post : (message: unknown) => {
					if (client.readyState === ws.OPEN) {
						client.send(JSON.stringify(message));
					}
				}
			};
			client.on('message', (data: ws.RawData) => {
				let message: unknown;
				try {
					message = JSON.parse(data.toString());
				} catch {
					this.log('[VrBridge] dropped a message that is not JSON');
					return;
				}
				session.host.onMessage(handle, message);
			});
			client.on('close', () => {
				session.sockets.delete(client);
			});
		});
	}
}
