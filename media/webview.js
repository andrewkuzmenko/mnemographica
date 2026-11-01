/* eslint-env browser */
/* global THREE, d3, acquireVsCodeApi, SHOW_PROPERTIES_PLACEHOLDER */

(function () {
	'use strict';

	// Placeholder for vscode reference (set after acquireVsCodeApi)
	let vscodeRef = null;

	// Shell radii for any number of generations:
	// root=105, gen1=180 (+75), gen2=245 (+65) -> [105, 180, 245, 310, ...]
	function get3D_Radii(maxDepth) {
		const radii = [];
		for (let i = 0; i <= maxDepth; i++) {
			// First jump is +75, then +65 for each subsequent
			radii.push(105 + (i === 0 ? 0 : 75 + (i - 1) * 65));
		}
		return radii;
	}

	// Send log message to extension's LoggerService
	function debugLog(message, type) {
		if (!vscodeRef) return;
		try {
			vscodeRef.postMessage({
				command: 'log',
				data: { message: String(message), type: type }
			});
		} catch (error) {
			console.log(type, message);
			console.error(error);
		}
	}

	// ===== Main Application Code =====
	debugLog('[Mnemonica] Script starting...', 'log');
	debugLog('[Mnemonica] THREE available: ' + typeof THREE, 'log');

	// Focus-animation helpers (rotate-then-zoom on sidebar click)
	function lerp(a, b, t) {
		return a + (b - a) * t;
	}
	function easeInOutCubic(t) {
		return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
	}

	// THREE's Raycaster does not skip invisible objects — walk the parent
	// chain so meshes inside a hidden layer group stop taking clicks
	function firstVisibleIntersect(intersects) {
		for (const hit of intersects) {
			let obj = hit.object;
			let visible = true;
			while (obj) {
				if (obj.visible === false) {
					visible = false;
					break;
				}
				obj = obj.parent;
			}
			if (visible) return hit;
		}
		return null;
	}

	// The orbit state is a single QUATERNION (arcball): the camera offset
	// direction, the up vector and the Shift-roll all ride it, so plain
	// drags always rotate around the CURRENT screen axes — horizontal
	// stays horizontal and vertical stays vertical no matter how the view
	// was rolled before. These helpers convert to/from the retired
	// spherical { rotX, rotY } angles, which survive only at the edges:
	// legacy layout.json cameras, the Camera3D census fields
	// (rotationX/rotationY) and focusNode's upright-band target search
	function quatFromOrbitAngles(rotX, rotY) {
		const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
		const pitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -rotX);
		const result = yaw.multiply(pitch);
		return result;
	}

	function orbitAnglesFromQuat(q) {
		const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
		const result = {
			x : Math.asin(Math.max(-1, Math.min(1, dir.y))),
			y : Math.atan2(dir.x, dir.z)
		};
		return result;
	}

	// Gesture axes in the orbit's LOCAL frame: yaw around screen
	// vertical, pitch around screen horizontal, roll around the view axis
	const ORBIT_YAW_AXIS = new THREE.Vector3(0, 1, 0);
	const ORBIT_PITCH_AXIS = new THREE.Vector3(1, 0, 0);
	const ORBIT_ROLL_AXIS = new THREE.Vector3(0, 0, 1);

	const vscode = acquireVsCodeApi();
	vscodeRef = vscode;
	let currentData = null;
	let renderer3D = null;
	let resizeHandler3D = null;

	// Live trace stream state: strategy pushes dive-trace deltas as
	// 'traceEvent' messages; the counter/last-name feed the status line,
	// and the edge's WHOLE lineage flashes acid-green in 3D
	let liveTraceCount = 0;
	let liveTraceLast = null;
	let lastStatusBase = '';

	// Anonymised export (talk mode): the export boot sets
	// window.__MNEMO_ANONYMIZE__ when the graph was exported with the
	// captions flag OFF — the page then shows the graph as a pure shape:
	// no captions, no tooltips, no names or paths anywhere (click and
	// double-click do nothing). Never set in the live panel
	const ANONYMIZE = Boolean(window.__MNEMO_ANONYMIZE__);
	// Names that traced this session — a single click on such a sphere
	// opens trace mode (names-first tracing)
	const liveTraceNames = new Set();
	// Recent edges by id (ring-bounded, insertion-order eviction): an
	// incoming edge walks its parentId chain through here so the FULL
	// trace lights as one acid-green body instead of one sphere at a
	// time — the same green trace mode uses
	const liveEdgeIndex = new Map();
	const LIVE_EDGE_INDEX_MAX = 5000;

	// The status line is base text ("N types | M relationships") plus,
	// once the live stream flows, a "· ⟁ live N (last: X)" suffix —
	// replaced by the isolated path while trace mode is open
	function updateStatusLine() {
		const status = document.getElementById('status');
		if (!status) return;
		let text = lastStatusBase;
		// Anonymised exports keep the counts, never the names
		if (!ANONYMIZE) {
			const traceNames = renderer3D && renderer3D.traceMode ? renderer3D.traceMode.names : null;
			if (traceNames) {
				const shown = traceNames.length > 4
					? traceNames[0] + ' → … → ' + traceNames.slice(-2).join(' → ')
					: traceNames.join(' → ');
				text += ' · ⟁ TRACE ' + shown;
			} else if (liveTraceCount > 0) {
				text += ' · ⟁ live ' + liveTraceCount;
				if (liveTraceLast) {
					text += ' (last: ' + liveTraceLast + ')';
				}
			}
		} else if (liveTraceCount > 0) {
			text += ' · ⟁ live ' + liveTraceCount;
		}
		status.textContent = text;
	}

	function setStatusBase(text) {
		lastStatusBase = text;
		updateStatusLine();
	}

	// The last segment of a path — Windows paths arrive with backslashes
	function fileBaseName(filePath) {
		const base = String(filePath).split(/[\\/]/).pop();
		return base;
	}

	// Initialize when DOM is ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

	function init() {
		debugLog('[Mnemonica] DOM ready, d3 available: ' + (typeof d3 !== 'undefined'), 'log');
		debugLog('[Mnemonica] THREE available: ' + (typeof THREE !== 'undefined'), 'log');
		debugLog('[Mnemonica] Requesting data from extension...', 'log');
		if (window.__MNEMO_VR_BRIDGE__) {
			const theme = document.createElement('style');
			theme.textContent = THEME_CSS_FALLBACKS;
			document.head.insertBefore(theme, document.head.firstChild);
		}
		setupEventListeners();
		setupVrButton();
		setupLegend();
		setupGenControlsCollapse();
		vscode.postMessage({ command: 'ready' });
	}

	// Focus requests arriving before the renderer exists (freshly opened
	// panel — 'ready' fired but render3DGraph has not run yet) are stashed
	// here and flushed at the end of render3DGraph
	let pendingFocusNode = null;

	// The saved layout (.mnemographica/layout.json — the Save button):
	// host reads the file and rides it along with every updateGraph;
	// render3DGraph applies it around renderGraph. null = no save ever
	// loaded
	let savedLayout = null;

	// Pins handed ACROSS full renderer rebuilds: a refresh rebuilds the
	// panel — wiping the old renderer's meshes, pins included — between
	// drag and Save. render3DGraph snapshots the outgoing renderer's pins
	// into this map before wiping, and re-applies them over
	// savedLayout.pins after the builders — session pins are always newer
	// than the file
	let sessionPins = {};

	// The wheel-driven generation shell radii, handed ACROSS full
	// renderer rebuilds (the sessionPins precedent): depthRadii dies
	// with the old renderer, so a Refresh would otherwise lose the
	// distances the user dialed in
	let sessionGenRadii = null;

	// The captions on/off choice handed ACROSS full renderer rebuilds —
	// the flag lives on the renderer (a rebuild resets it) and its
	// checkbox is rebuilt with the Layers & Distances panel, so the
	// user's choice rides this module-level var
	let sessionCaptionsVisible = true;
	// Anonymised export: captions never come back, whatever the bundle says
	if (ANONYMIZE) { sessionCaptionsVisible = false; }

	// Per-generation visibility: every generation has its own show/hide
	// checkbox, the same meaning as the layer ones. depth → false when
	// the user hid that generation; absent means visible. Module-level so
	// the choice survives the renderer rebuilds that wipe the panel DOM
	// (the sessionCaptionsVisible precedent)
	const sessionGenVisibility = new Map();

	// Visibility is COMPUTED, not looped: nothing iterates on a checkbox
	// flip — every governed object answers its own .visible through a
	// getter closure, and THREE's render traversal + the
	// firstVisibleIntersect parent-walk + the dynamics writers simply
	// read it. Edges and captions COMPOSE: their getters read the
	// endpoint/owner meshes' .visible, so one rule lives exactly one
	// place
	const genDepthVisible = (depth) => {
		// The types layer is the master switch: with the whole layer off,
		// every generation answers hidden too, so type-anchored elements
		// OUTSIDE typesGroup (holder diamonds, hookup grafts) follow
		// exactly as if their generation were unchecked
		const typesOn = !renderer3D || !renderer3D.typesGroup || renderer3D.typesGroup.visible !== false;
		return typesOn && sessionGenVisibility.get(depth || 0) !== false;
	};
	const defineComputedVisible = (obj, isVisible) => {
		Object.defineProperty(obj, 'visible', { get: isVisible, configurable: true });
	};
	// A creation scope disappears WITH its generation: a holder whose
	// creates anchors are ALL hidden types has nothing left to show.
	// Starters and chain scopes carry no creates — they belong to no
	// generation and stay. depthOfType answers null for unknown type
	// paths, and unknown ≠ hidden (the anchor just never resolves)
	const scopeHiddenByGen = (scopeNode, depthOfType) => {
		if (!scopeNode || !Array.isArray(scopeNode.creates) || scopeNode.creates.length === 0) { return false; }
		return scopeNode.creates.every(anchor => {
			const depth = depthOfType(anchor.typePath);
			return depth !== null && !genDepthVisible(depth);
		});
	};

	// Invocations path filter: a RegExp tested against each creation
	// scope's filePath; matching scopes hide so test-file invocations
	// stop drowning the app ones. The pattern is the
	// mnemographica.invocationPathFilter SETTING — pushed by the host
	// with every updateGraph and re-pushed on configuration change (the
	// Ø button opens the native Settings UI). Empty text means OFF
	let sessionInvocationFilter = null;
	const invocationPathFiltered = (scopeNode) => {
		if (!sessionInvocationFilter || !scopeNode) { return false; }
		const filePath = scopeNode.filePath;
		if (typeof filePath !== 'string' || filePath.length === 0) { return false; }
		return sessionInvocationFilter.test(filePath);
	};

	// Host-pushed UI settings. alwaysShowCollectionSelector keeps the
	// collection <select> visible for single-collection projects so the
	// feature stays discoverable
	let sessionUiSettings = { alwaysShowCollectionSelector: true };

	// Pages running outside VS Code (the export, the VR bridge page)
	// resolve the webview stylesheet's var(--vscode-*) theme references
	// to nothing and the panels go transparent — a :root fallback palette
	// (a dark theme matching the in-extension look) is their "theme"
	const THEME_CSS_FALLBACKS = `:root{
	--vscode-editor-background:#1e1e1e;
	--vscode-foreground:#cccccc;
	--vscode-descriptionForeground:#9d9d9d;
	--vscode-font-family:system-ui,'Segoe UI',sans-serif;
	--vscode-editor-font-family:'Consolas','Courier New',monospace;
	--vscode-panel-border:#454545;
	--vscode-button-background:#2d2d2d;
	--vscode-button-foreground:#cccccc;
	--vscode-button-hoverBackground:#37373d;
	--vscode-dropdown-background:#313131;
	--vscode-dropdown-foreground:#cccccc;
	--vscode-editorHoverWidget-background:#252526;
	--vscode-editorHoverWidget-border:#454545;
	--vscode-editorHoverWidget-foreground:#cccccc;
	--vscode-editorWarning-foreground:#cca700;
	--vscode-errorBackground:#5a1d1d;
	--vscode-errorForeground:#f48771;
	--vscode-focusBorder:#007fd4;
	--vscode-titleBar-activeBackground:#1f1f1f;
	--vscode-titleBar-activeForeground:#cccccc;
}
`;
	// The export has no host behind it: no buttons, no collection switch
	const EXPORT_CSS_FALLBACKS = THEME_CSS_FALLBACKS + `#controls{display:none!important}
#collection-select{display:none!important}
`;

	// The exported page's host stand-in (see assembleExportHtml). The
	// stub serves the recorded boot stream — settings, then updateGraph
	// with the exported arrangement — when the app posts 'ready', and
	// silently drops every other host-bound post: the export has no host
	// behind it
	const EXPORT_BOOT_STUB = `
window.acquireVsCodeApi = function () {
	let delivered = false;
	return {
		getState : function () { return null; },
		setState : function () {},
		postMessage : function (msg) {
			if (!msg || msg.command !== 'ready' || delivered) { return; }
			delivered = true;
			const boot = window.__MNEMO_EXPORT_BOOT__ || {};
			const stream = [];
			if (boot.settings) {
				stream.push({ command : 'settings', data : boot.settings });
			}
			if (boot.graphData) {
				stream.push({ command : 'updateGraph', data : boot.graphData, layout : boot.layout, settings : boot.settings });
			}
			// window.postMessage is a queued task — the app's message
			// listener registered during load, long before 'ready'
			stream.forEach(function (m) { window.postMessage(m, '*'); });
		}
	};
};`;

	// The exported page's connect panel — bottom-right, export-only. A
	// strategy-channel target in (a ws://…/?token=… URL, or the app's
	// strategy-channel.json pasted), live bulbs out: every trace frame is
	// posted back into the page as the SAME traceEvent message the
	// extension host forwards, so the existing live-flash machinery does
	// the lighting. There is no host behind the export — the browser
	// talks to the app directly (the server checks only the token; a
	// browser WebSocket connects fine)
	const EXPORT_CONNECT_PANEL = `
// The connect panel — live bulbs from a strategy channel (talk mode).
// Accepts a ws://…/?token=… URL or a strategy-channel.json paste
(function () {
	var panel = document.createElement('div');
	panel.style.cssText = 'position:fixed;right:10px;bottom:34px;z-index:20;background:#252526;border:1px solid #454545;border-radius:4px;padding:8px;display:flex;gap:6px;align-items:center;font:12px system-ui,sans-serif;color:#ccc';
	var input = document.createElement('input');
	input.placeholder = 'ws://127.0.0.1:PORT/?token=… or channel JSON';
	input.style.cssText = 'width:260px;background:#313131;color:#ccc;border:1px solid #454545;border-radius:3px;padding:4px 6px;font:inherit';
	var button = document.createElement('button');
	button.textContent = 'Connect';
	button.style.cssText = 'background:#2d2d2d;color:#ccc;border:1px solid #454545;border-radius:3px;padding:4px 10px;cursor:pointer;font:inherit';
	var note = document.createElement('span');
	note.style.cssText = 'color:#9d9d9d;font-size:11px;max-width:340px';
	panel.appendChild(input); panel.appendChild(button); panel.appendChild(note);
	document.body.appendChild(panel);
	var socket = null; var edges = 0;
	var setNote = function (t) { note.textContent = t; };
	var parseTarget = function (raw) {
		var text = raw.trim();
		if (!text) { return null; }
		if (/^wss?:\\/\\//.test(text)) { return text; }
		try {
			var parsed = JSON.parse(text);
			if (parsed && parsed.host && parsed.port && parsed.token) {
				return 'ws://' + parsed.host + ':' + parsed.port + '/?token=' + encodeURIComponent(parsed.token);
			}
		} catch (e) { /* not JSON */ }
		return null;
	};
	var disconnect = function () {
		if (socket) { try { socket.close(); } catch (e) {} socket = null; }
		button.textContent = 'Connect';
	};
	button.addEventListener('click', function () {
		if (socket) { disconnect(); setNote('disconnected'); return; }
		var url = parseTarget(input.value);
		if (!url) { setNote('paste a ws://…/?token=… URL or the strategy-channel.json contents'); return; }
		setNote('connecting…');
		try { socket = new WebSocket(url); } catch (e) { socket = null; setNote('connect failed: ' + e.message); return; }
		socket.addEventListener('open', function () {
			button.textContent = 'Disconnect';
			setNote('connected — waiting for traces');
			socket.send(JSON.stringify({ id: 1, op: 'traceSubscribe', params: { events: ['enter', 'create', 'leave', 'settle'] } }));
		});
		socket.addEventListener('message', function (event) {
			var msg; try { msg = JSON.parse(event.data); } catch (e) { return; }
			if (msg && msg.op === 'trace' && msg.params && Array.isArray(msg.params.edges)) {
				edges += msg.params.edges.length;
				setNote('connected — ' + edges + ' edges');
				// the SAME frame the extension host forwards — the app's
				// traceEvent handler lights the lineage bulbs
				window.postMessage({ command : 'traceEvent', data : { edges : msg.params.edges } }, '*');
			}
		});
		socket.addEventListener('close', function () { socket = null; button.textContent = 'Connect'; setNote('closed'); });
		socket.addEventListener('error', function () { setNote('connection error'); });
	});
}());`;

	// Orientation state picked with the vector-sphere control. Captions
	// ride a VIEW-space unit vector — the sign sits at camera × vector ×
	// distance from its mesh, so it holds its screen spot on rotation.
	// Diamonds/bagels/sinks ride WORLD-space re-orientations of their
	// bound-element offsets; Jaeger has NO orient of its own — it rides
	// the sinks orient. All four live HERE because the renderer (and its
	// userData) dies with every rebuild
	let sessionCaptionVector = null;
	let sessionCaptionOverrides = {};
	let sessionDiamondOrient = null;
	let sessionBagelOrient = null;
	let sessionSinkOrient = null;

	/**
	 * The vector-sphere control. Three elements:
	 *  - the CENTRAL dot — never moves; it stands for the center of
	 *    whatever the vector binds to (sphere, diamond, captioned mesh)
	 *  - the SURFACE dot — the orientation; a drag ARCBALL-rotates the
	 *    assembly (Shoemake trackball — Euler yaw/pitch locks a pole
	 *    dot: captions default to (0,1,0), ON the yaw axis, so horizontal
	 *    drags would only spin it in place)
	 *  - the transparent SPHERE — the distance; the scroll wheel zooms
	 *    its radius (the main scene's zoom idiom) and the dot stays
	 *    glued to the surface
	 * Distance is an ODOMETER: wheelAcc accumulates wheel pixels; the
	 * VISUAL radius sweeps a decade per VISUAL cycle (MAX_SCALE ×
	 * 10^(phase−½) ∈ [0.115, 1.15]) while the distance VALUE keeps
	 * accumulating smoothly — value = base × K^(acc/CYCLE). The visual
	 * phase runs on VIS_CYCLE (500px), de-aliased from the ≈100px mouse
	 * notch that phase-locked a 100px period into a frozen sphere. The
	 * phase is CENTERED (−½…+½) with an OFFSET parking the open point at
	 * scale 1.0 — the sphere nearly fills the pane at open, a ⅓-notch of
	 * grow-room below the full-bleed rollover, the whole decade below it
	 * on wheel-down. The base is captured at open and the odometer
	 * zeroes, so the window always opens at this size regardless of the
	 * textbox value.
	 * floorLinear (when given) keeps the distance from crossing 0 —
	 * bagels floor at the encircling 0: the antipode is the ROTATION's
	 * job, not the wheel's.
	 * Output on every change: the surface dot's direction in SCREEN
	 * space (the control's camera never moves) plus the consumer
	 * distance — toLinear/fromLinear map the multiplicative quantity
	 * (bagels multiply (1 + d/3), keeping signed distances meaningful)
	 */
	class VectorSphereControl {
		constructor() {
			this.root = null;
			this.scene = null;
			this.camera = null;
			this.renderer3d = null;
			this.group = null;
			this.sphereMesh = null;
			this.dotMesh = null;
			this.radialLine = null;
			this.titleEl = null;
			this.footer = null;
			// Footer widgets: a slider and a numeric textfield; lastDist
			// is the last emitted distance — the textfield restores it
			// when a typed value does not parse
			this.sliderEl = null;
			this.inputEl = null;
			this.lastDist = 0;
			this.startDist = 1;
			this.onChange = null;
			this.toLinear = null;
			this.fromLinear = null;
			// Unit-formatted value ('168px', '×1.20 gen0') — shown as the
			// textfield's hover tooltip on every emit
			this.distToReadout = null;
			this.distToInput = null;
			// Odometer constants: the value accumulates every CYCLE
			// wheel-pixels and never wraps; the VISUAL radius wraps on
			// its own LONGER period (VIS_CYCLE).
			// K is the per-notch value factor: one ≈100px wheel notch
			// multiplies the distance by ~0.7% — a fine smooth step, not
			// a big jump; coarse moves ride the slider/textfield
			this.K = 1.007;
			this.CYCLE = 100;
			// Ctrl+wheel spread: one notch widens the sibling angles by 4%
			this.SPREAD_K = 1.04;
			this.onSpread = null;
			// The visual sweep's period, DE-ALIASED from CYCLE: at
			// CYCLE = 100 the standard mouse notch (deltaY ≈ 100)
			// phase-locked the odometer — one notch = exactly one wrap =
			// the sphere never moved while the value flew. 500px = five
			// visible steps per decade on a notch wheel, still smooth on
			// the touchpad's small deltas
			this.VIS_CYCLE = 500;
			// The visual sweep's range and the open point inside it:
			// MAX_SCALE × 10^(phase−½) sweeps the decade [0.115, 1.15]
			// (min stays 1/10 of max); visOffset parks the odometer so
			// the open phase is 0.44 → scale 1.0 at open, ≈86% of the
			// canvas across, a ⅓-notch of grow-room below the full-bleed
			// rollover
			this.MAX_SCALE = 1.15;
			this.OPEN_SCALE = 1.0;
			this.visOffset = this.VIS_CYCLE * (0.5 + Math.log10(this.OPEN_SCALE / this.MAX_SCALE));
			this.wheelAcc = 0;
			this.baseLinear = 1;
			// 0 = no floor; bagels open with floorLinear 1 (dist ≥ 0 —
			// the encircling state, no wheel-driven antipode walk)
			this.floorLinear = 0;
			// The surface dot's ASSEMBLY-local direction; the group
			// rotation carries it around the fixed central dot
			this.dotDir = new THREE.Vector3(0, 1, 0);
			this.windowDrag = null;
		}

		// DOM + mini scene build once; open() re-arms per consumer
		ensureBuilt() {
			if (this.root) { return; }
			const root = document.createElement('div');
			root.className = 'vector-control';
			root.style.display = 'none';
			const header = document.createElement('div');
			header.className = 'vector-control-header';
			const title = document.createElement('span');
			title.className = 'vector-control-title';
			const closeBtn = document.createElement('button');
			closeBtn.className = 'vector-control-close';
			closeBtn.textContent = '×';
			header.appendChild(title);
			header.appendChild(closeBtn);
			const canvas = document.createElement('canvas');
			canvas.className = 'vector-control-canvas';
			// Sized to the viewport — a quarter of the smaller viewport
			// dimension, floored at 200px; open() re-applies it via
			// sizeCanvas() since the viewport may change between opens
			const controlSize = Math.max(200, Math.round(Math.min(window.innerWidth, window.innerHeight) / 4));
			canvas.width = controlSize;
			canvas.height = controlSize;
			const footer = document.createElement('div');
			footer.className = 'vector-control-footer';
			root.appendChild(header);
			root.appendChild(canvas);
			root.appendChild(footer);
			document.body.appendChild(root);
			this.root = root;
			this.titleEl = title;
			this.footer = footer;
			closeBtn.addEventListener('click', () => this.close());

			// Header drag repositions the window — pointer capture, the
			// legend precedent: the drag survives the cursor leaving
			header.addEventListener('pointerdown', (event) => {
				if (event.button !== 0) { return; }
				// The × press must reach its click handler — capturing
				// the pointer HERE would retarget the following
				// pointerup/click to the header and the window could
				// never close
				if (event.target === closeBtn) { return; }
				header.setPointerCapture(event.pointerId);
				const rect = root.getBoundingClientRect();
				this.windowDrag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
			});
			header.addEventListener('pointermove', (event) => {
				if (!this.windowDrag) { return; }
				// Clamp to the viewport — the legend drag precedent: an
				// off-screen window is a lost window; keep a grip
				const grip = 48;
				const rect = root.getBoundingClientRect();
				const left = Math.min(window.innerWidth - grip, Math.max(grip - rect.width,
					this.windowDrag.left + event.clientX - this.windowDrag.x));
				const top = Math.min(window.innerHeight - grip, Math.max(0,
					this.windowDrag.top + event.clientY - this.windowDrag.y));
				root.style.left = left + 'px';
				root.style.top = top + 'px';
				root.style.right = 'auto';
			});
			header.addEventListener('pointerup', () => { this.windowDrag = null; });

			// The mini scene: FIXED camera, no controls of its own —
			// drags rotate the assembly, the wheel zooms the sphere
			const scene = new THREE.Scene();
			const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
			camera.position.set(0, 0, 3.4);
			camera.lookAt(0, 0, 0);
			const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
			renderer.setPixelRatio(window.devicePixelRatio || 1);
			renderer.setSize(controlSize, controlSize, false);
			renderer.setClearColor(0x000000, 0);
			const group = new THREE.Group();
			scene.add(group);
			// The transparent shell holding the surface dot
			const sphereMesh = new THREE.Mesh(
				new THREE.SphereGeometry(1, 28, 18),
				new THREE.MeshBasicMaterial({ color: 0x8a7ca8, wireframe: true, transparent: true, opacity: 0.28 })
			);
			group.add(sphereMesh);
			// The central dot — the bound element's center; NEVER moves
			const centralDot = new THREE.Mesh(
				new THREE.SphereGeometry(0.045, 12, 12),
				new THREE.MeshBasicMaterial({ color: 0xffd700 })
			);
			group.add(centralDot);
			// The surface dot — the orientation carrier
			const dotMesh = new THREE.Mesh(
				new THREE.SphereGeometry(0.07, 14, 14),
				new THREE.MeshBasicMaterial({ color: 0x26c6da })
			);
			group.add(dotMesh);
			const lineGeometry = new THREE.BufferGeometry();
			lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
			const radialLine = new THREE.Line(
				lineGeometry,
				new THREE.LineBasicMaterial({ color: 0x9aa0a6, transparent: true, opacity: 0.5 })
			);
			group.add(radialLine);
			this.scene = scene;
			this.camera = camera;
			this.renderer3d = renderer;
			this.group = group;
			this.sphereMesh = sphereMesh;
			this.dotMesh = dotMesh;
			this.radialLine = radialLine;

			// Orientation: drag ARCBALL-rotates the assembly. PLAIN drag —
			// no Ctrl — the control window has no pan of its own for plain
			// drag to collide with, and Ctrl+drag keeps working through
			// the same handler. Shoemake trackball: cursor positions map
			// onto a virtual sphere filling the canvas; the rotation
			// carrying the grab point to the current point premultiplies
			// the assembly quaternion (the camera is fixed, so
			// screen-space premultiply is correct). Works at the poles —
			// Euler yaw/pitch locks a dot sitting ON the yaw axis
			// (captions default to screen-up (0,1,0)), so horizontal
			// drags would do nothing for them
			const arcballVector = (event) => {
				const rect = canvas.getBoundingClientRect();
				const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
				const y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
				const v = new THREE.Vector3(x, y, 0);
				const lenSq = x * x + y * y;
				if (lenSq <= 1) {
					v.z = Math.sqrt(1 - lenSq);
				} else {
					v.normalize();
				}
				return v;
			};
			let orientDrag = null;
			let rollDrag = null;
			canvas.addEventListener('pointerdown', (event) => {
				if (event.button !== 0) { return; }
				canvas.setPointerCapture(event.pointerId);
				if (event.shiftKey) {
					// Shift+drag ROLLS the assembly around the view axis —
					// the angle swept around the canvas center, the scene
					// roll's idiom
					const rect = canvas.getBoundingClientRect();
					rollDrag = Math.atan2(
						event.clientY - (rect.top + rect.height / 2),
						event.clientX - (rect.left + rect.width / 2));
					return;
				}
				orientDrag = arcballVector(event);
			});
			canvas.addEventListener('pointermove', (event) => {
				if (rollDrag !== null) {
					const rect = canvas.getBoundingClientRect();
					const next = Math.atan2(
						event.clientY - (rect.top + rect.height / 2),
						event.clientX - (rect.left + rect.width / 2));
					const TWO_PI = Math.PI * 2;
					const sweep = ((next - rollDrag + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
					rollDrag = next;
					// Screen atan2 runs clockwise-positive (y down); the
					// control camera sits at +Z, so the NEGATED sweep
					// about +Z turns the dot after the cursor
					const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -sweep);
					this.group.quaternion.premultiply(q);
					this.reseat();
					this.emit();
					this.paint();
					return;
				}
				if (!orientDrag) { return; }
				const next = arcballVector(event);
				const axis = new THREE.Vector3().crossVectors(orientDrag, next);
				if (axis.lengthSq() > 1e-12) {
					const dot = Math.min(1, Math.max(-1, orientDrag.dot(next)));
					const angle = Math.acos(dot);
					const q = new THREE.Quaternion().setFromAxisAngle(axis.normalize(), angle);
					this.group.quaternion.premultiply(q);
				}
				orientDrag = next;
				this.reseat();
				this.emit();
				this.paint();
			});
			canvas.addEventListener('pointerup', () => { orientDrag = null; rollDrag = null; });

			// Distance: the wheel zooms the SPHERE — the 3D view's zoom
			// idiom — and the surface dot stays glued on. Live in EVERY
			// mode: the radius IS the distance. Odometer: wheelAcc
			// accumulates pixels; reseat() wraps the VISUAL radius every
			// VIS_CYCLE px while emit() keeps the VALUE accumulating
			canvas.addEventListener('wheel', (event) => {
				event.preventDefault();
				// Ctrl+wheel goes to the consumer's SPREAD instead (the gen
				// shells: siblings apart, radius untouched) — a per-event
				// factor, SPREAD_K per notch; the distance odometer holds
				if (event.ctrlKey && this.onSpread) {
					const factor = Math.pow(this.SPREAD_K, -event.deltaY / this.CYCLE);
					this.onSpread(factor);
					return;
				}
				this.wheelAcc -= event.deltaY;
				this.reseat();
				this.emit();
				this.paint();
			}, { passive: false });
		}

		// The sphere radius visualizes the odometer PHASE — the decade
		// sweep MAX_SCALE × 10^(phase−½) ∈ [0.115, 1.15] (min stays 1/10
		// of max). visOffset parks the OPEN point at scale 1.0 — the
		// sphere nearly fills the pane at open. open() zeroes wheelAcc,
		// so the textbox value never changes the start size; wheel-up
		// grows the last ⅓-notch to the full-bleed top and rolls over to
		// the decade floor, wheel-down walks the whole decade first. The
		// dot rides the surface at every scale. The phase runs on
		// VIS_CYCLE (500px), NOT CYCLE — a 100px period phase-locks the
		// standard ≈100px mouse notch and the sphere never moves
		reseat() {
			const cycles = (this.wheelAcc + this.visOffset) / this.VIS_CYCLE;
			const phase = cycles - Math.floor(cycles + 0.5);
			const visualRadius = this.MAX_SCALE * Math.pow(10, phase - 0.5);
			this.sphereMesh.scale.setScalar(visualRadius);
			this.dotMesh.position.copy(this.dotDir).multiplyScalar(visualRadius);
			const positions = this.radialLine.geometry.attributes.position;
			positions.setXYZ(0, 0, 0, 0);
			positions.setXYZ(1, this.dotMesh.position.x, this.dotMesh.position.y, this.dotMesh.position.z);
			positions.needsUpdate = true;
		}

		emit() {
			// The VALUE never wraps — a smooth exponential over the whole
			// accumulator. floorLinear keeps bagels from crossing the
			// encircling 0
			const rawLinear = this.baseLinear * Math.pow(this.K, this.wheelAcc / this.CYCLE);
			const linear = Math.max(rawLinear, this.floorLinear);
			const distNow = this.fromLinear(linear);
			this.lastDist = distNow;
			if (this.sliderEl) {
				this.sliderEl.value = String(distNow);
			}
			// Never clobber a number the user is typing — the field
			// re-syncs on the next emit after the commit
			if (this.inputEl && document.activeElement !== this.inputEl) {
				this.inputEl.value = this.distToInput(distNow);
			}
			if (this.inputEl) {
				this.inputEl.title = this.distToReadout(distNow);
			}
			if (!this.onChange) { return; }
			// Direction in SCREEN space: the control camera never moves,
			// so the assembly rotation IS the screen re-orientation
			const dir = this.dotDir.clone().applyQuaternion(this.group.quaternion).normalize();
			const dist = distNow;
			this.onChange(dir, dist);
		}

		// Set the distance directly — the slider's drag and the
		// textfield's committed number both land here. Backs the wheel
		// accumulator out of the target so the odometer, the visual
		// sphere and the consumer all continue from the set value; a
		// typed number past the slider's end stretches the range to fit
		setDistance(dist) {
			const floorDist = this.fromLinear(Math.max(this.floorLinear, 1e-9));
			const clamped = Math.max(dist, floorDist);
			const linear = Math.max(this.toLinear(clamped), this.floorLinear, 1e-9);
			this.wheelAcc = this.CYCLE * Math.log(linear / this.baseLinear) / Math.log(this.K);
			if (this.sliderEl && clamped > Number(this.sliderEl.max)) {
				const widened = Math.ceil(clamped * 2);
				this.sliderEl.max = String(widened);
				this.sliderEl.step = String((widened - Number(this.sliderEl.min)) / 400);
			}
			this.reseat();
			this.emit();
			// The slider/textfield must ANIMATE the sphere too — the wheel
			// handler paints itself; this path would leave the visual stale
			this.paint();
		}

		// Footer = distance slider + numeric textfield (the read-only
		// readout is gone). The textfield IS the readout; the slider
		// covers floor…4× the open value with the textfield for precision
		buildFooter() {
			this.footer.innerHTML = '';
			const floorDist = this.fromLinear(Math.max(this.floorLinear, 1e-9));
			const maxDist = Math.max(this.startDist * 4, floorDist + 1);
			const slider = document.createElement('input');
			slider.type = 'range';
			slider.className = 'vector-control-slider';
			slider.min = String(floorDist);
			slider.max = String(maxDist);
			slider.step = String((maxDist - floorDist) / 400);
			slider.addEventListener('input', () => {
				this.setDistance(Number(slider.value));
			});
			const input = document.createElement('input');
			input.type = 'text';
			input.className = 'vector-control-input';
			input.spellcheck = false;
			input.title = 'Exact distance — Enter to apply';
			input.addEventListener('change', () => {
				const parsed = Number(input.value.replace(',', '.'));
				if (!Number.isFinite(parsed)) {
					input.value = this.distToInput(this.lastDist);
					return;
				}
				this.setDistance(parsed);
			});
			this.footer.appendChild(slider);
			this.footer.appendChild(input);
			this.sliderEl = slider;
			this.inputEl = input;
		}

		// Re-fit the window to the viewport — a quarter of the smaller
		// viewport dimension, floored at 200px; the viewport may have
		// changed between opens
		sizeCanvas() {
			const size = Math.max(200, Math.round(Math.min(window.innerWidth, window.innerHeight) / 4));
			const canvas = this.renderer3d.domElement;
			if (canvas.width !== size) {
				canvas.width = size;
				canvas.height = size;
				this.renderer3d.setSize(size, size, false);
			}
		}

		paint() {
			this.renderer3d.render(this.scene, this.camera);
		}

		open(opts) {
			this.ensureBuilt();
			this.sizeCanvas();
			this.onChange = opts.onChange;
			this.onSpread = opts.onSpread || null;
			this.renderer3d.domElement.title = opts.hint || '';
			this.toLinear = opts.toLinear || ((d) => d);
			this.fromLinear = opts.fromLinear || ((d) => d);
			this.distToReadout = opts.distToReadout || ((d) => '×' + d.toFixed(2));
			this.distToInput = opts.distToInput || ((d) => String(Math.round(d * 100) / 100));
			this.floorLinear = opts.floorLinear !== undefined ? opts.floorLinear : 0;
			this.dotDir.copy(opts.dir).normalize();
			this.group.quaternion.identity();
			// Open at NORMAL visual size (odometer phase 0) carrying the
			// current value as the base — wheeling continues from there,
			// infinitely, no re-open reset (the sphere always opens zoomed
			// normally, not retro-fitted to the current distance)
			const startDist = opts.dist !== undefined ? opts.dist : 1;
			this.startDist = startDist;
			this.baseLinear = Math.max(1e-6, this.toLinear(startDist));
			this.wheelAcc = 0;
			this.titleEl.textContent = opts.title || 'Vector';
			this.buildFooter();
			this.reseat();
			this.root.style.display = 'block';
			this.emit();
			this.paint();
		}

		close() {
			if (this.root) { this.root.style.display = 'none'; }
			this.onChange = null;
			this.onSpread = null;
		}

		isOpen() {
			const open = Boolean(this.root) && this.root.style.display !== 'none';
			return open;
		}
	}

	let vectorControl = null;
	// The consumer the window is currently armed for, keyed per ROW —
	// re-invoking the same row's ⌖ toggles the window SHUT (the × alone
	// is not enough), while a different row's ⌖ re-arms the OPEN window
	// for that row instead of closing it (no close-then-open dance)
	let vectorControlKey = null;

	/**
	 * Open the vector-sphere control for one of the consumers: captions →
	 * the caption vector (VIEW-space direction + distance multiplier),
	 * diamonds/bagels/sinks → WORLD-space direction + distance from the
	 * bound element's center, 'gen' → wheel-only radius in px (shells
	 * have no vector to orient, genSpec carries { depth, label, maxDepth,
	 * data, rebuild }). The Jaeger cone has no mode of its own — it rides
	 * the sinks orient. World consumers capture the main camera AT OPEN,
	 * so the control opens showing what the scene shows — the main scene
	 * is not rotated while the tool window is up
	 */
	function openVectorControl(mode, renderer, genSpec) {
		if (!vectorControl) {
			vectorControl = new VectorSphereControl();
		}
		// The gen rows share the one 'gen' mode — the depth discriminates
		const key = genSpec ? mode + ':' + String(genSpec.depth) : mode;
		if (vectorControlKey === key && vectorControl.isOpen()) {
			vectorControl.close();
			vectorControlKey = null;
			return;
		}
		vectorControlKey = key;
		const qCapture = renderer.camera.quaternion.clone();
		const qInverse = qCapture.clone().invert();
		if (mode === 'captions') {
			vectorControl.open({
				title         : 'Caption vector',
				dir           : renderer.captionVector.clone(),
				dist          : renderer.captionDist,
				distToReadout : (d) => '×' + d.toFixed(2),
				onChange      : (dirScreen, dist) => {
					renderer.captionVector.copy(dirScreen);
					renderer.captionDist = dist;
					sessionCaptionVector = { x: dirScreen.x, y: dirScreen.y, z: dirScreen.z, dist };
					renderer.labeledMeshes.forEach(m => renderer.updateLabelPosition(m));
					renderer.needsRender = true;
				}
			});
			return;
		}
		if (mode === 'diamonds') {
			const currentDir = renderer.diamondOrient ? renderer.diamondOrient.dir.clone() : new THREE.Vector3(1, 0, 0);
			const currentScale = renderer.diamondOrient ? renderer.diamondOrient.scale : 1;
			vectorControl.open({
				title         : 'Diamond orient',
				dir           : currentDir.applyQuaternion(qInverse),
				dist          : currentScale,
				distToReadout : (scale) => '×' + (renderer.layerDistances.creation.holderShell * scale).toFixed(2),
				onChange      : (dirScreen, scale) => {
					const world = dirScreen.clone().applyQuaternion(qCapture).normalize();
					const previous = renderer.diamondOrient;
					const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), world);
					// Pinned diamonds keep the user's arrangement: their
					// stored offsets rotate/stretch by the DELTA between
					// the old and new orient
					if (previous) {
						const delta = quaternion.clone().multiply(previous.quaternion.clone().invert());
						const ratio = scale / previous.scale;
						renderer.creationMeshes.forEach(m => {
							if (!m.userData.creationNode || !m.userData.pinned || !m.userData.pinOffset) { return; }
							m.userData.pinOffset.applyQuaternion(delta).multiplyScalar(ratio);
						});
					}
					renderer.diamondOrient = { quaternion, dir: world, scale };
					sessionDiamondOrient = {
						dir   : { x: world.x, y: world.y, z: world.z },
						scale : scale
					};
					renderer.updateLinkPositions();
				}
			});
			return;
		}
		if (mode === 'bagels') {
			// Distance in anchor radii, FLOORED at the encircling 0 —
			// the antipode is the ROTATION's job, not the wheel's.
			// The multiplicative odometer quantity is (1 + d/3); stale
			// saved negative distances self-heal — the first emit floors
			// them to 0
			const currentDir = renderer.bagelOrient ? renderer.bagelOrient.dir.clone() : new THREE.Vector3(1, 0, 0);
			const currentDist = renderer.bagelOrient ? renderer.bagelOrient.dist : 0;
			vectorControl.open({
				title         : 'Bagel orient',
				dir           : currentDir.applyQuaternion(qInverse),
				dist          : currentDist,
				toLinear      : (d) => 1 + d / 3,
				fromLinear    : (l) => (l - 1) * 3,
				floorLinear   : 1,
				distToReadout : (d) => '×' + d.toFixed(2),
				onChange      : (dirScreen, dist) => {
					const world = dirScreen.clone().applyQuaternion(qCapture).normalize();
					const previous = renderer.bagelOrient;
					if (previous) {
						const delta = new THREE.Quaternion().setFromUnitVectors(previous.dir, world);
						renderer.wrapperMeshes.forEach(m => {
							if (!m.userData.wrapperNode || !m.userData.pinned || !m.userData.pinOffset) { return; }
							m.userData.pinOffset.applyQuaternion(delta);
						});
					}
					renderer.bagelOrient = { dir: world, dist };
					sessionBagelOrient = {
						dir  : { x: world.x, y: world.y, z: world.z },
						dist : dist
					};
					renderer.updateLinkPositions();
				}
			});
			return;
		}
		if (mode === 'sinks') {
			// The adapter-sink stack's zone off the origin, in gen-0
			// radii (default layerDistances.dive.sinkOffset) — world-
			// space, the camera captured at open. The Jaeger cone rides
			// THIS orient too — jaegerSeat derives from sinkOrient
			const currentDir = renderer.sinkOrient ? renderer.sinkOrient.dir.clone() : new THREE.Vector3(-1, 0, 0);
			const currentDist = renderer.sinkOrient ? renderer.sinkOrient.dist : renderer.layerDistances.dive.sinkOffset;
			vectorControl.open({
				title         : 'Sink orient',
				dir           : currentDir.applyQuaternion(qInverse),
				dist          : currentDist,
				distToReadout : (d) => '×' + d.toFixed(2) + ' gen0',
				onChange      : (dirScreen, dist) => {
					const world = dirScreen.clone().applyQuaternion(qCapture).normalize();
					const previous = renderer.sinkOrient;
					// Pinned sinks keep the user's arrangement: their
					// offsets from the Jaeger cone rotate/stretch by the
					// DELTA between the old and new orient; pinned cones
					// (ABSOLUTE pins) take the same delta on their stored
					// positions so the whole company moves together
					if (previous) {
						const delta = new THREE.Quaternion().setFromUnitVectors(previous.dir, world);
						const ratio = dist / previous.dist;
						renderer.internalsMeshes.forEach(m => {
							const knot = m.userData.internalNode;
							if (!knot || !m.userData.pinned) { return; }
							if (knot.role === 'external') {
								m.position.applyQuaternion(delta).multiplyScalar(ratio);
								return;
							}
							if (knot.role !== 'sink' || !m.userData.pinOffset) { return; }
							m.userData.pinOffset.applyQuaternion(delta).multiplyScalar(ratio);
						});
					}
					renderer.sinkOrient = { dir: world, dist };
					sessionSinkOrient = {
						dir  : { x: world.x, y: world.y, z: world.z },
						dist : dist
					};
					renderer.updateLinkPositions();
				}
			});
			return;
		}
		if (mode === 'gen') {
			// Generation shell radius: shells have NO vector to orient —
			// the wheel IS the control here, the assembly rotation is
			// inert for this mode. No debounced full rebuild — the
			// cascade's ratios reseat the spheres radially in place, the
			// dynamics chain and the labels follow live, only the px
			// readouts refresh
			vectorControl.open({
				title         : genSpec.label + ' radius',
				dir           : new THREE.Vector3(0, 1, 0),
				dist          : (renderer.depthRadii && renderer.depthRadii.get(genSpec.depth)) || 0,
				floorLinear   : 10,
				distToReadout : (d) => Math.round(d) + 'px',
				distToInput   : (d) => String(Math.round(d)),
				hint          : 'Wheel: shell radius · Ctrl+wheel: spread siblings apart',
				onSpread      : (factor) => {
					spreadLevel(renderer, genSpec.depth, factor);
					renderer.updateLinkPositions();
					renderer.labeledMeshes.forEach(m => renderer.updateLabelPosition(m));
					renderer.needsRender = true;
				},
				onChange      : (dirScreen, dist) => {
					const current = (renderer.depthRadii && renderer.depthRadii.get(genSpec.depth)) || 0;
					const delta = dist - current;
					if (Math.abs(delta) < 1e-9) { return; }
					const ratios = cascadeShellRadii(renderer, genSpec.data, genSpec.depth, genSpec.maxDepth, delta);
					reseatTypeSpheresLive(renderer, ratios);
					renderer.updateLinkPositions();
					renderer.labeledMeshes.forEach(m => renderer.updateLabelPosition(m));
					refreshGenReadouts(renderer);
				}
			});
		}
	}

	// Legend panel interactivity: the header is the drag handle AND the
	// collapse toggle. A press that moves < 4px counts as a click
	// (toggle); a real drag repositions the panel. First drag switches
	// the CSS bottom-anchoring to explicit left/top — bottom anchoring
	// fights pixel dragging.
	// Details:
	// (a) the anchor switch happens at the FIRST REAL MOVE, not on
	//     press — switching on mousedown would re-anchor a plain
	//     collapse CLICK to top, so collapsing at the initial spot
	//     would lift the panel off the viewport bottom; with the CSS
	//     bottom anchor intact, collapse docks the panel to the viewport
	//     bottom (the top corners move down);
	// (b) the drag rides pointer events with pointer capture on the
	//     header: the cursor leaving the legend (or even the window)
	//     keeps the drag, and the scene canvas never sees the gesture —
	//     its mousemove treats any button-held move as a grab-the-world
	//     pan and its stopPropagation would freeze the document-level
	//     drag (a release over the canvas can even leave the drag
	//     stuck). The canvas handlers ALSO bail on legendDragState as
	//     belt and suspenders;
	// (c) expanding a dragged legend clamps the box back into the
	//     viewport — it grows down/right from its top anchor and the
	//     scene borders would clip the rows. Collapse shrink-wraps to
	//     the header (the smaller width is intentionally correct); the
	//     header's column-gap (webview.css) keeps the arrow off the word.
	let legendDragState = null;
	let legendSuppressClick = false;

	function setupLegend() {
		const legend = document.getElementById('dive-legend');
		const header = document.getElementById('dive-legend-header');
		const toggle = document.getElementById('dive-legend-toggle');
		if (!legend || !header) return;

		header.addEventListener('pointerdown', function (event) {
			if (event.button !== 0) return;
			// A fresh gesture never inherits suppression: if a drag ended
			// with no trailing click (released off-window under capture),
			// the stale flag must not eat THIS gesture's click
			legendSuppressClick = false;
			const rect = legend.getBoundingClientRect();
			// Capture retargets every pointermove/pointerup to the header
			// until release — the drag survives the cursor leaving the
			// legend, and compatibility mouse events follow the capture,
			// so the canvas never starts a pan/rotate mid-drag
			header.setPointerCapture(event.pointerId);
			legendDragState = {
				startX: event.clientX,
				startY: event.clientY,
				baseLeft: rect.left,
				baseTop: rect.top,
				moved: false
			};
			event.preventDefault();
		});

		header.addEventListener('pointermove', function (event) {
			if (!legendDragState) return;
			const dx = event.clientX - legendDragState.startX;
			const dy = event.clientY - legendDragState.startY;
			if (!legendDragState.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
			if (!legendDragState.moved) {
				// First real movement: NOW switch bottom-anchoring to
				// explicit left/top (bottom anchoring fights pixel
				// dragging). A press that never crosses the threshold keeps
				// the CSS bottom anchor, so collapse at the initial spot
				// docks the panel to the viewport bottom
				legendDragState.moved = true;
				legend.classList.add('dragging');
				legend.style.bottom = 'auto';
				legend.style.left = legendDragState.baseLeft + 'px';
				legend.style.top = legendDragState.baseTop + 'px';
			}
			const maxLeft = Math.max(0, window.innerWidth - legend.offsetWidth);
			const maxTop = Math.max(0, window.innerHeight - legend.offsetHeight);
			const nextLeft = Math.min(maxLeft, Math.max(0, legendDragState.baseLeft + dx));
			const nextTop = Math.min(maxTop, Math.max(0, legendDragState.baseTop + dy));
			legend.style.left = nextLeft + 'px';
			legend.style.top = nextTop + 'px';
		});

		header.addEventListener('pointerup', function (event) {
			if (!legendDragState) return;
			if (legendDragState.moved) {
				// pointerup fires BEFORE click — swallow the trailing
				// click so a drag does not also toggle collapse
				legendSuppressClick = true;
			}
			legendDragState = null;
			legend.classList.remove('dragging');
			if (header.hasPointerCapture(event.pointerId)) {
				header.releasePointerCapture(event.pointerId);
			}
		});

		header.addEventListener('pointercancel', function () {
			// No click follows a cancel — just clean up, never suppress
			legendDragState = null;
			legend.classList.remove('dragging');
		});

		header.addEventListener('click', function () {
			if (legendSuppressClick) {
				legendSuppressClick = false;
				return;
			}
			const collapsed = legend.classList.toggle('collapsed');
			if (toggle) {
				toggle.textContent = collapsed ? '▸' : '▾';
			}
			if (!collapsed && legend.style.bottom === 'auto') {
				// Expanding a dragged legend: the box grows down (and
				// right — the rows are wider than the bare header) from
				// its top anchor, and the scene borders clip whatever
				// overflows — uncollapsing must become fully visible.
				// Shift it back into the viewport. The never-dragged
				// legend grows UP from its CSS bottom anchor — always in
				// view, nothing to clamp
				const rect = legend.getBoundingClientRect();
				const overflowX = rect.right - window.innerWidth;
				const overflowY = rect.bottom - window.innerHeight;
				if (overflowX > 0) {
					legend.style.left = Math.max(0, rect.left - overflowX) + 'px';
				}
				if (overflowY > 0) {
					legend.style.top = Math.max(0, rect.top - overflowY) + 'px';
				}
			}
		});
	}

	// Layers & Distances collapse + drag — the legend idiom verbatim: the
	// header is the drag handle AND the collapse toggle — < 4px is a
	// click (toggle), a real drag repositions; the first move switches
	// the CSS right-anchoring to explicit left/top (right anchoring
	// fights pixel dragging); pointer capture keeps the gesture when the
	// cursor leaves the panel and keeps the scene canvas from starting a
	// pan mid-drag (the canvas handlers bail on genControlsDragState as
	// belt and suspenders); expanding a dragged panel clamps it back
	// into the viewport. CSS hides #layer-controls-list when collapsed;
	// the header stays as the affordance to reopen
	let genControlsDragState = null;
	let genControlsSuppressClick = false;

	function setupGenControlsCollapse() {
		const panel = document.getElementById('gen-controls');
		const header = document.getElementById('gen-controls-header');
		const toggle = document.getElementById('gen-controls-toggle');
		if (!panel || !header) return;

		header.addEventListener('pointerdown', function (event) {
			if (event.button !== 0) return;
			// A fresh gesture never inherits suppression (the legend
			// precedent): a stale flag must not eat THIS gesture's click
			genControlsSuppressClick = false;
			const rect = panel.getBoundingClientRect();
			// Capture retargets every pointermove/pointerup to the
			// header until release — the drag survives the cursor
			// leaving the panel (or the window), and compatibility
			// mouse events follow the capture, so the scene canvas
			// never starts a pan/rotate mid-drag
			header.setPointerCapture(event.pointerId);
			genControlsDragState = {
				startX: event.clientX,
				startY: event.clientY,
				baseLeft: rect.left,
				baseTop: rect.top,
				moved: false
			};
			event.preventDefault();
		});

		header.addEventListener('pointermove', function (event) {
			if (!genControlsDragState) return;
			const dx = event.clientX - genControlsDragState.startX;
			const dy = event.clientY - genControlsDragState.startY;
			if (!genControlsDragState.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
			if (!genControlsDragState.moved) {
				// First real movement: NOW switch right-anchoring to
				// explicit left/top — a plain collapse CLICK must keep the
				// CSS anchor, or collapsing at the initial spot would jump
				// the panel
				genControlsDragState.moved = true;
				panel.classList.add('dragging');
				panel.style.right = 'auto';
				panel.style.left = genControlsDragState.baseLeft + 'px';
				panel.style.top = genControlsDragState.baseTop + 'px';
			}
			const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
			const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
			const nextLeft = Math.min(maxLeft, Math.max(0, genControlsDragState.baseLeft + dx));
			const nextTop = Math.min(maxTop, Math.max(0, genControlsDragState.baseTop + dy));
			panel.style.left = nextLeft + 'px';
			panel.style.top = nextTop + 'px';
		});

		header.addEventListener('pointerup', function (event) {
			if (!genControlsDragState) return;
			if (genControlsDragState.moved) {
				// pointerup fires BEFORE click — swallow the trailing
				// click so a drag does not also toggle collapse
				genControlsSuppressClick = true;
			}
			genControlsDragState = null;
			panel.classList.remove('dragging');
			if (header.hasPointerCapture(event.pointerId)) {
				header.releasePointerCapture(event.pointerId);
			}
		});

		header.addEventListener('pointercancel', function () {
			// No click follows a cancel — just clean up, never suppress
			genControlsDragState = null;
			panel.classList.remove('dragging');
		});

		header.addEventListener('click', function () {
			if (genControlsSuppressClick) {
				genControlsSuppressClick = false;
				return;
			}
			const collapsed = panel.classList.toggle('collapsed');
			if (toggle) {
				toggle.textContent = collapsed ? '▸' : '▾';
			}
			if (!collapsed && panel.style.right === 'auto') {
				// Expanding a DRAGGED panel: the rows grow down from
				// the top anchor and the scene borders clip whatever
				// overflows — uncollapsing must become fully visible —
				// shift it back. The never-dragged panel keeps its CSS
				// top/right anchor, always in view, nothing to clamp
				const rect = panel.getBoundingClientRect();
				const overflowX = rect.right - window.innerWidth;
				const overflowY = rect.bottom - window.innerHeight;
				if (overflowX > 0) {
					panel.style.left = Math.max(0, rect.left - overflowX) + 'px';
				}
				if (overflowY > 0) {
					panel.style.top = Math.max(0, rect.top - overflowY) + 'px';
				}
			}
		});
	}

	function setupEventListeners() {
		// Control buttons (the wheel IS the zoom; the renderer's
		// zoomIn/zoomOut methods stay as automation API)
		document.getElementById('reset').addEventListener('click', function () {
			if (renderer3D) {
				renderer3D.reset();
			}
		});

		// Save button: persist the current arrangement — user-placed
		// spheres, pinned elements, camera — to .mnemographica/layout.json
		// via the host (the webview cannot write files itself)
		const saveButton = document.getElementById('save-layout');
		if (saveButton) {
			saveButton.addEventListener('click', function () {
				if (!renderer3D || !currentData) { return; }
				const layout = renderer3D.collectLayout(currentData);
				vscode.postMessage({ command: 'saveLayout', data: layout });
				// Same focus rule as the layer checkboxes — a focused
				// button re-fires on Space
				saveButton.blur();
			});
		}

		// Export button: pack the current graph + arrangement into a
		// single self-contained HTML page (assembleExportHtml) and hand
		// it to the host to write — the webview cannot write files
		const exportButton = document.getElementById('export-html');
		if (exportButton) {
			exportButton.addEventListener('click', async function () {
				// Same focus rule as the Save button
				exportButton.blur();
				if (!renderer3D || !currentData) { return; }
				setStatusBase('Packing the graph…');
				try {
					const html = await assembleExportHtml();
					vscode.postMessage({ command : 'exportHtml', data : html });
				} catch (err) {
					setStatusBase('Export failed: ' + (err && err.message ? err.message : String(err)));
				}
			});
		}

		// Refresh button: the host re-reads THIS panel's .tactica and
		// pushes a fresh updateGraph; the tab holds its render until
		// asked. Camera/pins survive — the update rides the same
		// savedLayout + sessionPins path as any refresh
		const refreshButton = document.getElementById('refresh-graph');
		if (refreshButton) {
			refreshButton.addEventListener('click', function () {
				vscode.postMessage({ command: 'refreshGraph' });
				// Same focus rule as the Save button
				refreshButton.blur();
			});
		}

		// Collection selector: one collection's universe per render. The
		// host owns the data — switching posts the pick and the host
		// re-reads .tactica for that collection, the same path Refresh
		// takes; options arrive with each updateGraph payload
		const collectionSelect = document.getElementById('collection-select');
		if (collectionSelect) {
			collectionSelect.addEventListener('change', function () {
				vscode.postMessage({ command: 'selectCollection', data: { id: collectionSelect.value } });
				// Same focus rule as the Save button
				collectionSelect.blur();
			});
		}

		// 3D-only: the mode toggle buttons no longer exist in the DOM.
	}

	// The live WebXR session (toggleVr), null outside VR
	let xrSession = null;
	// True while requestSession is pending: the runtime may take tens of
	// seconds (Quest Link), and a second request would only be rejected
	let xrRequestPending = false;
	// The status line the VR messages replace, restored when they end
	let xrStatusBefore = null;
	// The no-frames watchdog of the live session (startXrWatchdog)
	let xrWatchdog = null;
	// An updateGraph arriving mid-session waits for the session to end:
	// a rebuild swaps the WebGL renderer, which the session cannot follow.
	// Only the newest one matters — it replays when VR ends (leaveVr)
	let deferredGraphUpdate = null;
	// VR waits: past XR_SLOW_REQUEST_MS the pending request gets a hint,
	// a visible session without a frame for XR_NO_FRAMES_MS is reported
	const XR_SLOW_REQUEST_MS = 10000;
	const XR_NO_FRAMES_MS = 5000;

	async function immersiveVrSupported() {
		if (!navigator.xr || typeof navigator.xr.isSessionSupported !== 'function') {
			return false;
		}
		try {
			const supported = await navigator.xr.isSessionSupported('immersive-vr');
			return supported;
		} catch (err) {
			// A permissions policy without xr-spatial-tracking rejects
			return false;
		}
	}

	// The 🥽 VR button. Where this page can open an immersive-vr session
	// itself — Chrome/Edge with an OpenXR runtime such as Meta Quest
	// Link, i.e. the VR bridge page — it enters VR in place. Editor
	// webviews cannot (VS Code's webview iframe withholds the
	// xr-spatial-tracking permission): there the button asks the host to
	// serve this graph to the system browser ('openVR')
	function setupVrButton() {
		const button = document.getElementById('vr-mode');
		if (!button) { return; }
		immersiveVrSupported().then(function (supported) {
			if (supported) {
				button.title = 'Enter VR (WebXR immersive-vr)';
				button.style.display = '';
				button.addEventListener('click', function () {
					button.blur();
					void toggleVr(button);
				});
				return;
			}
			if (window.__MNEMO_VR_BRIDGE__) {
				// The bridge page in a browser without a VR runtime
				button.title = 'No WebXR VR runtime here: open this page in Chrome or Edge with Meta Quest Link as the active OpenXR runtime, then reload';
				button.disabled = true;
				button.style.display = '';
				return;
			}
			button.title = 'Open this graph in the system browser for VR (Chrome/Edge + Meta Quest Link)';
			button.style.display = '';
			button.addEventListener('click', function () {
				button.blur();
				vscode.postMessage({ command: 'openVR' });
			});
		});
	}

	// VR progress and trouble ride the status line; the graph's own
	// status comes back once they are over (restoreVrStatus)
	function showVrStatus(text) {
		if (xrStatusBefore === null) {
			xrStatusBefore = lastStatusBase;
		}
		setStatusBase(text);
	}

	function restoreVrStatus() {
		if (xrStatusBefore !== null) {
			const before = xrStatusBefore;
			xrStatusBefore = null;
			setStatusBase(before);
		}
	}

	// A session the runtime accepted can still deliver no frames (Quest
	// Link was seen reporting FOCUSED while the page got none) — the
	// headset then shows a hung app and the page looks frozen. While the
	// session is visible, a frame gap past XR_NO_FRAMES_MS is reported;
	// a hidden session (headset off) legitimately pauses frames
	function startXrWatchdog(xrRenderer, session) {
		stopXrWatchdog();
		const startedAt = performance.now();
		let reported = false;
		xrWatchdog = setInterval(function () {
			const xr = xrRenderer.xr;
			if (!xr || session.visibilityState !== 'visible') { return; }
			const lastFrame = xr.lastFrameAt || startedAt;
			const stalled = performance.now() - lastFrame > XR_NO_FRAMES_MS;
			if (stalled && !reported) {
				reported = true;
				showVrStatus(xr.frames
					? 'VR: the headset runtime stopped delivering frames — 🥽 Exit VR, then restart Quest Link or the browser'
					: 'VR: the session started but the headset runtime delivers no frames — 🥽 Exit VR, then restart Quest Link or the browser');
			} else if (!stalled && reported) {
				reported = false;
				restoreVrStatus();
			}
		}, 1000);
	}

	function stopXrWatchdog() {
		if (xrWatchdog) {
			clearInterval(xrWatchdog);
			xrWatchdog = null;
		}
	}

	async function toggleVr(button) {
		if (xrSession) {
			await xrSession.end();
			return;
		}
		if (!renderer3D || xrRequestPending) { return; }
		xrRequestPending = true;
		button.disabled = true;
		button.textContent = '🥽 Entering VR…';
		showVrStatus('Entering VR — waiting for the headset runtime…');
		const slowHint = setTimeout(function () {
			showVrStatus('Still waiting for the VR runtime: is the headset on and awake? With Quest Link, Link must be running and set as the OpenXR runtime');
		}, XR_SLOW_REQUEST_MS);
		let session;
		try {
			session = await navigator.xr.requestSession('immersive-vr', {
				optionalFeatures : ['local-floor', 'bounded-floor', 'hand-tracking']
			});
		} catch (err) {
			setStatusBase('VR unavailable: ' + (err && err.message ? err.message : String(err)));
			xrStatusBefore = null;
			return;
		} finally {
			clearTimeout(slowHint);
			xrRequestPending = false;
			button.disabled = false;
			button.textContent = '🥽 VR';
		}
		restoreVrStatus();
		xrSession = session;
		button.textContent = '🥽 Exit VR';
		// The renderer that entered owns the exit — three fires
		// 'sessionend' once it has restored its own canvas state
		const xrRenderer = renderer3D;
		const onSessionEnd = function () {
			xrRenderer.renderer.xr.removeEventListener('sessionend', onSessionEnd);
			leaveVr(xrRenderer, button);
		};
		xrRenderer.renderer.xr.addEventListener('sessionend', onSessionEnd);
		try {
			await xrRenderer.enterXR(session);
			startXrWatchdog(xrRenderer, session);
		} catch (err) {
			xrRenderer.renderer.xr.removeEventListener('sessionend', onSessionEnd);
			leaveVr(xrRenderer, button);
			session.end().catch(function () {});
			setStatusBase('VR failed: ' + (err && err.message ? err.message : String(err)));
		}
	}

	function leaveVr(xrRenderer, button) {
		stopXrWatchdog();
		restoreVrStatus();
		xrRenderer.exitXR();
		xrSession = null;
		button.textContent = '🥽 VR';
		if (deferredGraphUpdate) {
			// Re-dispatched through the message handler: now outside VR
			// it rebuilds like any updateGraph
			const message = deferredGraphUpdate;
			deferredGraphUpdate = null;
			window.postMessage(message, '*');
		}
	}

	// The exported file must be shareable as-is (GitHub included), so the
	// bundle is scrubbed: locations/file paths are garbage there and go
	// in EVERY export; diamond/bagel ids ARE scope ids and call sites
	// (paths), so they become indexed diamond_N/bagel_N in every export
	// too. The anonymised export goes further — every real name becomes
	// an indexed placeholder (sphere_N/knot_N, collections renamed) and
	// properties/snippets/labels are wiped. Renames are applied
	// consistently across the bundle AND the saved layout (pins and
	// caption overrides key off the same ids)
	function scrubExportBundle(data, layout, anonymize) {
		const sphere = new Map();  // type fullPath -> sphere_N (anonymize only)
		const diamond = new Map(); // scopeId -> diamond_N (always — ids ARE paths)
		const bagel = new Map();   // wrap site -> bagel_N (always — ids ARE locations)
		const knot = new Map();    // knot id -> knot_N (anonymize only)
		const through = (map, value) => (map.has(value) ? map.get(value) : value);

		data.nodes.forEach((node, index) => {
			if (anonymize) { sphere.set(node.id, 'sphere_' + index); }
		});
		if (anonymize && data.internals && Array.isArray(data.internals.nodes)) {
			data.internals.nodes.forEach((node, index) => {
				knot.set(node.id, 'knot_' + index);
			});
		}
		if (data.creation && Array.isArray(data.creation.nodes)) {
			data.creation.nodes.forEach((node, index) => {
				diamond.set(node.id, 'diamond_' + index);
			});
		}
		if (data.wrappers && Array.isArray(data.wrappers.nodes)) {
			data.wrappers.nodes.forEach((node, index) => {
				bagel.set(node.id, 'bagel_' + index);
			});
		}
		const sphereId = (old) => (anonymize ? through(sphere, old) : old);
		const knotId = (old) => (anonymize ? through(knot, old) : old);

		// type spheres: locations always; names and fields in anonymize
		data.nodes.forEach((node, index) => {
			delete node.location;
			delete node.definitionLocation;
			delete node.instrumentation; // className/scope/code payload
			(node.edsEntries || []).forEach((entry) => {
				delete entry.location;
				delete entry.parsedLocation;
				delete entry.code;
				delete entry.scope; // a scope key is a path
			});
			if (anonymize) {
				node.id = sphere.get(node.id);
				node.name = node.id;
				node.properties = [];
				node.edsEntries = [];
			}
		});
		data.links.forEach((link) => {
			link.source = sphereId(link.source);
			link.target = sphereId(link.target);
		});
		(data.execflow || []).forEach((edge) => {
			delete edge.location;
			edge.source = sphereId(typeof edge.source === 'object' ? edge.source.id : edge.source);
			edge.target = sphereId(typeof edge.target === 'object' ? edge.target.id : edge.target);
			if (anonymize) { delete edge.code; }
		});

		// creation diamonds: the id IS a scopeId — indexed in every export
		if (data.creation) {
			data.creation.nodes.forEach((node) => {
				const id = diamond.get(node.id) || node.id;
				node.id = id;
				node.name = id; // scope basenames are path fragments
				delete node.location;
				delete node.filePath;
				(node.creates || []).forEach((anchor) => {
					anchor.typePath = sphereId(anchor.typePath);
					if (anchor.terminatedAt) { anchor.terminatedAt = sphereId(anchor.terminatedAt); }
					delete anchor.location;
					if (anonymize) {
						delete anchor.constructorText;
						delete anchor.variable;
					}
				});
			});
			(data.creation.links || []).forEach((link) => {
				link.source = through(diamond, link.source);
				link.target = through(diamond, link.target);
			});
		}

		// wrapper bagels: the id IS the call-site location — indexed always
		if (data.wrappers) {
			data.wrappers.nodes.forEach((node) => {
				const id = bagel.get(node.id) || node.id;
				node.id = id;
				node.name = id; // "basename:line" is a path fragment
				delete node.location;
				if (node.callbackScopeId) { node.callbackScopeId = through(diamond, node.callbackScopeId); }
				if (node.holderScopeId) { node.holderScopeId = through(diamond, node.holderScopeId); }
				if (node.wrapsTypePath) { node.wrapsTypePath = sphereId(node.wrapsTypePath); }
				if (node.hostTypePath) { node.hostTypePath = sphereId(node.hostTypePath); }
				if (anonymize) {
					delete node.code;
					delete node.label;
				}
			});
			(data.wrappers.links || []).forEach((link) => {
				link.source = through(bagel, link.source);
				link.target = through(bagel, link.target);
				if (link.viaType) { link.viaType = sphereId(link.viaType); }
			});
		}

		// internals knots: the citation points into a repo — always gone
		if (data.internals) {
			(data.internals.nodes || []).forEach((node) => {
				delete node.citation;
				if (anonymize) {
					node.id = knotId(node.id);
					node.name = node.id;
				}
			});
			(data.internals.links || []).forEach((link) => {
				link.source = knotId(link.source);
				link.target = knotId(link.target);
				if (anonymize) { delete link.label; }
			});
			// attachHooks graft endpoints are type ids — renamed with them
			if (Array.isArray(data.internals.grafts)) {
				data.internals.grafts = data.internals.grafts.map(sphereId);
			}
		}

		// collections: inventory names can be as revealing as type names
		if (anonymize && data.collection && data.collection !== '*' && Array.isArray(data.collections)) {
			const index = data.collections.findIndex((c) => c.id === data.collection);
			const renamed = 'collection_' + (index >= 0 ? index + 1 : 1);
			data.collections.forEach((entry, i) => {
				entry.id = 'collection_' + (i + 1);
				entry.name = entry.id;
			});
			data.collection = renamed;
		}

		// the saved layout keys off the same ids — remap with the same maps
		if (layout) {
			if (anonymize && layout.nodes) {
				const remapped = {};
				Object.keys(layout.nodes).forEach((key) => {
					remapped[through(sphere, key)] = layout.nodes[key];
				});
				layout.nodes = remapped;
			}
			if (layout.pins) {
				const remapped = {};
				Object.keys(layout.pins).forEach((key) => {
					remapped[through(sphere, through(diamond, through(bagel, through(knot, key))))] = layout.pins[key];
				});
				layout.pins = remapped;
			}
			const overrides = layout.orient && layout.orient.captionOverrides;
			if (overrides) {
				const remapped = {};
				Object.keys(overrides).forEach((key) => {
					remapped[through(sphere, through(diamond, through(bagel, through(knot, key))))] = overrides[key];
				});
				layout.orient.captionOverrides = remapped;
			}
		}
	}

	// Export HTML (the ⤓ button): pack the CURRENT graph into a single
	// self-contained page — this page's own script and stylesheet,
	// three.js and d3 fetched from their CDNs and inlined, plus the
	// current arrangement (collectLayout, the Save button's collector) —
	// so it renders anywhere, offline, e.g. iframed into talk slides.
	// The skeleton with its placeholders arrived embedded in this page
	// (panel.ts derives it from the very template it serves); the host
	// only writes the assembled file
	async function assembleExportHtml() {
		const skeleton = window.__MNEMO_EXPORT_SKELETON__;
		if (typeof skeleton !== 'string' || skeleton.length === 0) {
			throw new Error('export skeleton missing — reopen the panel');
		}
		const layout = renderer3D.collectLayout(currentData);
		// A literal '</script' inside inlined JS would terminate the host
		// script early; '<\/' is byte-identical inside JS strings and
		// regexes and never occurs as live code
		const inlineJs = (src) => src.replace(/<\/script/gi, '<\\/script');
		const pickText = async (url) => {
			const res = await fetch(url);
			if (!res.ok) { throw new Error('could not fetch ' + url); }
			return await res.text();
		};
		const cssLink = document.querySelector('link[rel="stylesheet"]');
		const appScript = document.querySelector('script[src*="webview.js"]');
		const d3Script = document.querySelector('script[src*="d3"]');
		const threeScript = document.querySelector('script[src*="three"]');
		if (!cssLink || !appScript || !d3Script || !threeScript) {
			throw new Error('page resources not found');
		}
		const [css, app, d3src, threesrc] = await Promise.all([
			pickText(cssLink.href),
			pickText(appScript.src),
			pickText(d3Script.src),
			pickText(threeScript.src)
		]);
		// The exported page mirrors THIS view, minus the invocation path
		// filter: its text is path-shaped and the filter is dead anyway
		// once the bundle loses filePath (scrubExportBundle). The
		// collection selector hides — switching collections is a host
		// round-trip the export cannot serve; the current universe is
		// frozen into the data
		const settings = { alwaysShowCollectionSelector : false };
		// renderGraph MUTATES the data it renders: nodes gain children
		// arrays and parent back-references (source↔target cycles), link
		// endpoints resolve to node objects. All of it is render-derived
		// and rebuilt on every render — the bundle strips it (else
		// JSON.stringify dies on the cycle) and normalizes link endpoints
		// back to their id strings
		const bundleData = JSON.parse(JSON.stringify(currentData, (key, value) => {
			if (key === 'parent' || key === 'children') { return undefined; }
			if ((key === 'source' || key === 'target') &&
				value && typeof value === 'object' && typeof value.id === 'string') {
				return value.id;
			}
			return value;
		}));
		// Anonymised export (talk mode): exported while the captions flag
		// is OFF, the page becomes a pure shape — no captions, no names,
		// no tooltips (webview.js reads the flag). The mode rides a bare
		// global, not the data bundle
		const anonymize = renderer3D ? !renderer3D.captionsVisible : false;
		scrubExportBundle(bundleData, layout, anonymize);
		const boot = 'const SHOW_PROPERTIES_PLACEHOLDER = ' + String(Boolean(SHOW_PROPERTIES_PLACEHOLDER)) + ';\n'
			+ 'window.__MNEMO_ANONYMIZE__ = ' + String(anonymize) + ';\n'
			+ 'window.__MNEMO_EXPORT_BOOT__ = ' + JSON.stringify({ graphData : bundleData, layout : layout, settings : settings }).replace(/</g, '\\u003c') + ';\n'
			+ EXPORT_BOOT_STUB + (anonymize ? '' : '\n' + EXPORT_CONNECT_PANEL);
		let html = skeleton
			.replace('/*__MNEMO_CSS__*/', () => EXPORT_CSS_FALLBACKS + css)
			.replace('/*__MNEMO_D3__*/', () => inlineJs(d3src))
			.replace('/*__MNEMO_THREE__*/', () => inlineJs(threesrc))
			.replace('/*__MNEMO_APP__*/', () => inlineJs(app))
			.replace('/*__MNEMO_BOOT__*/', () => inlineJs(boot));
		if (currentData.collection && !anonymize) {
			html = html.replace('<title>Mnemonica Graph</title>', '<title>Mnemonica Graph — ' + String(currentData.collection) + '</title>');
		}
		return html;
	}

	// Selector value for the combined all-collections view — mirrors
	// ALL_COLLECTIONS in src/utils/collections.ts (the webview loads no
	// project modules)
	const ALL_COLLECTIONS = '*';
	// The default collection sorts first among the named options
	const DEFAULT_COLLECTION = 'defaultTypes';

	// The collection selector lists the combined view first, then every
	// collection tactica reported — defaultTypes ahead, the rest
	// alphabetical by display label. It hides only for a
	// single-collection project when the
	// `mnemographica.alwaysShowCollectionSelector` setting is off.
	// Options rebuild only when the inventory changes — a Refresh must
	// not collapse an open dropdown or reset a mid-gesture pick
	function updateCollectionSelect(data) {
		const select = document.getElementById('collection-select');
		if (!select) { return; }
		const collections = data && data.collections;
		if (!Array.isArray(collections) || collections.length === 0) {
			select.style.display = 'none';
			return;
		}
		if (collections.length < 2 && !sessionUiSettings.alwaysShowCollectionSelector) {
			select.style.display = 'none';
			return;
		}
		const signature = collections.map(function (c) { return c.id + ':' + c.count + ':' + (c.name || ''); }).join('|');
		if (select.dataset.signature !== signature) {
			select.dataset.signature = signature;
			select.innerHTML = '';
			const allOption = document.createElement('option');
			allOption.value = ALL_COLLECTIONS;
			allOption.textContent = 'all collections';
			select.appendChild(allOption);
			const sorted = collections.slice().sort(function (a, b) {
				if (a.id === DEFAULT_COLLECTION) { return -1; }
				if (b.id === DEFAULT_COLLECTION) { return 1; }
				const aLabel = a.name || a.id;
				const bLabel = b.name || b.id;
				if (aLabel < bLabel) { return -1; }
				if (aLabel > bLabel) { return 1; }
				return 0;
			});
			sorted.forEach(function (c) {
				const option = document.createElement('option');
				option.value = c.id;
				// collections.json (tactica ≥ 0.4.1) carries the display
				// name; older outputs show the raw minted id
				option.textContent = (c.name || c.id) + ' (' + c.count + ')';
				select.appendChild(option);
			});
		}
		const selected = data.collection || ALL_COLLECTIONS;
		if (select.value !== selected) {
			select.value = selected;
		}
		select.style.display = '';
	}

	// The `mnemographica.*` settings the host pushes: they ride every
	// updateGraph and land again on every settings change, so open and
	// freshly opened panels agree
	function applyUiSettings(settings) {
		if (typeof settings.alwaysShowCollectionSelector === 'boolean') {
			sessionUiSettings.alwaysShowCollectionSelector = settings.alwaysShowCollectionSelector;
			if (currentData) { updateCollectionSelect(currentData); }
		}
		if (typeof settings.invocationPathFilter === 'string') {
			applyInvocationFilterText(settings.invocationPathFilter);
		}
	}

	// Handle messages from extension
	window.addEventListener('message', function (event) {
		const message = event.data;

		if (message.command === 'settings') {
			applyUiSettings(message.data || {});
			return;
		}

		if (message.command === 'updateGraph') {
			if (xrSession) {
				deferredGraphUpdate = message;
				return;
			}
			currentData = message.data;
			if (message.settings) {
				applyUiSettings(message.settings);
			}
			updateCollectionSelect(message.data);
			// The host reads .mnemographica/layout.json and rides it along.
			// null means "no save yet" — keep a layout we already hold in
			// that case
			if (message.layout) {
				savedLayout = message.layout;
			}
			render3DGraph(message.data);
		}

		if (message.command === 'layoutSaved') {
			// Save-button confirmation from the host
			const savedPath = message.data && message.data.path;
			setStatusBase('Layout saved → ' + (savedPath || '.mnemographica/layout.json'));
		}

		if (message.command === 'exportSaved') {
			// Export-button confirmation from the host
			const savedPath = message.data && message.data.path;
			setStatusBase('Graph exported → ' + (savedPath || 'graph.html'));
		}

		if (message.command === 'focusNode') {
			// Sidebar click → rotate the 3D camera onto the node instead
			// of jumping to the file (extension gates on 3D being visible).
			// A focus landing before the first render (freshly opened
			// panel) is stashed and flushed at the end of render3DGraph.
			if (renderer3D && message.data) {
				renderer3D.focusNode(message.data.id, message.data.name);
			} else if (message.data) {
				pendingFocusNode = message.data;
			}
		}

		if (message.command === 'traceEvent') {
			// Live illumination: strategy pushed dive-trace deltas —
			// advance the status counter and light each edge's FULL
			// lineage acid-green: the whole trace glows as one body, not
			// one sphere at a time
			const edges = message.data && message.data.edges;
			if (Array.isArray(edges)) {
				liveTraceCount += edges.length;
				for (const edge of edges) {
					if (!edge || typeof edge !== 'object') continue;
					if (typeof edge.id === 'number') {
						liveEdgeIndex.set(edge.id, edge);
						while (liveEdgeIndex.size > LIVE_EDGE_INDEX_MAX) {
							// Maps iterate in insertion order — evict oldest
							const oldest = liveEdgeIndex.keys().next();
							liveEdgeIndex.delete(oldest.value);
						}
					}
					const ownName = edge.instanceType ||
						(typeof edge.name === 'string' ? edge.name : null);
					if (ownName) {
						liveTraceLast = ownName;
					}
					// Walk the parentId chain: every ancestor sphere joins
					// the flash. Ancestors not yet evicted from the index
					// resolve; the walk simply stops at the oldest known
					const lineageNames = [];
					const erroredNames = new Set();
					const walked = new Set();
					let cursor = edge;
					while (cursor && typeof cursor === 'object' && !walked.has(cursor.id)) {
						walked.add(cursor.id);
						const nm = cursor.instanceType ||
							(typeof cursor.name === 'string' ? cursor.name : null);
						if (nm) {
							liveTraceNames.add(nm);
							// 'ambient' attribution is the newest-wins
							// lastContext fallback — possibly a FOREIGN
							// flow's instance. It still feeds the chain
							// walk and the click-to-pick set, but its
							// bulb never lights on ambient alone:
							// attribution must be true or absent, never guessed.
							if (cursor.instanceSource !== 'ambient' && lineageNames.indexOf(nm) === -1) {
								lineageNames.push(nm);
							}
							if (cursor.status === 'error') {
								erroredNames.add(nm);
							}
						}
						cursor = liveEdgeIndex.get(cursor.parentId);
					}
					if (lineageNames.length > 0 && renderer3D) {
						renderer3D.flashTraceLineage(lineageNames, erroredNames);
					}
				}
				updateStatusLine();
			}
		}

		if (message.command === 'traceModeEnter') {
			// Trace mode (names-first tracing): isolate the resolved
			// lineage — green path, everything else dimmed
			const data = message.data || {};
			if (renderer3D && Array.isArray(data.edges)) {
				renderer3D.enterTraceMode(data.edges, data.name);
				updateStatusLine();
			}
		}

		if (message.command === 'traceModeExtend') {
			// Mid-flight continuation: the open trace is still running
			// and these fresh edges belong to it
			const data = message.data || {};
			if (renderer3D && renderer3D.traceMode && Array.isArray(data.edges)) {
				renderer3D.extendTraceMode(data.edges);
				updateStatusLine();
			}
		}

		if (message.command === 'traceReplay') {
			// Replay: isolate the trace, then re-walk its spheres at
			// human speed
			const data = message.data || {};
			if (renderer3D && Array.isArray(data.edges)) {
				renderer3D.enterTraceMode(data.edges, data.name);
				renderer3D.replayTrace(data.edges);
				updateStatusLine();
			}
		}

		if (message.command === 'queryViewState') {
			// Strategy state-query readback: report the live camera +
			// focus so view control can read the scene before rotating it
			const requestId = message.data && message.data.requestId;
			const state = {
				requestId   : requestId,
				focusedNode : null,
				camera      : null,
				nodeCount   : 0
			};
			if (renderer3D) {
				// Angle readback derived from the orbit quaternion — the
				// shape the view-state consumer already speaks
				const viewAngles = orbitAnglesFromQuat(renderer3D.orbitQuat);
				state.camera = {
					rotX : viewAngles.x,
					rotY : viewAngles.y,
					zoom : renderer3D.zoom,
					pan  : {
						x : renderer3D.panOffset.x,
						y : renderer3D.panOffset.y,
						z : renderer3D.panOffset.z || 0
					}
				};
				state.nodeCount = renderer3D.nodeMeshes.size;
				const focused = renderer3D.focusedMesh;
				if (focused && focused.userData.node) {
					state.focusedNode = {
						id   : focused.userData.node.id,
						name : focused.userData.node.name
					};
				}
			}
			vscode.postMessage({ command: 'viewState', data: state });
		}
	});

	// Escape drops the focus state at once: the selection highlight,
	// trace mode (names-first tracing) and the focused sphere; a lived
	// selection/trace/focus releases the orbit center back to the
	// graph center
	window.addEventListener('keydown', function (event) {
		if (event.key === 'Escape' && renderer3D) {
			const hadSelection = !!renderer3D.selectionMode;
			const hadTrace = !!renderer3D.traceMode;
			const hadFocus = !!renderer3D.focusedMesh;
			if (hadSelection) {
				renderer3D.clearSelectionHighlight();
			}
			if (hadTrace) {
				renderer3D.exitTraceMode();
				updateStatusLine();
				if (vscodeRef) {
					vscodeRef.postMessage({ command: 'traceModeExit' });
				}
			}
			if (hadFocus) {
				renderer3D.setFocusedMesh(null);
			}
			if (hadSelection || hadTrace || hadFocus) {
				renderer3D.restoreGraphCenter();
			}
		}
	});

	function render3DGraph(data, initialCameraState = null) {
		debugLog('[Mnemonica] Rendering 3D graph with', data.nodes.length, 'nodes and', data.links.length, 'links', 'log');
		debugLog('render3DGraph called with initialCameraState: ' + (initialCameraState ? 'YES' : 'NO'), 'log');
		if (initialCameraState) {
			debugLog('Camera state: ' + JSON.stringify(initialCameraState), 'log');
		}

		// Show generation controls
		const genControls = document.getElementById('gen-controls');
		if (genControls) {
			genControls.style.display = 'block';
		}

		if (!data || data.nodes.length === 0) {
			debugLog('[Mnemonica] No data to render', 'warn');
			document.getElementById('graph').innerHTML = '<div class="loading">No type data found</div>';
			return;
		}

		const container = document.getElementById('graph');
		if (!container) {
			debugLog('[Mnemonica] Graph container not found!', 'error');
			return;
		}

		// Hand the outgoing renderer's live pins across the rebuild BEFORE
		// the wipe — a refresh between drag and Save must not lose the
		// arrangement (Save must catch bagels/diamonds/cubes, not only
		// spheres)
		if (renderer3D) {
			Object.assign(sessionPins, renderer3D.snapshotPins());
			// The shell radii die with the old renderer too — snapshot
			// them so a Refresh keeps the wheel's distances
			if (renderer3D.depthRadii) {
				sessionGenRadii = new Map(renderer3D.depthRadii);
			}
		}

		container.innerHTML = '';

		// Saved layout application: user-placed
		// sphere positions apply BEFORE the render — calculatePosition
		// honors x3d/y3d/z3d and relaxTypeShells skips them; pins apply
		// after the builders (their meshes must exist); the camera rides
		// the constructor's initialCameraState (a live camera from a mode
		// switch still wins over the saved one)
		if (savedLayout && savedLayout.nodes) {
			data.nodes.forEach(function (node) {
				const saved = savedLayout.nodes[node.id];
				if (!saved) { return; }
				node.x3d = saved.x;
				node.y3d = saved.y;
				node.z3d = saved.z;
			});
		}

		// Create 3D renderer
		renderer3D = new Graph3DRenderer(container,
			initialCameraState || (savedLayout && savedLayout.camera) || null);
		// Debug handle: agent automation (Strategy/CDP) reads camera and
		// scene state through this
		window.__mnemographica3D = renderer3D;
		// Orient vectors from the vector-sphere control: session state is
		// newest, the saved layout fills
		// gaps. Set BEFORE renderGraph so the builders seat everything
		// oriented from birth — no post-render snap
		const savedOrient = savedLayout && savedLayout.orient ? savedLayout.orient : {};
		const captionSrc = sessionCaptionVector || savedOrient.captions || null;
		if (captionSrc) {
			renderer3D.captionVector.set(captionSrc.x, captionSrc.y, captionSrc.z);
			renderer3D.captionDist = captionSrc.dist !== undefined ? captionSrc.dist : 1;
		}
		const diamondSrc = sessionDiamondOrient || savedOrient.diamonds || null;
		if (diamondSrc) {
			const dir = new THREE.Vector3(diamondSrc.dir.x, diamondSrc.dir.y, diamondSrc.dir.z).normalize();
			const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
			renderer3D.diamondOrient = { quaternion, dir, scale: diamondSrc.scale };
		}
		const bagelSrc = sessionBagelOrient || savedOrient.bagels || null;
		if (bagelSrc) {
			renderer3D.bagelOrient = {
				dir  : new THREE.Vector3(bagelSrc.dir.x, bagelSrc.dir.y, bagelSrc.dir.z).normalize(),
				dist : bagelSrc.dist
			};
		}
		const sinkSrc = sessionSinkOrient || savedOrient.sinks || null;
		if (sinkSrc) {
			renderer3D.sinkOrient = {
				dir  : new THREE.Vector3(sinkSrc.dir.x, sinkSrc.dir.y, sinkSrc.dir.z).normalize(),
				dist : sinkSrc.dist
			};
		}
		// NO jaeger orient restore: the cone rides the sinks orient — a
		// savedOrient.jaeger from an older layout.json is intentionally
		// ignored
		// Generation shell radii seed, BEFORE renderGraph (the orient
		// seeding rule above: session is newest, the saved layout fills
		// gaps). renderGraph's depthRadii init overlays these on the
		// formula defaults — distances are arrangement too
		const genRadiiSeed = sessionGenRadii
			|| (savedLayout && Array.isArray(savedLayout.genRadii) ? new Map(savedLayout.genRadii) : null);
		if (genRadiiSeed) {
			renderer3D.seededGenRadii = genRadiiSeed;
		}
		renderer3D.setOnNodeClick(function (node) {
			debugLog('[Mnemonica] 3D Node clicked:', node.name, 'log');
			const loc = node.definitionLocation || node.location;
			if (loc) {
				vscode.postMessage({
					command: 'goToDefinition',
					data: loc
				});
			}
		});
		// The build is PROGRESSIVE: renderGraph
		// returns after the prelude and constructs the scene in
		// time-budgeted rAF ticks. Everything that needs the meshes to
		// EXIST rides the onDone continuation — pins, caption overrides,
		// the fresh-camera fit, a pending focus. builtRenderer pins the
		// renderer THIS call created: a second render3DGraph mid-build
		// replaces the outer renderer3D, and a continuation must never
		// land on the wrong renderer
		const builtRenderer = renderer3D;
		builtRenderer.renderGraph(data, () => {
			// Fit the whole scene into the viewport on a FRESH camera
			// (the initial render of a huge graph must show the full
			// graph inside the visible area) — a saved or
			// live camera state always wins; knob rebuilds re-use THAT
			// renderer and never refit
			if (!initialCameraState && !(savedLayout && savedLayout.camera)) {
				builtRenderer.fitCameraToView();
			}

			// Saved pins land after the builders — their meshes must exist.
			// Session pins (handed across rebuilds) apply LAST: they are newer
			// than the file
			if (savedLayout && savedLayout.pins) {
				builtRenderer.applySavedPins(savedLayout.pins);
			}
			builtRenderer.applySavedPins(sessionPins);
			// Per-caption Shift-drag overrides land after the builders too —
			// their meshes must exist. Session overrides win over the file,
			// same newer-than rule as pins
			const captionOverrideSrc = Object.assign(
				{},
				(savedLayout && savedLayout.orient && savedLayout.orient.captionOverrides) || {},
				sessionCaptionOverrides
			);
			builtRenderer.applyCaptionOverrides(captionOverrideSrc);

			// Flush a focus request that arrived before the renderer existed
			// (Show on Graph with the panel freshly opened) — the target
			// mesh exists once the build queue has drained
			if (pendingFocusNode) {
				const pending = pendingFocusNode;
				pendingFocusNode = null;
				builtRenderer.focusNode(pending.id, pending.name);
			}

			debugLog('[Mnemonica] 3D Graph rendered successfully', 'log');
		});

		// Handle resize
		resizeHandler3D = function () {
			if (!renderer3D) return;
			const newWidth = container.clientWidth || 800;
			const newHeight = container.clientHeight || 600;
			renderer3D.resize(newWidth, newHeight);
		};
		window.addEventListener('resize', resizeHandler3D);

		// Update status
		setStatusBase(data.nodes.length + ' types | ' +
			data.links.length + ' relationships (3D)');

		// The captions choice survives renderer rebuilds only in
		// sessionCaptionsVisible — apply it to the fresh renderer BEFORE
		// the panel builds, so its checkbox reads the live state
		renderer3D.setCaptionsVisible(sessionCaptionsVisible);

		// Create the collapsible Layers & Distances panel — per-layer
		// visibility checkboxes plus that layer's own distance knobs.
		// Builds against the fresh groups while the scene assembles
		createLayerControls(data, renderer3D);
	}

	/**
		* Create the layer toggles: the header row of each layer carries
		* just the visibility checkbox plus that layer's own ⌖ orient
		* control on the same line. The types row doubles as the expander
		* for the generation-distance rows (Roots/Gen N shell radii — shells
		* have no vector to orient, the wheel IS the control there) and the
		* Sinks ⌖ row. The sphere control covers both distance and
		* orientation for its consumers; their constants stay on
		* renderer.layerDistances as the DEFAULTS the orients start from.
		* Purely local to the webview (nothing posted to the extension host)
		*/
	// Expansion state lives outside: a knob adjust rebuilds the panel and
	// the open group must stay open across the rebuild
	const expandedLayerControls = new Set(['distance-orient']);

	// The generation shell cascade, shared by the Ø vector-control mode
	// ('gen'). Adjust cascades OUTWARD: growing a shell grows every shell
	// outside it, so shells never cross
	function cascadeShellRadii(renderer, data, depth, maxDepth, delta) {
		// Snapshot the shell radii before the cascade — user-placed
		// spheres scale by their shell's ratio below
		const oldRadii = new Map();
		for (let d = depth; d <= maxDepth; d++) {
			oldRadii.set(d, (renderer.depthRadii && renderer.depthRadii.get(d)) || 0);
		}
		for (let d = depth; d <= maxDepth; d++) {
			const current = (renderer.depthRadii && renderer.depthRadii.get(d)) || 0;
			renderer.depthRadii.set(d, Math.max(10, current + delta));
		}
		// User-placed spheres ride the knob too: a dragged sphere persists
		// as node.x3d/y3d/z3d — calculatePosition honors it and
		// relaxTypeShells never moves it — so scale the stored position
		// by the shell's radius ratio. Scaling a vector keeps its
		// direction: the sphere moves straight out/in along its own
		// radial line.
		data.nodes.forEach(node => {
			if (node.x3d === undefined) { return; }
			const nodeDepth = node.depth || 0;
			const oldR = oldRadii.get(nodeDepth);
			const newR = renderer.depthRadii.get(nodeDepth);
			if (!oldR || !newR || oldR < 1e-9) { return; }
			const ratio = newR / oldR;
			node.x3d *= ratio;
			node.y3d *= ratio;
			node.z3d *= ratio;
		});
		// The per-shell ratios for the LIVE reseat — the gen Ø mode
		// reseats the spheres in place instead of running a full rebuild
		const ratios = new Map();
		for (let d = depth; d <= maxDepth; d++) {
			const oldR = oldRadii.get(d);
			const newR = renderer.depthRadii.get(d);
			if (oldR && newR && oldR > 1e-9) {
				ratios.set(d, newR / oldR);
			}
		}
		return ratios;
	}

	// Live shell reseat: NO rebuild — every type sphere scales radially
	// by its shell's ratio (a pinned sphere's stored x3d was already
	// ratio-scaled by the cascade, so its live seat IS that spot),
	// node.x/y/z follow so the edge writers read fresh seats, and
	// updateLinkPositions() re-seats diamonds, bagels, sinks and edges
	// from the live positions (their writers read depthRadii directly —
	// the Roots Ø reaches the gen0-keyed seats too). The angular
	// arrangement is preserved — re-relaxing angles stays the full
	// rebuild's job (Refresh)
	function reseatTypeSpheresLive(renderer, ratios) {
		renderer.nodeMeshes.forEach(mesh => {
			const node = mesh.userData.node;
			if (!node) { return; }
			const ratio = ratios.get(node.depth || 0);
			if (!ratio || Math.abs(ratio - 1) < 1e-12) { return; }
			if (node.x3d !== undefined) {
				mesh.position.set(node.x3d, node.y3d, node.z3d);
			} else {
				mesh.position.multiplyScalar(ratio);
			}
			node.x = mesh.position.x;
			node.y = mesh.position.y;
			node.z = mesh.position.z;
			node.fx = node.x;
			node.fy = node.y;
			node.fz = node.z;
		});
	}

	// Sibling spread at one depth (Ctrl+wheel on a gen Ø window): every
	// sphere at that depth turns away from its sibling group's axis —
	// its parent's direction, or the roots' common center for depth 0 —
	// multiplying its angle from that axis by `factor`, radius kept. Its
	// subtree TRANSLATES by the same displacement (the Ctrl+drag rule:
	// carried along, not spread). Every moved sphere is written
	// user-placed, so Save and relayouts keep the spread. Widening stops
	// at 90° from the axis: past it a larger angle walks toward the far
	// pole and siblings would CONVERGE there. A roots group spread over
	// its whole shell (common center under a tenth of the radius) has no
	// side to spread from and stays put
	function spreadLevel(renderer, depth, factor) {
		const groups = new Map();
		renderer.nodeMeshes.forEach(mesh => {
			const node = mesh.userData.node;
			if (!node || (node.depth || 0) !== depth) { return; }
			const key = node.parent || null;
			if (!groups.has(key)) { groups.set(key, []); }
			groups.get(key).push(mesh);
		});
		const MAX_ANGLE = Math.PI / 2;
		groups.forEach((members, parentNode) => {
			let axis;
			if (parentNode) {
				const parentMesh = renderer.nodeMeshes.get(parentNode.id);
				axis = parentMesh ? parentMesh.position.clone() : new THREE.Vector3();
			} else {
				axis = new THREE.Vector3();
				let radiusSum = 0;
				members.forEach(m => {
					axis.add(m.position);
					radiusSum += m.position.length();
				});
				if (axis.length() < 0.1 * radiusSum / members.length) { return; }
			}
			if (axis.lengthSq() < 1e-9) { return; }
			axis.normalize();
			members.forEach(mesh => {
				const radius = mesh.position.length();
				if (radius < 1e-9) { return; }
				const dir = mesh.position.clone().divideScalar(radius);
				const angle = Math.acos(Math.min(1, Math.max(-1, dir.dot(axis))));
				// On the axis there is no direction to turn toward
				const side = dir.clone().addScaledVector(axis, -Math.cos(angle));
				if (side.lengthSq() < 1e-12) { return; }
				side.normalize();
				// Narrowing always applies; widening caps at MAX_ANGLE and
				// never pulls a sphere already past it back
				const next = factor < 1
					? angle * factor
					: Math.max(angle, Math.min(angle * factor, MAX_ANGLE));
				if (next === angle) { return; }
				const nextPos = axis.clone().multiplyScalar(Math.cos(next) * radius)
					.addScaledVector(side, Math.sin(next) * radius);
				const displacement = new THREE.Vector3().subVectors(nextPos, mesh.position);
				const subtree = renderer.collectSubtreeMeshes(mesh);
				mesh.position.copy(nextPos);
				renderer.placeNodeData(mesh.userData.node, mesh.position);
				subtree.forEach(({ mesh: descendant }) => {
					descendant.position.add(displacement);
					renderer.placeNodeData(descendant.userData.node, descendant.position);
				});
			});
		});
	}

	// The gen rows' px readouts ride the radii — update in place now
	// that control gestures no longer rebuild the panel. Row order IS
	// the depth order (createLayerControls pushes Roots, Gen 1, …)
	function refreshGenReadouts(renderer) {
		const values = document.querySelectorAll('#layer-controls-list .gen-control-value');
		values.forEach((el, depth) => {
			const radius = (renderer.depthRadii && renderer.depthRadii.get(depth)) || 0;
			el.textContent = Math.round(radius) + 'px';
		});
	}

	// The invocations filter — a JS RegExp from the
	// `mnemographica.invocationPathFilter` setting, tested against each
	// creation scope's filePath; empty text means OFF, an invalid
	// expression keeps the last good one. The apply reaches the LIVE
	// renderer through the module-level renderer3D — a renderer captured
	// at build time dies with the next refresh
	function applyInvocationFilterText(text) {
		const trimmed = text.trim();
		let next = null;
		if (trimmed.length > 0) {
			try {
				next = new RegExp(trimmed);
			} catch (err) {
				// Keep the last good expression — a pattern that does
				// not parse must never blank the scene
				return false;
			}
		}
		sessionInvocationFilter = next;
		// The export bundles the filter text (sessionUiSettings snapshot)
		// so the exported page mirrors this view
		sessionUiSettings.invocationPathFilter = trimmed;
		if (renderer3D) {
			// Instant flip, no rebuild (the gen-checkbox idiom): the
			// creation scopes' computed .visible getters read the new
			// expression; one dynamics pass lets the batched call edges
			// fold to degenerate vertices, then a single paint
			renderer3D.updateLinkPositions();
			renderer3D.needsRender = true;
		}
		return true;
	}

	function createLayerControls(data, renderer) {
		const container = document.getElementById('layer-controls-list');
		if (!container || !renderer) return;
		container.innerHTML = '';

		const maxDepth = Math.max(...data.nodes.map(n => n.depth || 0));
		const rebuild = function () {
			renderer.renderGraph(data);
			createLayerControls(data, renderer);
		};

		// The generation shell radii rows — label + live value + a Ø
		// button opening the vector-sphere control in 'gen' mode
		const generationParams = [];
		for (let depth = 0; depth <= maxDepth; depth++) {
			generationParams.push({
				depth   : depth,
				label   : depth === 0 ? 'Roots' : 'Gen ' + depth,
				display : function () {
					const radius = (renderer.depthRadii && renderer.depthRadii.get(depth)) || 0;
					const text = Math.round(radius) + 'px';
					return text;
				}
			});
		}

		// Each layer row CARRIES its own ⌖ orient control on the same
		// line — the Diamonds ⌖ rides invocations ◆ (the creation
		// scopes ARE the invocation map), the Bagels ⌖ rides dive ◯
		// (the EDS rings), the captions ⌖ rides captions; the types
		// row doubles as the expander for the generation distance
		// rows. Sinks keeps its own row inside the expanded group — it
		// has no layer of its own and Jaeger's cone rides its orient
		const groupExpanded = expandedLayerControls.has('distance-orient');

		const layers = [
			// The layer reads "invocations ◆" — the creation graph IS
			// the invocation map; code ids keep the instrumentation name
			// (instrumentation.json & friends)
			{
				key      : 'instrumentation',
				label    : 'invocations ◆',
				getGroup : () => renderer.instrumentationGroup,
				orient   : { mode: 'diamonds', text: 'Diamonds', title: 'Orient diamonds around their spheres' }
			},
			// Wrappers + dive internals + adapter sinks merged into the
			// single Dive graph
			{
				key      : 'dive',
				label    : 'dive ◯',
				getGroup : () => renderer.diveGroup,
				orient   : { mode: 'bagels', text: 'Bagels', title: 'Orient bagels around their anchors' }
			},
			// The captions "layer": every sign sprite + leader line across
			// all groups. The visibility choice rides
			// sessionCaptionsVisible across renderer rebuilds (the panel
			// itself is rebuilt too, so the DOM cannot hold the state
			// here). Its ⌖ needs no second label — the row's own word
			// says what is being oriented
			{
				key      : 'captions',
				label    : 'captions',
				getState : () => renderer.captionsVisible,
				setState : (on) => {
					sessionCaptionsVisible = on;
					renderer.setCaptionsVisible(on);
				},
				orient   : { mode: 'captions', text: null, title: 'Orient captions (vector-sphere control)' }
			},
			// types comes LAST: its row doubles as the expander for the
			// generation distance rows
			{
				key      : 'types',
				label    : 'types',
				getGroup : () => renderer.typesGroup,
				setState : (on) => {
					renderer.typesGroup.visible = on;
					// The generation checkboxes dim and disable with the
					// master layer — toggling a generation of a hidden
					// layer is meaningless. Rebuilding the panel renders
					// their disabled state; the choices themselves survive
					// in sessionGenVisibility
					createLayerControls(data, renderer);
				}
			}
		];
		// Anonymised export: no captions exist, so the row that governs
		// them is noise — the panel shows layers that are actually there
		const visibleLayers = ANONYMIZE
			? layers.filter(layer => layer.key !== 'captions')
			: layers;
		visibleLayers.forEach(layer => {
			const header = document.createElement('div');
			header.className = 'gen-control-row layer-header';

			const label = document.createElement('label');
			label.className = 'gen-control-label';
			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			// Read the LIVE visibility — a rebuild must not lie about a
			// layer the user already hid
			const group = layer.getGroup ? layer.getGroup() : null;
			checkbox.checked = layer.getState ? layer.getState() : (group ? group.visible : true);
			checkbox.onchange = function () {
				if (layer.setState) {
					layer.setState(checkbox.checked);
				} else {
					const liveGroup = layer.getGroup();
					if (liveGroup) {
						liveGroup.visible = checkbox.checked;
					}
				}
				renderer.updateCenterMarkerVisibility();
				renderer.needsRender = true;
				// Never keep focus after a click — a focused checkbox
				// re-toggles on Space and shows a stale focus ring
				checkbox.blur();
			};
			label.appendChild(checkbox);
			label.appendChild(document.createTextNode(' ' + layer.label));
			header.appendChild(label);

			if (layer.orient) {
				// The merged ⌖ — the kind's own word (Diamonds/Bagels)
				// sits left of the button. The name span must NOT wear
				// .gen-control-value: refreshGenReadouts maps that class
				// to generation depths BY INDEX
				if (layer.orient.text) {
					const orientName = document.createElement('span');
					orientName.className = 'layer-orient-name';
					orientName.textContent = layer.orient.text;
					header.appendChild(orientName);
				}
				const orientBtn = document.createElement('button');
				orientBtn.className = 'gen-control-btn layer-orient-btn';
				orientBtn.textContent = '⌖';
				orientBtn.title = layer.orient.title;
				orientBtn.onclick = function () {
					openVectorControl(layer.orient.mode, renderer);
					orientBtn.blur();
				};
				header.appendChild(orientBtn);
			}

			if (layer.key === 'types') {
				// The types row doubles as the expander for the
				// generation distance rows — the expandedLayerControls
				// Set key stays 'distance-orient'
				const groupToggle = document.createElement('button');
				groupToggle.className = 'gen-control-btn layer-toggle';
				groupToggle.textContent = groupExpanded ? '−' : '+';
				groupToggle.title = 'Show/hide the generation distance rows';
				groupToggle.onclick = function () {
					if (expandedLayerControls.has('distance-orient')) {
						expandedLayerControls.delete('distance-orient');
					} else {
						expandedLayerControls.add('distance-orient');
					}
					createLayerControls(data, renderer);
				};
				header.appendChild(groupToggle);
			}
			container.appendChild(header);
		});

		if (groupExpanded) {
			generationParams.forEach(param => {
				const row = document.createElement('div');
				row.className = 'gen-control-row layer-distance-row';

				// Visibility checkbox FIRST — hiding a generation hides
				// its spheres, their edges, holding diamonds and wraps
				// through COMPUTED .visible getters (no loop, no
				// rebuild; see genDepthVisible). The choice rides
				// sessionGenVisibility because this panel rebuilds with
				// every render
				const name = document.createElement('label');
				name.className = 'gen-control-label';
				const genCheckbox = document.createElement('input');
				genCheckbox.type = 'checkbox';
				genCheckbox.checked = sessionGenVisibility.get(param.depth) !== false;
				// With the types layer off every generation is hidden
				// anyway (genDepthVisible composes it) — the checkbox has
				// nothing to govern, so it dims and disables until the
				// layer returns. The checked state itself is kept
				const typesOn = !renderer.typesGroup || renderer.typesGroup.visible !== false;
				genCheckbox.disabled = !typesOn;
				genCheckbox.title = typesOn
					? 'Show/hide ' + param.label + ', their deps and their wraps'
					: 'The types layer is off — re-enable it to toggle generations';
				name.classList.toggle('gen-dimmed', !typesOn);
				genCheckbox.onchange = function () {
					sessionGenVisibility.set(param.depth, genCheckbox.checked);
					// Instant flip, NO rebuild — every governed object
					// answers the new flag through its computed-visibility
					// getter on the next frame. One dynamics pass lets the
					// WRITER-decided kinds (batched segments,
					// connector/call/fiber arrowheads) re-evaluate their
					// share; then a single paint
					renderer.updateLinkPositions();
					renderer.needsRender = true;
					// Same focus rule as the layer checkboxes: a focused
					// checkbox re-toggles on Space
					genCheckbox.blur();
				};
				name.appendChild(genCheckbox);
				name.appendChild(document.createTextNode(' ' + param.label));
				row.appendChild(name);

				const valueDisplay = document.createElement('span');
				valueDisplay.className = 'gen-control-value';
				valueDisplay.textContent = param.display();
				row.appendChild(valueDisplay);

				// ⌖ opens the vector-sphere control in 'gen' mode; the
				// wheel IS the radius
				const orientBtn = document.createElement('button');
				orientBtn.className = 'gen-control-btn layer-orient-btn';
				orientBtn.textContent = '⌖';
				orientBtn.title = 'Adjust the ' + param.label + ' shell radius (vector-sphere control)';
				orientBtn.onclick = function () {
					openVectorControl('gen', renderer, {
						depth    : param.depth,
						label    : param.label,
						maxDepth : maxDepth,
						data     : data,
						rebuild  : rebuild
					});
					orientBtn.blur();
				};
				row.appendChild(orientBtn);
				container.appendChild(row);
			});
			// Sinks keeps its own row inside the expanded group — it has
			// no layer row to ride, and the Jaeger cone follows its
			// orient
			const sinkRow = document.createElement('div');
			sinkRow.className = 'gen-control-row layer-distance-row';
			const sinkName = document.createElement('span');
			sinkName.className = 'gen-control-label';
			sinkName.textContent = 'Sinks';
			sinkRow.appendChild(sinkName);
			const sinkOrientBtn = document.createElement('button');
			sinkOrientBtn.className = 'gen-control-btn layer-orient-btn';
			sinkOrientBtn.textContent = '⌖';
			sinkOrientBtn.title = 'Orient the adapter-sink stack off the origin (Jaeger rides along)';
			sinkOrientBtn.onclick = function () {
				openVectorControl('sinks', renderer);
				sinkOrientBtn.blur();
			};
			sinkRow.appendChild(sinkOrientBtn);
			container.appendChild(sinkRow);
		}
	}

		// 3D Renderer Class with human-readable layout
	class Graph3DRenderer {
		constructor(container, initialCameraState = null) {
			this.container = container;
			this.nodeMeshes = new Map();
			this.linkLines = [];
			// EDS path-hit overlay (createsTypes): guaranteed runtime paths
			// from a wrapped scope to the types it constructs. Never-taken
			// hits (source type never instantiated) ride a dimmer material
			this.pathHitLines = [];
			// Layer groups for the toggles — visibility is read by
			// the raycast filter too, so hidden layers are not clickable.
			// instrumentationGroup hosts the creation layer (see
			// buildCreationLayer); it is empty for v1 payloads
			this.typesGroup = null;
			this.instrumentationGroup = null;
			// Creation layer bookkeeping: meshes/lines get disposed in
			// clear(); dynamics re-run from updateLinkPositions so holder
			// tangents follow type spheres when they are dragged
			this.creationMeshes = [];
			this.creationLines = [];
			this.creationGeometries = [];
			this.creationMaterials = [];
			this.creationDynamics = [];
			this.creationMeshById = new Map();
			// The combined Dive graph: wrappers (bagels + directed fiber
			// edges), the internals backplane (EDS ring, attachHooks hub
			// + grafts, adapter sinks) — everything lands in the single
			// diveGroup. Same lifecycle as the creation layer (disposed
			// in clear(), dynamics re-run after creation's)
			this.diveGroup = null;
			this.wrapperMeshes = [];
			this.wrapperLines = [];
			this.wrapperGeometries = [];
			this.wrapperMaterials = [];
			this.wrapperDynamics = [];
			this.wrapperMeshById = new Map();
			this.internalsMeshes = [];
			this.internalsLines = [];
			this.internalsGeometries = [];
			this.internalsMaterials = [];
			this.internalsDynamics = [];
			this.internalsMeshById = new Map();
			// Label leaders: one thin line per sign back to its mesh —
			// the sign must never float free of what it signs
			this.leaderLines = [];
			this.leaderMaterial = null;
			// Global captions on/off — the way to show shapes without
			// revealing names. addLabel applies this at birth, so
			// knob-driven rebuilds never re-show hidden captions
			this.captionsVisible = true;
			// Everything the pointer may grab or click: spheres, creation
			// diamonds, bagels, internals knots (never arrows/lines/labels).
			// Non-sphere drags pin via userData.pinned — RELATIVE pins:
			// anchored elements store pinAnchor + pinOffset and follow
			// their anchor's moves, anchor-less ones stay put; edges keep
			// following either way
			this.interactive = [];
			// The maroon origin marker — tracked so re-renders dispose it.
			// It belongs to the types layer (updateCenterMarkerVisibility)
			this.centerMarker = null;
			// WebXR session state (enterXR/exitXR); null on the desktop
			this.xr = null;
			this.onNodeClick = null;
			this.mouse = { x: 0, y: 0 };
			this.isDragging = false;
			this.previousMousePosition = { x: 0, y: 0 };
			// Restore saved camera state or use defaults
			if (initialCameraState) {
				debugLog('Restoring camera state: ' + JSON.stringify(initialCameraState), 'log');
				if (initialCameraState.orbitQuat) {
					const q = initialCameraState.orbitQuat;
					this.orbitQuat = new THREE.Quaternion(q.x, q.y, q.z, q.w);
				} else {
					// Legacy layout camera (pre-quaternion): the spherical
					// angles convert; roll was never persisted, so none
					// is lost
					const legacy = initialCameraState.cameraRotation || { x: 0, y: 0 };
					this.orbitQuat = quatFromOrbitAngles(legacy.x || 0, legacy.y || 0);
				}
				this.zoom = initialCameraState.zoom;
				this.panOffset = { ...initialCameraState.panOffset };
				debugLog('Restored zoom: ' + this.zoom, 'log');
				debugLog('Restored panOffset: ' + JSON.stringify(this.panOffset), 'log');
			} else {
				debugLog('No saved camera state, using defaults', 'log');
				this.orbitQuat = new THREE.Quaternion();
				this.zoom = 500;
				this.panOffset = { x: 0, y: 0, z: 0 };
			}
			// Aim/pivot decoupling (restoreGraphCenter): when the orbit
			// center snaps home on a focus drop, the live orientation is
			// anchored here and gestures apply only the DELTA of the
			// coupled model — the maroon marker keeps its screen spot
			// instead of jumping to center on the first rotate.
			// { fromInv, quaternion } or null (aim rides the pivot)
			this.aimAnchor = null;
			this.depthRadii = null; // Will be initialized in renderGraph
			// Session/saved shell radii render3DGraph hands in before
			// renderGraph — they overlay the formula defaults at init
			this.seededGenRadii = null;
			// Per-layer distance defaults for the collapsible Layers &
			// Distances panel. Values feed the layer builders; they live
			// on the renderer and survive relayouts. Multipliers are in
			// nodeRadius (holderShell, onionStep) or gen-0 radius
			// (ambient/sink/jaeger)
			this.layerDistances = {
				creation : {
					// Holder diamonds: dir × nodeRadius × holderShell
					// from the created sphere's center
					holderShell : 2.4
				},
				dive : {
					// Ambient bagels: gen0 × ambientBase +
					// generation × nodeRadius × ambientStep
					ambientBase : 1.4,
					ambientStep : 0.5,
					// Co-located bagels onion out by 1 + k × onionStep
					onionStep   : 0.22,
					// Adapter sinks at −gen0 × sinkOffset, Jaeger
					// leftmost at −gen0 × jaegerOffset
					sinkOffset  : 1.3,
					jaegerOffset : 1.65
				}
			};
			// Caption placement vector in VIEW space: signs sit at camera
			// × vector × signed distance from their mesh — screen-up by
			// default, so captions hold their spot on rotation.
			// Per-caption Shift+drag overrides live in
			// userData.captionViewOffset
			this.captionVector = new THREE.Vector3(0, 1, 0);
			// …and the wheel's distance multiplier for that vector (the
			// sphere radius IS the distance, captions included)
			this.captionDist = 1;
			// Every mesh carrying a sign — the camera watcher re-anchors
			// them on rotation without a full dynamics pass
			this.labeledMeshes = [];
			this.lastCameraQuaternion = new THREE.Quaternion();
			// Bound-element orientations from the vector-sphere control:
			// null = canonical placement. diamondOrient =
			// { quaternion (+X → picked), dir, scale } — shellPoint reads
			// it LIVE; bagelOrient = { dir, dist } — the wrapper writer
			// pushes bagels out from their anchor along it; sinkOrient =
			// { dir, dist in gen-0 radii } — the internals builder and its
			// re-seat dynamics read it LIVE. Jaeger keeps NO orient of its
			// own — jaegerSeat derives from sinkOrient
			this.diamondOrient = null;
			this.bagelOrient = null;
			this.sinkOrient = null;
			this.draggedCaption = null;
			// Focus animation state (sidebar click → rotate/zoom to node)
			this.focusAnim = null;
			this.focusedMesh = null;
			// Live trace flashes: mesh → { expiry, color } — acid-green
			// (TRACE_COLOR) for the whole lineage of each incoming
			// dive-trace edge, red (TRACE_ERROR_COLOR) where a member
			// errored. 5s decay + scale kick — short tints and small hue
			// shifts sit below human notice; a shape change registers
			this.traceFlashes = new Map();
			// Replay: isolate the trace, then re-walk its spheres at
			// human speed — one flash per edge, ~650ms apart, green for ok
			// and red for errored steps. Unlike ambient flashes these stay
			// VISIBLE in trace mode: the replay runs against the isolated
			// lineage. { mesh → { expiry, color } }
			this.replayFlashes = new Map();
			this.replayTimer = null;
			// Trace mode (names-first tracing): while set, the isolated
			// lineage stays green, everything else dimmed, ambient
			// flashes suppressed. { names, meshes, links, dimmed } —
			// dimmed holds the shared materials to restore
			this.traceMode = null;
			// Selection highlight (tree click): the focused item's whole
			// inheritance cone glows — ancestors + self + descendants —
			// everything else dims to SELECTION_DIM. { id, cone, chain,
			// tube, tubeSig, dimmed } — dimmed holds the shared materials
			// to restore, chain orders the ancestor meshes root → self
			// for the glow tube
			this.selectionMode = null;
			// The focused sphere's gold pulse marks the clicked spot for
			// 7 seconds, then settles on the base glow — long enough to
			// find it, short enough to stop blinking (and to let the
			// render-on-demand loop go idle again). The FOCUS itself
			// stays — only the blink retires
			this.focusPulseStart = 0;
			this.focusPulseSettled = true;
			// The press point of the current gesture — the click handler
			// compares the release against it: past the 4px click/drag
			// idiom the gesture was a drag, and the browser click that
			// still fires must not read as a background click
			this.pressPosition = null;

			// Render-on-demand: animate() keeps its rAF loop but paints
			// only when this flag is set (scene mutation), a continuous
			// animation is live (focus anim/pulse, trace and replay
			// flashes), or the ~1Hz heartbeat fires as self-heal for a
			// missed invalidation. Idle panel: one frame per second
			// instead of 60 — an open static graph no longer spins the fan
			this.needsRender = true;
			this.lastRenderAt = 0;

			this.init();
		}

		init() {
			debugLog('[3D] init() called', 'log');
			debugLog('[3D] THREE available:', typeof THREE, 'log');
			debugLog('[3D] Container:', this.container, 'log');
			debugLog('[3D] Container size:', this.container.clientWidth, 'x', this.container.clientHeight, 'log');

			// Check WebGL support
			const testCanvas = document.createElement('canvas');
			const gl = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
			debugLog('[3D] WebGL available:', !!gl, 'log');

			// The scene wears the theme's editor background — the one
			// dark the rest of the window already uses
			this.scene = new THREE.Scene();
			const editorBg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
			this.scene.background = new THREE.Color(editorBg || '#1e1e1e');
			// Everything the graph draws hangs off graphRoot, never off the
			// scene: the desktop leaves it at identity, WebXR scales and
			// moves it into a tabletop model (enterXR) while the lights
			// and the controllers stay in room space
			this.graphRoot = new THREE.Group();
			this.scene.add(this.graphRoot);

			// Create camera with better initial position
			const width = this.container.clientWidth || 800;
			const height = this.container.clientHeight || 600;
			debugLog('[3D] Using size:', width, 'x', height, 'log');
			this.camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 5000);
			// Use existing zoom/panOffset if they were restored, otherwise set defaults
			if (this.zoom === undefined) this.zoom = 600;
			if (this.panOffset === undefined) this.panOffset = { x: 0, y: 0, z: 0 };
			this.isPanning = false;
			this.draggedNode = null;
			// Ctrl+drag on a sphere: [{ mesh, offset }] for every
			// descendant sphere, offset from the dragged one; null otherwise
			this.draggedSubtree = null;
			// Shift+drag roll gesture flag — a Shift+drag that grabbed NO
			// caption rolls the view instead of panning/node-dragging.
			// The roll itself rides the orbit quaternion
			this.rollingView = false;
			// Apply the camera position based on restored/default values
			this.updateCameraPosition();

			// Create renderer
			try {
				this.renderer = new THREE.WebGLRenderer({ antialias: true });
				debugLog('[3D] WebGLRenderer created', 'log');
			} catch (e) {
				debugLog('[3D] WebGLRenderer failed:', e, 'error');
				this.container.innerHTML = '<div class="loading">WebGL not supported</div>';
				return;
			}
			this.renderer.setSize(width, height);
			this.renderer.setPixelRatio(window.devicePixelRatio);
			this.container.appendChild(this.renderer.domElement);

			// Add much brighter lights for better visibility
			const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
			this.scene.add(ambientLight);

			const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
			directionalLight.position.set(200, 200, 200);
			this.scene.add(directionalLight);

			// Add additional point lights for better illumination
			const pointLight1 = new THREE.PointLight(0xffaa00, 0.8, 2000);
			pointLight1.position.set(-200, 200, 200);
			this.scene.add(pointLight1);

			const pointLight2 = new THREE.PointLight(0x00aaff, 0.6, 2000);
			pointLight2.position.set(200, -200, 200);
			this.scene.add(pointLight2);

			// Add fog for depth (matching new background)
			this.scene.fog = new THREE.Fog(0x2d2d2d, 500, 2500);

			// Setup interaction
			this.setupInteraction();

			// Start render loop — setAnimationLoop, not window rAF: during
			// an immersive session only the XRSession's frame loop ticks,
			// and three switches the loop over by itself
			this.renderer.setAnimationLoop(() => this.animate());
		}

		setupInteraction() {
			const canvas = this.renderer.domElement;

			// Capture mouse events - prevent VS Code from handling them
			canvas.style.cursor = 'grab';

			// Raycaster for click detection
			this.raycaster = new THREE.Raycaster();
			this.mouseVector = new THREE.Vector2();
			this.plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

			canvas.addEventListener('mousedown', (e) => {
				// Panel drag in progress (legend or Layers & Distances): the scene must not react (the
				// early return also keeps propagation alive for the
				// legend's own handlers)
				if (legendDragState || genControlsDragState) return;
				e.preventDefault();
				e.stopPropagation();
				// User grabbed the scene — cancel any running focus
				// animation. A panOnly recenter glide is spared: it
				// writes only panOffset, the drag writes the orbit
				// quaternion — they compose and the pivot still lands home
				if (this.focusAnim && !this.focusAnim.panOnly) {
					this.focusAnim = null;
				}
				this.isDragging = false;
				this.isPanning = e.ctrlKey;
				this.previousMousePosition = { x: e.clientX, y: e.clientY };
				this.pressPosition = { x: e.clientX, y: e.clientY };

				// Check if clicking on a node for dragging
				const rect = canvas.getBoundingClientRect();
				this.mouseVector.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
				this.mouseVector.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
				this.raycaster.setFromCamera(this.mouseVector, this.camera);
				// Shift+drag moves a single caption. The override is
				// stored VIEW-relative at drag end, so it holds its
				// screen spot on rotation like the global vector. No
				// caption under the cursor → fall through to the normal
				// scene grab
				this.draggedCaption = null;
				if (e.shiftKey) {
					const sprites = [];
					this.labeledMeshes.forEach(m => {
						if (m.userData.label && m.userData.label.visible) {
							sprites.push(m.userData.label);
						}
					});
					const captionHits = this.raycaster.intersectObjects(sprites, false);
					// Texel-exact pick: the sprite raycast tests the whole
					// QUAD — transparent margins included — so the nearest
					// hit is often a NEIGHBOUR whose invisible edge covers
					// the cursor. The label canvas still lives on the
					// texture: sample its alpha at the hit UV and keep the
					// first hit whose painted texel is really there
					// (alphaTest is 0.5 → 127) — that IS the caption the
					// user sees under the cursor
					let sprite = null;
					for (const hit of captionHits) {
						const labelCanvas = hit.object.material.map && hit.object.material.map.image;
						if (!labelCanvas || !hit.uv) { continue; }
						const px = Math.max(0, Math.min(labelCanvas.width - 1,
							Math.floor(hit.uv.x * labelCanvas.width)));
						const py = Math.max(0, Math.min(labelCanvas.height - 1,
							Math.floor((1 - hit.uv.y) * labelCanvas.height)));
						const alpha = labelCanvas.getContext('2d').getImageData(px, py, 1, 1).data[3];
						if (alpha > 127) {
							sprite = hit.object;
							break;
						}
					}
					// No painted texel under the cursor at all: the press
					// aimed at the caption BOX, not the exact glyph pixels
					// — the glyph band fills only a strip of the quad, so
					// exact-texel presses keep missing. Overlaps still
					// resolve texel-exact above; this fires only when
					// every hit is transparent at the cursor
					if (!sprite && captionHits.length > 0) {
						sprite = captionHits[0].object;
					}
					if (sprite) {
						const ownerMesh = this.labeledMeshes.find(m => m.userData.label === sprite) || null;
						if (ownerMesh) {
							this.draggedCaption = { mesh: ownerMesh, sprite };
							const cameraDirection = new THREE.Vector3();
							this.camera.getWorldDirection(cameraDirection);
							const camToSprite = new THREE.Vector3().subVectors(sprite.position, this.camera.position);
							this.dragPlaneDistance = camToSprite.dot(cameraDirection);
							canvas.style.cursor = 'move';
							return;
						}
					}
					// No caption under the cursor: Shift+drag ROLLS the
					// view — never a node drag, never a pan; mousemove
					// turns the drag delta into a roll around the view
					// axis
					this.rollingView = true;
					canvas.style.cursor = 'grabbing';
					return;
				}
				const intersects = this.raycaster.intersectObjects(this.interactive);

				const dragHit = firstVisibleIntersect(intersects);
				if (dragHit) {
					this.draggedNode = dragHit.object;
					this.draggedNode.userData.isDragging = true;
					if (!this.draggedNode.userData.node) {
						// Non-sphere element (diamond, bagel, knot): pin it.
						// The pin is RELATIVE: elements anchored to a sphere
						// or diamond store their offset from the anchor, and
						// the dynamics writers re-apply anchor + offset —
						// dragging the sphere later carries the whole set
						// along, as if the element was never detached.
						// Anchor-less elements (ambient bagels, internals
						// knots) keep the absolute pin: nothing to follow
						this.draggedNode.userData.pinned = true;
						const pinAnchor = this.resolvePinAnchor(this.draggedNode);
						if (pinAnchor) {
							this.draggedNode.userData.pinAnchor = pinAnchor;
							this.draggedNode.userData.pinOffset = new THREE.Vector3().subVectors(
								this.draggedNode.position,
								pinAnchor.position
							);
						}
					} else if (e.ctrlKey) {
						// Ctrl+drag on a sphere carries its whole subtree
						// (every descendant, all depths). Their diamonds and
						// bagels follow through their relative pins
						this.draggedSubtree = this.collectSubtreeMeshes(this.draggedNode);
					}
					// Store the intersection point offset from node center
					const intersectPoint = dragHit.point;
					this.dragOffset = new THREE.Vector3().subVectors(
						this.draggedNode.position,
						intersectPoint
					);
					// Store the fixed distance from camera to node for the drag plane
					const nodePos = this.draggedNode.position;
					const cameraDirection = new THREE.Vector3();
					this.camera.getWorldDirection(cameraDirection);
					const camToNode = new THREE.Vector3().subVectors(nodePos, this.camera.position);
					this.dragPlaneDistance = camToNode.dot(cameraDirection);
					canvas.style.cursor = 'move';
				} else {
					canvas.style.cursor = 'grabbing';
				}
			}, { passive: false });

			canvas.addEventListener('mousemove', (e) => {
				// Panel drag in progress (legend or Layers & Distances): any button-held move reads as a
				// grab-the-world pan here — bail BEFORE stopPropagation so
				// the event still reaches the legend's handlers
				if (legendDragState || genControlsDragState) return;
				e.preventDefault();
				e.stopPropagation();

				const dx = e.clientX - this.previousMousePosition.x;
				const dy = e.clientY - this.previousMousePosition.y;

				if (e.buttons === 1 && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
					this.isDragging = true;

					if (this.rollingView) {
						// Roll: spin the view around its own axis. Linear
						// map — BOTH drag components count (horizontal and
						// vertical), so the gesture works anywhere on the
						// canvas; a pure sweep around the viewport center
						// would leave straight radial drags dead. The
						// local-frame postmultiply rolls around the
						// CURRENT view axis
						this.orbitQuat.multiply(
							new THREE.Quaternion().setFromAxisAngle(ORBIT_ROLL_AXIS, (dx + dy) * 0.005));
						this.updateCameraPosition();
					} else if (this.draggedCaption) {
						// Move the caption on its fixed-depth plane (the
						// node-drag plane trick); the override lands in
						// userData only at drag END
						const rect = canvas.getBoundingClientRect();
						this.mouseVector.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
						this.mouseVector.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
						this.raycaster.setFromCamera(this.mouseVector, this.camera);
						const cameraDirection = new THREE.Vector3();
						this.camera.getWorldDirection(cameraDirection);
						const planePoint = this.camera.position.clone().add(
							cameraDirection.clone().multiplyScalar(this.dragPlaneDistance)
						);
						const dragPlane = new THREE.Plane();
						dragPlane.setFromNormalAndCoplanarPoint(cameraDirection, planePoint);
						const target = new THREE.Vector3();
						this.raycaster.ray.intersectPlane(dragPlane, target);
						if (target) {
							this.draggedCaption.sprite.position.copy(target);
							const leader = this.draggedCaption.mesh.userData.leader;
							if (leader) {
								const positions = leader.geometry.attributes.position;
								positions.setXYZ(1, target.x, target.y, target.z);
								positions.needsUpdate = true;
							}
							this.needsRender = true;
						}
					} else if (this.draggedNode) {
						// Get mouse ray
						const rect = canvas.getBoundingClientRect();
						this.mouseVector.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
						this.mouseVector.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
						this.raycaster.setFromCamera(this.mouseVector, this.camera);

						// Create a plane perpendicular to camera at the FIXED drag distance
						const cameraDirection = new THREE.Vector3();
						this.camera.getWorldDirection(cameraDirection);
						// Use the stored fixed distance from drag start
						const planePoint = this.camera.position.clone().add(
							cameraDirection.clone().multiplyScalar(this.dragPlaneDistance)
						);
						const dragPlane = new THREE.Plane();
						dragPlane.setFromNormalAndCoplanarPoint(cameraDirection, planePoint);

						// Find where ray intersects the plane
						const target = new THREE.Vector3();
						this.raycaster.ray.intersectPlane(dragPlane, target);

						if (target) {
							// Position = intersection point + stored offset
							const newPos = target.clone().add(this.dragOffset);

							// Move the dragged node
							this.draggedNode.position.copy(newPos);
							// A relative pin's offset tracks the drag, so the
							// dynamics writer (anchor + offset) lands exactly
							// here — no snap-back mid-drag
							if (this.draggedNode.userData.pinAnchor) {
								this.draggedNode.userData.pinOffset.subVectors(
									this.draggedNode.position,
									this.draggedNode.userData.pinAnchor.position
								);
							}

							// Update node data
							const draggedNodeData = this.draggedNode.userData.node;
							if (draggedNodeData) {
								this.placeNodeData(draggedNodeData, newPos);
							}
							// Ctrl+drag on a sphere: the whole subtree rides
							// along, each descendant at its grab-time offset
							if (this.draggedSubtree) {
								this.draggedSubtree.forEach(({ mesh, offset }) => {
									mesh.position.copy(newPos).add(offset);
									this.placeNodeData(mesh.userData.node, mesh.position);
									this.updateLabelPosition(mesh);
								});
							}

							// Update link positions to follow the node
							this.updateLinkPositions();
							// Update label position to match node
							this.updateLabelPosition(this.draggedNode);
						}
					} else if (e.ctrlKey) {
						// Ctrl+drag: grab-the-world pan — the point under
						// the cursor stays under the cursor: translate the
						// orbit center along the camera's OWN right/up axes
						// by cursor-delta × world-units-per-pixel at the
						// target distance (camera↔lookAt = this.zoom). An
						// axis-aligned pan runs at ~¼ grab speed and goes
						// wrong-directioned once the camera is rotated
						this.camera.updateMatrixWorld();
						const rect = canvas.getBoundingClientRect();
						const wpp = 2 * this.zoom
							* Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5))
							/ rect.height;
						const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
						const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
						this.panOffset.x += (-dx * right.x + dy * up.x) * wpp;
						this.panOffset.y += (-dx * right.y + dy * up.y) * wpp;
						this.panOffset.z = (this.panOffset.z || 0) + (-dx * right.z + dy * up.z) * wpp;
						this.updateCameraPosition();
					} else {
						// Plain drag: rotate the orbit in SCREEN space —
						// horizontal drags yaw around the screen's vertical
						// axis, vertical drags pitch around the screen's
						// horizontal axis, no matter how the view was
						// rolled before. The local-frame postmultiplies
						// keep the axes screen-aligned: a fresh drag
						// behaves like a fresh render, and a quaternion
						// orbit has no poles — the tumble never snaps
						this.orbitQuat.multiply(
							new THREE.Quaternion().setFromAxisAngle(ORBIT_YAW_AXIS, dx * 0.002));
						this.orbitQuat.multiply(
							new THREE.Quaternion().setFromAxisAngle(ORBIT_PITCH_AXIS, -dy * 0.002));
						this.updateCameraPosition();
					}
				}

				this.previousMousePosition = { x: e.clientX, y: e.clientY };
				this.updateHover(e);
			}, { passive: false });

			canvas.addEventListener('mouseup', (e) => {
				// Panel drag in progress (legend or Layers & Distances): let the release reach the
				// legend's pointerup path instead of ending a scene drag
				// that never started
				if (legendDragState || genControlsDragState) return;
				e.preventDefault();
				e.stopPropagation();
				canvas.style.cursor = 'grab';
				// A roll gesture ends here — set by a Shift+mousedown
				// that grabbed no caption
				this.rollingView = false;

				if (this.draggedCaption) {
					// The override is VIEW-relative — q⁻¹ × (sprite −
					// mesh) — so it holds its screen spot on rotation
					// like the global vector
					const { mesh, sprite } = this.draggedCaption;
					const inverse = this.camera.quaternion.clone().invert();
					const offset = new THREE.Vector3()
						.subVectors(sprite.position, mesh.position)
						.applyQuaternion(inverse);
					mesh.userData.captionViewOffset = offset;
					const key = this.captionOverrideKey(mesh);
					if (key) {
						sessionCaptionOverrides[key] = { x: offset.x, y: offset.y, z: offset.z };
					}
					this.draggedCaption = null;
					this.needsRender = true;
					return;
				}

				if (this.draggedNode) {
					// Keep node position fixed, don't restart simulation
					const node = this.draggedNode.userData.node;
					if (node) {
						node.fx = node.x;
						node.fy = node.y;
						node.fz = node.z;
					}
					this.draggedNode.userData.isDragging = false;
					this.draggedNode = null;
					this.draggedSubtree = null;
					// Don't restart simulation - keep it stopped
				}
	
				this.isDragging = false;
				// A Ctrl+pan translated the orbit center along with the
				// camera — now that the gesture is over, hand the pivot
				// back to its anchor: the focused sphere while one is
				// focused, the maroon origin otherwise. Silent (camera
				// position and frame stay bit-identical), and a no-op
				// when the gesture never moved the pivot
				this.restoreGraphCenter(this.focusedMesh ? this.focusedMesh.position : null);
			});
	
			// Single click on node - show tooltip, click elsewhere - hide tooltip
			canvas.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				// A release away from the press point was a drag (rotate,
				// pan, node grab) — the browser fires click anyway, and it
				// must not read as a background click that drops the
				// selection the drag was aiming with
				if (this.pressPosition) {
					const pressDist = Math.hypot(
						e.clientX - this.pressPosition.x,
						e.clientY - this.pressPosition.y
					);
					this.pressPosition = null;
					if (pressDist > 4) { return; }
				}
				// A scene click dismisses the vector-sphere control —
				// easier than aiming for the × or the row's ⌖ again.
				// Drags never reach here (the 4px idiom above), and the
				// window's own DOM sits above the canvas, so its clicks
				// never arrive
				if (vectorControl && vectorControl.isOpen()) {
					vectorControl.close();
					vectorControlKey = null;
				}
				const rect = canvas.getBoundingClientRect();
				this.mouseVector.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
				this.mouseVector.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
				this.raycaster.setFromCamera(this.mouseVector, this.camera);
				const intersects = this.raycaster.intersectObjects(this.interactive);
				const clickHit = firstVisibleIntersect(intersects);
				if (clickHit) {
					const hitMesh = clickHit.object;
					const node = hitMesh.userData.node;
					if (node) {
						if (liveTraceNames.has(node.name) && vscodeRef) {
							// Sphere with live trace activity: single click
							// picks the trace instead of showing the tooltip
							vscodeRef.postMessage({ command: 'pickTrace', data: { name: node.name } });
						} else {
							this.handleNodeClick3D(e, node);
						}
					} else if (hitMesh.userData.creationNode) {
						this.handleCreationClick(e, hitMesh.userData.creationNode);
					} else if (hitMesh.userData.wrapperNode) {
						this.handleWrapperClick(e, hitMesh.userData.wrapperNode);
					} else if (hitMesh.userData.internalNode) {
						this.handleInternalClick(e, hitMesh.userData.internalNode);
					}
				} else {
					// Click on background - hide tooltip
					d3.select('#tooltip').classed('visible', false);
					// A single background click drops EVERYTHING at once
					// — the selection cone, the trace isolation and the
					// focused sphere's marker — and hands the orbit center
					// back to the maroon marker. Drags never reach this
					// branch: the 4px press/release idiom above already
					// returned, so rotating the scene never costs the focus
					if (this.selectionMode || this.traceMode || this.focusedMesh) {
						this.clearSelectionHighlight();
						if (this.traceMode) {
							this.exitTraceMode();
							updateStatusLine();
							if (vscodeRef) {
								vscodeRef.postMessage({ command: 'traceModeExit' });
							}
						}
						this.setFocusedMesh(null);
						this.restoreGraphCenter();
					}
				}
			});
	
			// Double-click on node - go to definition
			canvas.addEventListener('dblclick', (e) => {
				e.preventDefault();
				e.stopPropagation();
				const rect = canvas.getBoundingClientRect();
				this.mouseVector.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
				this.mouseVector.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
				this.raycaster.setFromCamera(this.mouseVector, this.camera);
				const intersects = this.raycaster.intersectObjects(this.interactive);
				const dblHit = firstVisibleIntersect(intersects);
				if (dblHit) {
					this.openMeshSource(dblHit.object);
				}
			});

			canvas.addEventListener('wheel', (e) => {
				e.preventDefault();
				e.stopPropagation();
				// Manual zoom cancels the focus animation — a panOnly
				// recenter glide survives (it never writes the zoom)
				if (this.focusAnim && !this.focusAnim.panOnly) {
					this.focusAnim = null;
				}
				this.zoom += e.deltaY * 0.5;
				// The clamp follows the scene: fitCameraToView raises
				// maxZoomOut so a huge graph can always be zoomed out
				// into full view
				this.zoom = Math.max(50, Math.min(this.maxZoomOut || 2500, this.zoom));
				this.updateCameraPosition();
			}, { passive: false });

			// Prevent context menu on right-click
			canvas.addEventListener('contextmenu', (e) => {
				e.preventDefault();
				e.stopPropagation();
			});
		}

		/**
		 * Writes a sphere's position into its node data as USER-PLACED,
		 * so a knob relayout keeps this spot: calculatePosition honors
		 * x3d, relaxTypeShells skips it, and Save persists it
		 */
		placeNodeData(nodeData, pos) {
			nodeData.x = pos.x;
			nodeData.y = pos.y;
			nodeData.z = pos.z;
			nodeData.fx = pos.x;
			nodeData.fy = pos.y;
			nodeData.fz = pos.z;
			nodeData.x3d = pos.x;
			nodeData.y3d = pos.y;
			nodeData.z3d = pos.z;
		}

		/**
		 * Every descendant sphere of a type sphere (the inheritance
		 * subtree, all depths) with its offset from that sphere — the
		 * Ctrl+drag set. Descendants without a mesh in the current
		 * world are skipped
		 */
		collectSubtreeMeshes(rootMesh) {
			const subtree = [];
			const seen = new Set();
			const pending = [ ...rootMesh.userData.node.children ];
			while (pending.length > 0) {
				const node = pending.pop();
				if (seen.has(node)) { continue; }
				seen.add(node);
				const mesh = this.nodeMeshes.get(node.id);
				if (mesh && mesh !== rootMesh) {
					subtree.push({
						mesh,
						offset : new THREE.Vector3().subVectors(mesh.position, rootMesh.position),
					});
				}
				pending.push(...node.children);
			}
			return subtree;
		}

		/**
		 * The anchor a dragged element pins RELATIVE to — moving the
		 * anchor carries the element as a set:
		 *  - holder diamond → its primary created type's sphere
		 *  - bagel → the hosting scope's diamond (the wrapped callback),
		 *    else the wrapped type's sphere (constructor wrap)
		 *  - everything else (chain/starter nodes, ambient bagels,
		 *    internals knots) → null: absolute pin, nothing to follow
		 */
		resolvePinAnchor(mesh) {
			const userData = mesh.userData;
			if (userData.creationNode && Array.isArray(userData.creationNode.creates) && userData.creationNode.creates.length > 0) {
				const primaryPath = userData.creationNode.creates[0].typePath;
				const sphere = this.nodeMeshes.get(primaryPath) || null;
				return sphere;
			}
			if (userData.wrapperNode) {
				const creationId = userData.wrapperNode.callbackScopeId || userData.wrapperNode.holderScopeId;
				const creationMesh = creationId ? this.creationMeshById.get(creationId) : null;
				if (creationMesh) {
					return creationMesh;
				}
				const typeMesh = userData.wrapperNode.wrapsTypePath
					? this.nodeMeshes.get(userData.wrapperNode.wrapsTypePath) || null
					: null;
				return typeMesh;
			}
			if (userData.internalNode) {
				// Adapter sinks anchor to the Jaeger cone — the cone
				// carries its stack, same follow rule as diamonds on
				// spheres. The cone itself, the ring, and the hub keep
				// the absolute pin
				if (userData.internalNode.role === 'sink') {
					const jaeger = this.internalsMeshes.find(m => m.userData.internalNode && m.userData.internalNode.role === 'external');
					return jaeger || null;
				}
				return null;
			}
			return null;
		}

		updateCameraPosition() {
			// panOffset.z is optional: saved camera states from before the
			// z-aware orbit center do not carry it
			const panZ = this.panOffset.z || 0;
			// The orbit quaternion is the whole rotational state: offset
			// direction, up vector and Shift-roll all ride it
			const offset = new THREE.Vector3(0, 0, this.zoom).applyQuaternion(this.orbitQuat);
			this.camera.position.set(
				offset.x + this.panOffset.x,
				offset.y + this.panOffset.y,
				offset.z + panZ);
			if (this.aimAnchor) {
				// Aim decoupled from the pivot (a focus drop snapped the
				// orbit center home): keep the frame the user is looking
				// at — apply only the DELTA of the coupled orientation
				// since the snap, so the maroon marker holds its screen
				// spot instead of jumping to center on the next gesture
				const qTo = this.coupledAimQuaternion(this.orbitQuat);
				this.camera.quaternion.copy(qTo)
					.multiply(this.aimAnchor.fromInv)
					.multiply(this.aimAnchor.quaternion);
			} else {
				this.camera.up.set(0, 1, 0).applyQuaternion(this.orbitQuat);
				this.camera.lookAt(this.panOffset.x, this.panOffset.y, panZ);
			}
			// Every camera mutation funnels here (rotate/pan/wheel/zoom/
			// reset/focus-anim ticks), so one flag covers them all
			this.needsRender = true;
		}

		// The orientation the coupled branch of updateCameraPosition
		// produces for an orbit state — its up/lookAt math with the camera
		// placed on the unit offset direction, aimed at the pivot. The
		// decoupled branch quotients the live state against the anchor's
		// snapshot, so both sides must stay the SAME math
		coupledAimQuaternion(orbitQuat) {
			const eye = new THREE.Vector3(0, 0, 1).applyQuaternion(orbitQuat);
			const up = new THREE.Vector3(0, 1, 0).applyQuaternion(orbitQuat);
			const target = new THREE.Vector3(0, 0, 0);
			const matrix = new THREE.Matrix4().lookAt(eye, target, up);
			const result = new THREE.Quaternion().setFromRotationMatrix(matrix);
			return result;
		}

		focusNode(id, name) {
			let mesh = this.nodeMeshes.get(id);
			if (!mesh && name) {
				// Fallback: match by short display name
				for (const candidate of this.nodeMeshes.values()) {
					const candidateNode = candidate.userData.node;
					if (candidateNode && candidateNode.name === name) {
						mesh = candidate;
						break;
					}
				}
			}
			if (!mesh) return;

			// A deliberate focus re-couples the aim to the pivot — the
			// approach animation flies the coupled model onto the item
			this.aimAnchor = null;

			const node = mesh.userData.node;
			// Every focus path (tree click, Show on Graph, By Generation)
			// also lights the item's inheritance cone — the camera answer
			// alone never showed the PATH
			this.applySelectionHighlight(node.id);
			const pos = mesh.position;

			// Rotation target: FACE the item from the outside. The
			// camera ends on the center→item ray BEYOND the sphere,
			// looking inward — the item is the foreground and the graph
			// center reads behind it in the distance. A chain-aligned
			// approach (parent→node direction rotated ~80° off-axis,
			// Rodrigues) would depend on chain geometry, so a tree click
			// could fly the camera INTO the graph and face the item's
			// inner side. From the outside the parent sits behind the
			// item anyway, which is the requested reading; outer-shell
			// children may still block the ray — pickClearView steps
			// around them.
			// The upright-band target search below works in the retired
			// spherical angles; the orbit itself is a quaternion — derive
			// the current angles from it
			const currentAngles = orbitAnglesFromQuat(this.orbitQuat);
			let targetRotX = currentAngles.x;
			let targetRotY = currentAngles.y;
			const parentMesh = node && node.parent ? this.nodeMeshes.get(node.parent.id) : null;
			const radialLen = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z);
			if (radialLen > 0.0001) {
				// The camera offset direction (orbit center → camera)
				// is the item's own radial; updateCameraPosition's
				// spherical map inverts as rotX = asin(d.y),
				// rotY = atan2(d.x, d.z)
				const dirX = pos.x / radialLen;
				const dirY = pos.y / radialLen;
				const dirZ = pos.z / radialLen;
				targetRotX = Math.asin(Math.max(-1, Math.min(1, dirY)));
				targetRotY = Math.atan2(dirX, dirZ);
				// Focus targets stay in the upright band (ctrl+drag
				// allows over-pole tumbling, but a programmatic focus
				// should always land right-side up)
				targetRotX = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, targetRotX));
			}

			// Adaptive zoom: fit the node's neighborhood (parent,
			// siblings, children) into the frame so a focus never ends
			// as a lone sphere with no context. Truly isolated nodes
			// (single-constructor project) fall back to the minimum.
			const neighborhood = [pos];
			if (parentMesh) {
				neighborhood.push(parentMesh.position);
				const siblings = node.parent.children || [];
				for (const sibling of siblings) {
					const siblingMesh = this.nodeMeshes.get(sibling.id);
					if (siblingMesh) {
						neighborhood.push(siblingMesh.position);
					}
				}
			}
			const childNodes = (node && node.children) || [];
			for (const child of childNodes) {
				const childMesh = this.nodeMeshes.get(child.id);
				if (childMesh) {
					neighborhood.push(childMesh.position);
				}
			}
			let neighborhoodRadius = 0;
			for (const point of neighborhood) {
				const distance = pos.distanceTo(point);
				if (distance > neighborhoodRadius) {
					neighborhoodRadius = distance;
				}
			}
			// Frustum fit: use the narrower of the vertical/horizontal
			// half-angles (the pane is often taller than wide); the 1.4
			// margin keeps the label sprites inside the frame
			const vHalf = (this.camera.fov * Math.PI / 180) / 2;
			const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
			const fitHalf = Math.min(vHalf, hHalf);
			const fitZoom = neighborhoodRadius > 0.0001
				? (neighborhoodRadius / Math.tan(fitHalf)) * 1.4
				: 250;
			const targetZoom = Math.max(250, Math.min(800, fitZoom));

			// Already-visible fast path: when the node is on
			// screen and unoccluded from the CURRENT camera, switching
			// between tree items must keep the orientation — rotation
			// there is unnecessary and only hides details. Highlight
			// (glow) plus a gentle re-fit zoom/pan is enough. Rotation
			// is reserved for nodes that are off-screen or hidden.
			const alreadyVisible = this.isNodeInCurrentView(mesh);
			if (alreadyVisible) {
				let stayZoom = targetZoom;
				if (!this.isViewClear(currentAngles.x, currentAngles.y, stayZoom, pos, mesh)) {
					// Re-fit would push an occluder in front of the
					// node — keep the current distance instead
					stayZoom = this.zoom;
				}
				this.focusAnim = {
					start : performance.now(),
					duration : 900,
					from : {
						rotQ : this.orbitQuat.clone(),
						zoom : this.zoom,
						pan  : { x: this.panOffset.x, y: this.panOffset.y, z: this.panOffset.z || 0 }
					},
					to : {
						// Highlight-only path: the orientation stays
						rotQ : this.orbitQuat.clone(),
						zoom : stayZoom,
						pan  : { x: pos.x, y: pos.y, z: pos.z }
					}
				};
				this.setFocusedMesh(mesh);
				debugLog('[focusNode] ' + id + ' already visible -> highlight only (zoom ' + Math.round(stayZoom) + ')', 'log');
				return;
			}

			// De-occlusion: whatever base view we picked (chain off-axis
			// or the current rotation for roots), another sphere may sit
			// between the camera and the focused node. Rotate the view
			// around the world Y in 20° steps until the target is
			// actually visible — smaller spheres are OK,
			// a hidden focused sphere is not.
			const clearView = this.pickClearView(targetRotX, targetRotY, targetZoom, pos, mesh);
			targetRotX = clearView.rotX;
			targetRotY = clearView.rotY;

			// Two-phase animation: rotate the chain into
			// view first (0–55% of the timeline), zoom in second
			// (45–100%), phases overlap slightly for a natural feel
			this.focusAnim = {
				start : performance.now(),
				duration : 900,
				from : {
					rotQ : this.orbitQuat.clone(),
					zoom : this.zoom,
					pan  : { x: this.panOffset.x, y: this.panOffset.y, z: this.panOffset.z || 0 }
				},
				to : {
					// The angle-space target converts — a focus lands
					// upright (no roll), same as the spherical model
					rotQ : quatFromOrbitAngles(targetRotX, targetRotY),
					zoom : targetZoom,
					pan  : { x: pos.x, y: pos.y, z: pos.z }
				}
			};
			this.setFocusedMesh(mesh);
			debugLog('[focusNode] ' + id + ' -> anim ' + JSON.stringify(this.focusAnim.to), 'log');
		}

		setFocusedMesh(mesh) {
			if (this.focusedMesh && this.focusedMesh !== mesh) {
				this.restoreFocusGlow(this.focusedMesh);
			}
			this.focusedMesh = mesh || null;
			// (Re)arm the pulse clock — re-clicking the focused sphere
			// restarts its 7 seconds
			this.focusPulseStart = performance.now();
			this.focusPulseSettled = false;
			// Unfocus (background click) restores the old glow while
			// NOTHING is animating anymore — without the flag that
			// restored state would never paint
			this.needsRender = true;
		}

		restoreFocusGlow(mesh) {
			const node = mesh.userData.node;
			if (node && node.isRoot) {
				// Root baseline glow (set at mesh creation)
				mesh.material.emissiveIntensity = 0.3;
			} else {
				mesh.material.emissive = new THREE.Color(0x000000);
				mesh.material.emissiveIntensity = 0;
			}
		}

		updateFocusAnimation() {
			if (!this.focusAnim) return;
			const anim = this.focusAnim;
			const t = Math.min((performance.now() - anim.start) / anim.duration, 1);
			const rotT = easeInOutCubic(Math.min(t / 0.55, 1));
			const zoomT = easeInOutCubic(Math.max(0, (t - 0.45) / 0.55));

			// Quaternion slerp takes the shortest arc by itself — the
			// angle model's yaw wrap-around handling is unnecessary
			this.orbitQuat.slerpQuaternions(anim.from.rotQ, anim.to.rotQ, rotT);
			this.panOffset.x = lerp(anim.from.pan.x, anim.to.pan.x, rotT);
			this.panOffset.y = lerp(anim.from.pan.y, anim.to.pan.y, rotT);
			this.panOffset.z = lerp(anim.from.pan.z, anim.to.pan.z, rotT);
			this.zoom = lerp(anim.from.zoom, anim.to.zoom, zoomT);
			this.updateCameraPosition();

			if (t >= 1) {
				this.focusAnim = null;
				if (this.focusedMesh) {
					// Self-check the landed view: is the focused sphere
					// actually unoccluded from the final camera?
					const landedAngles = orbitAnglesFromQuat(this.orbitQuat);
					const landed = this.isViewClear(
						landedAngles.x, landedAngles.y,
						this.zoom, this.focusedMesh.position, this.focusedMesh
					);
					debugLog('[focusNode] final view clear: ' + landed, landed ? 'log' : 'warn');
				}
			}
		}

		updateFocusPulse() {
			const mesh = this.focusedMesh;
			if (!mesh) return;
			if (this.focusPulseSettled) return;
			if (performance.now() - this.focusPulseStart >= 7000) {
				// 7 seconds of blink is enough — settle on the base glow
				// once. The focus itself stays; only the pulse retires,
				// and with it the render loop's reason to stay awake
				this.focusPulseSettled = true;
				this.restoreFocusGlow(mesh);
				this.needsRender = true;
				return;
			}
			const node = mesh.userData.node;
			const base = node && node.isRoot ? 0.3 : 0;
			if (!node || !node.isRoot) {
				// Non-root materials are created without an emissive
				// color — give the focused one a gold glow
				mesh.material.emissive = new THREE.Color(0xffc040);
			}
			mesh.material.emissiveIntensity = base + 0.5 + 0.35 * Math.sin(performance.now() * 0.006);
		}

		// Node ids are not type names — the name match scan both the
		// trace flash and trace mode use (same fallback focusNode uses)
		findMeshByName(name) {
			let target = this.nodeMeshes.get(name);
			if (!target) {
				for (const candidate of this.nodeMeshes.values()) {
					if (candidate.userData.node && candidate.userData.node.name === name) {
						target = candidate;
						break;
					}
				}
			}
			return target || null;
		}

		// Live trace illumination: light EVERY sphere the incoming
		// edge's lineage touches, in the trace-mode acid-green — the
		// full trace glows as one body. Errored members go red and are
		// never downgraded back to green by a later healthy relative.
		flashTraceLineage(names, erroredNames) {
			const expiry = performance.now() + Graph3DRenderer.FLASH_MS;
			for (const name of names) {
				const mesh = this.findMeshByName(name);
				if (!mesh) continue;
				const existing = this.traceFlashes.get(mesh);
				const red = (erroredNames && erroredNames.has(name)) ||
					(existing !== undefined && existing.color === Graph3DRenderer.TRACE_ERROR_COLOR);
				const color = red
					? Graph3DRenderer.TRACE_ERROR_COLOR
					: Graph3DRenderer.TRACE_COLOR;
				this.traceFlashes.set(mesh, { expiry, color });
			}
		}

		// Long enough to catch a human eye
		static get FLASH_MS() { return 5000; }

		updateTraceFlashes() {
			if (this.traceMode) {
				// Ambient flashes are monitoring noise; trace mode
				// isolates ONE trace, so the pulses go quiet. REPLAY
				// flashes are the point of the mode — they keep running.
				this.traceFlashes.forEach((entry, mesh) => {
					mesh.scale.setScalar(1);
				});
				this.traceFlashes.clear();
			} else {
				this.decayFlashes(this.traceFlashes);
			}
			this.decayFlashes(this.replayFlashes);
		}

		// Shared flash decay for both flash maps: entries are
		// { expiry, color }. On expiry a mesh inside the open
		// trace restores its TRACE color (the path stays lit), everything
		// else returns to its base state.
		decayFlashes(map) {
			if (map.size === 0) return;
			const now = performance.now();
			map.forEach((entry, mesh) => {
				if (mesh === this.focusedMesh) {
					// The focus pulse owns this mesh's emissive
					mesh.scale.setScalar(1);
					map.delete(mesh);
					return;
				}
				const node = mesh.userData.node;
				const base = node && node.isRoot ? 0.3 : 0;
				const expiry = entry.expiry;
				const color = entry.color;
				const remaining = expiry - now;
				if (remaining <= 0) {
					const mode = this.traceMode;
					if (mode && mode.meshes.indexOf(mesh) !== -1) {
						const nodeName = node && node.name;
						const errored = mode.erroredNames && nodeName && mode.erroredNames.has(nodeName);
						mesh.material.emissive = new THREE.Color(errored
							? Graph3DRenderer.TRACE_ERROR_COLOR
							: Graph3DRenderer.TRACE_COLOR);
						mesh.material.emissiveIntensity = 0.9;
						mesh.scale.setScalar(1);
						map.delete(mesh);
						return;
					}
					// Roots carry a dark-red emissive by default — the
					// flash overwrote the color, so restore it here
					if (node && node.isRoot) {
						mesh.material.emissive = new THREE.Color(0x8B0000);
					}
					mesh.material.emissiveIntensity = base;
					mesh.scale.setScalar(1);
					map.delete(mesh);
					return;
				}
				const life = remaining / Graph3DRenderer.FLASH_MS;
				mesh.material.emissive = new THREE.Color(color);
				mesh.material.emissiveIntensity = base + 1.4 * life;
				// Shape change, not just light: the sphere swells up to
				// +40% at the hit and shrinks back as the flash decays
				mesh.scale.setScalar(1 + 0.4 * life);
			});
		}

		// Replay a stored trace at human speed: walk the lineage in ring
		// (= chronological) order, one flash per edge, ~650ms apart — the
		// original events run at machine speed, which no human can follow.
		// Errored steps flash red. Callers usually enter trace mode first
		// so the replay walks the isolated path.
		replayTrace(edges) {
			this.cancelReplay();
			const steps = [];
			for (const edge of edges) {
				if (!edge || typeof edge !== 'object') continue;
				const nm = edge.instanceType || (typeof edge.name === 'string' ? edge.name : null);
				if (!nm) continue;
				steps.push({ name: nm, error: edge.status === 'error' });
			}
			let i = 0;
			const step = () => {
				if (i >= steps.length) {
					this.replayTimer = null;
					return;
				}
				const s = steps[i++];
				const mesh = this.findMeshByName(s.name);
				if (mesh) {
					this.replayFlashes.set(mesh, {
						expiry : performance.now() + Graph3DRenderer.FLASH_MS,
						color  : s.error ? Graph3DRenderer.TRACE_ERROR_COLOR : Graph3DRenderer.TRACE_COLOR,
					});
				}
				this.replayTimer = setTimeout(step, 650);
			};
			step();
		}

		cancelReplay() {
			if (this.replayTimer) {
				clearTimeout(this.replayTimer);
				this.replayTimer = null;
			}
			this.replayFlashes.forEach((entry, mesh) => {
				mesh.scale.setScalar(1);
			});
			this.replayFlashes.clear();
		}

		// Green for the isolated trace path; distinct from the fire-red
		// ambient flash and the gold focus pulse. Edges that dive pinned
		// with an error go red instead — the failure must be visible at
		// a glance, not discoverable only by expanding the tree.
		static get TRACE_COLOR() { return 0x40ff80; }
		static get TRACE_ERROR_COLOR() { return 0xff2020; }

		// Dim level for everything OUTSIDE the selected cone. Picked from
		// the 10/20/30% mock captures: 30% keeps too much noise, 10% is
		// near-isolation, 20% keeps orientation while the path owns the
		// frame
		static get SELECTION_DIM() { return 0.2; }

		/**
		 * Tree-click selection: light the item's whole inheritance cone —
		 * ancestors + self + descendants, one prefix walk over the
		 * dot-joined ids (a leaf lights its chain, a root lights its
		 * subtree) — and dim the rest of the scene to SELECTION_DIM.
		 * Mechanics mirror trace mode (emissive + shared-material
		 * dimming + restore bookkeeping) but stay a SEPARATE mode: trace
		 * mode means runtime lineage, selection means static structure.
		 * The focused mesh itself keeps its gold pulse on top — the
		 * pulse says "you clicked THIS", the green cone says "its path".
		 */
		applySelectionHighlight(id) {
			this.clearSelectionHighlight();
			const cone = new Set();
			this.nodeMeshes.forEach((mesh, meshId) => {
				if (meshId === id || meshId.startsWith(id + '.') || id.startsWith(meshId + '.')) {
					cone.add(meshId);
				}
			});
			if (!cone.has(id)) { return; }
			const dimmed = { line: null, arrow: null, pathHit: null };
			this.nodeMeshes.forEach((mesh, meshId) => {
				const m = mesh.material;
				// Stash exactly what gets overwritten — the census dim
				// (never-created spheres sit at 0.35) and the root glow
				// must come back on clear, not a blanket opacity 1
				mesh.userData.selRestore = {
					opacity           : m.opacity,
					transparent       : m.transparent,
					emissive          : m.emissive.getHex(),
					emissiveIntensity : m.emissiveIntensity,
					labelOpacity      : mesh.userData.label ? mesh.userData.label.material.opacity : null
				};
				if (cone.has(meshId)) {
					m.emissive = new THREE.Color(Graph3DRenderer.TRACE_COLOR);
					m.emissiveIntensity = 0.9;
					m.opacity = 1;
					m.transparent = false;
					if (mesh.userData.label) {
						mesh.userData.label.material.opacity = 1;
					}
				} else {
					m.transparent = true;
					m.opacity = Graph3DRenderer.SELECTION_DIM;
					m.emissiveIntensity = 0;
					if (mesh.userData.label) {
						mesh.userData.label.material.opacity = Graph3DRenderer.SELECTION_DIM;
					}
				}
				m.needsUpdate = true;
			});
			// Dim the SHARED link materials — same idiom as trace mode
			if (this.linkLines.length > 0) {
				dimmed.line = this.linkLines[0].line.material;
				dimmed.arrow = this.linkLines[0].arrow.material;
				dimmed.line.opacity = 0.15;
				dimmed.arrow.transparent = true;
				dimmed.arrow.opacity = 0.15;
				dimmed.arrow.needsUpdate = true;
			}
			if (this.pathHitLines.length > 0) {
				dimmed.pathHit = [];
				this.pathHitLines.forEach(({ line }) => {
					if (!dimmed.pathHit.includes(line.material)) {
						dimmed.pathHit.push(line.material);
					}
				});
				dimmed.pathHit.forEach(m => {
					m.userData.restoreOpacity = m.opacity;
					m.opacity = Math.min(m.opacity, 0.1);
					m.needsUpdate = true;
				});
			}
			// The glow tube threads the ANCESTOR chain only (root → self)
			// — a subtree is a branching cone, no single curve reads there
			const chain = [];
			let prefix = id;
			while (prefix) {
				const chainMesh = this.nodeMeshes.get(prefix);
				if (chainMesh) {
					chain.unshift(chainMesh);
				}
				prefix = prefix.includes('.') ? prefix.slice(0, prefix.lastIndexOf('.')) : null;
			}
			this.selectionMode = { id, cone, chain, tube: null, tubeSig: null, dimmed };
			this.updateSelectionTube();
			this.needsRender = true;
		}

		// Leave selection: hand every mesh its stashed pre-selection
		// state back (census dim and root glow included), restore the
		// shared materials, and dispose the tube
		clearSelectionHighlight() {
			const sel = this.selectionMode;
			if (!sel) { return; }
			this.nodeMeshes.forEach(mesh => {
				const stash = mesh.userData.selRestore;
				if (!stash) { return; }
				const m = mesh.material;
				m.opacity = stash.opacity;
				m.transparent = stash.transparent;
				m.emissive = new THREE.Color(stash.emissive);
				// A live focus pulse rewrites the focused mesh's
				// intensity every frame anyway — this is just the baseline
				m.emissiveIntensity = stash.emissiveIntensity;
				if (mesh.userData.label && stash.labelOpacity !== null) {
					mesh.userData.label.material.opacity = stash.labelOpacity;
				}
				m.needsUpdate = true;
				delete mesh.userData.selRestore;
			});
			if (sel.dimmed.line) {
				sel.dimmed.line.opacity = 0.8;
				sel.dimmed.line.needsUpdate = true;
			}
			if (sel.dimmed.arrow) {
				sel.dimmed.arrow.transparent = false;
				sel.dimmed.arrow.opacity = 1;
				sel.dimmed.arrow.needsUpdate = true;
			}
			if (sel.dimmed.pathHit) {
				sel.dimmed.pathHit.forEach(m => {
					m.opacity = m.userData.restoreOpacity ?? 0.5;
					m.needsUpdate = true;
				});
			}
			if (sel.tube) {
				if (sel.tube.parent) {
					sel.tube.parent.remove(sel.tube);
				}
				sel.tube.geometry.dispose();
				sel.tube.material.dispose();
			}
			this.selectionMode = null;
			this.needsRender = true;
		}

		// The tube follows drags and relayouts: rebuilt from live chain
		// positions at the end of updateLinkPositions, but ONLY when a
		// chain sphere actually moved — an unrelated dynamics pass must
		// not churn geometry
		updateSelectionTube() {
			const sel = this.selectionMode;
			if (!sel) { return; }
			const sig = sel.chain.map(m =>
				Math.round(m.position.x) + ',' + Math.round(m.position.y) + ',' + Math.round(m.position.z)
			).join('|');
			if (sig === sel.tubeSig) { return; }
			sel.tubeSig = sig;
			if (sel.tube) {
				if (sel.tube.parent) {
					sel.tube.parent.remove(sel.tube);
				}
				sel.tube.geometry.dispose();
				sel.tube.material.dispose();
				sel.tube = null;
			}
			if (sel.chain.length < 2) { return; }
			const pts = sel.chain.map(m => m.position.clone());
			const curve = new THREE.CatmullRomCurve3(pts);
			const tubeRadius = (this.nodeRadius3d || 12) * 0.2;
			const tubeGeo = new THREE.TubeGeometry(curve, 64, tubeRadius, 8, false);
			const tubeMat = new THREE.MeshBasicMaterial({
				color       : Graph3DRenderer.TRACE_COLOR,
				transparent : true,
				opacity     : 0.85
			});
			sel.tube = new THREE.Mesh(tubeGeo, tubeMat);
			this.graphRoot.add(sel.tube);
		}

		// Enter trace mode: isolate the resolved lineage — path spheres
		// green (red where an edge errored), links between consecutive
		// path nodes green, everything else dimmed.
		// edges = lineage (root → … → descendants).
		enterTraceMode(edges, selectedName) {
			this.exitTraceMode();
			this.traceFlashes.clear();
			this.setFocusedMesh(null);
			// Trace mode carries no focused sphere — the orbit pivot
			// belongs on the maroon origin. A pivot left on a
			// previously focused sphere snaps home silently
			this.restoreGraphCenter();
			// Runtime lineage beats static structure: the selection's
			// cone/tube would fight the trace's own dimming
			this.clearSelectionHighlight();
			const namesInOrder = [];
			const seen = new Set();
			const erroredNames = new Set();
			for (const edge of edges) {
				if (!edge || typeof edge !== 'object') continue;
				const nm = edge.instanceType || (typeof edge.name === 'string' ? edge.name : null);
				if (nm && edge.status === 'error') {
					erroredNames.add(nm);
				}
				if (nm && !seen.has(nm)) {
					seen.add(nm);
					namesInOrder.push(nm);
				}
			}
			const meshes = [];
			for (const nm of namesInOrder) {
				const mesh = this.findMeshByName(nm);
				if (mesh) meshes.push(mesh);
			}
			const inPath = new Set(meshes);
			const dimmed = { line: null, arrow: null };
			this.nodeMeshes.forEach(mesh => {
				const m = mesh.material;
				if (inPath.has(mesh)) {
					const nodeName = mesh.userData.node && mesh.userData.node.name;
					const errored = nodeName !== null && erroredNames.has(nodeName);
					m.emissive = new THREE.Color(errored
						? Graph3DRenderer.TRACE_ERROR_COLOR
						: Graph3DRenderer.TRACE_COLOR);
					m.emissiveIntensity = 0.9;
				} else {
					m.transparent = true;
					m.opacity = 0.25;
					m.emissiveIntensity = 0;
					if (mesh.userData.label) {
						mesh.userData.label.material.opacity = 0.25;
					}
				}
				m.needsUpdate = true;
			});
			// Dim the SHARED link materials (all non-path links ride
			// them); path links get cloned materials so the shared ones
			// stay dimmed underneath
			if (this.linkLines.length > 0) {
				dimmed.line = this.linkLines[0].line.material;
				dimmed.arrow = this.linkLines[0].arrow.material;
				dimmed.line.opacity = 0.15;
				dimmed.arrow.transparent = true;
				dimmed.arrow.opacity = 0.15;
				dimmed.arrow.needsUpdate = true;
			}
			// Path-hit overlay dims with the skeleton (two shared materials:
			// taken + never-taken — dim both, remembering each one's own
			// opacity for the restore)
			if (this.pathHitLines.length > 0) {
				dimmed.pathHit = [];
				this.pathHitLines.forEach(({ line }) => {
					if (!dimmed.pathHit.includes(line.material)) {
						dimmed.pathHit.push(line.material);
					}
				});
				dimmed.pathHit.forEach(m => {
					m.userData.restoreOpacity = m.opacity;
					m.opacity = Math.min(m.opacity, 0.1);
					m.needsUpdate = true;
				});
			}
			const links = [];
			for (let i = 0; i < namesInOrder.length - 1; i++) {
				this.highlightLinkBetween(namesInOrder[i], namesInOrder[i + 1], links);
			}
			this.traceMode = {
				names  : namesInOrder,
				meshes : meshes,
				links  : links,
				dimmed : dimmed,
				erroredNames : erroredNames,
				selectedName : selectedName || null
			};
			// The dim/recolor above is not an animation — flag the paint
			this.needsRender = true;
		}

		// Clone-and-green the graph link connecting two names, if one
		// exists (either direction — AOT link direction need not match
		// runtime lineage). Originals are stashed for exitTraceMode.
		highlightLinkBetween(nameA, nameB, collector) {
			for (const entry of this.linkLines) {
				const s = entry.link.source && entry.link.source.name;
				const t = entry.link.target && entry.link.target.name;
				const match = (s === nameA && t === nameB) || (s === nameB && t === nameA);
				if (!match) continue;
				if (!entry.origLineMaterial) {
					entry.origLineMaterial = entry.line.material;
					entry.origArrowMaterial = entry.arrow.material;
					entry.line.material = entry.line.material.clone();
					entry.arrow.material = entry.arrow.material.clone();
				}
				entry.line.material.color = new THREE.Color(Graph3DRenderer.TRACE_COLOR);
				entry.line.material.opacity = 1;
				entry.arrow.material.color = new THREE.Color(Graph3DRenderer.TRACE_COLOR);
				entry.arrow.material.opacity = 1;
				collector.push(entry);
			}
		}

		// Mid-flight: fresh edges of the open trace arrived — undim and
		// green their nodes, extend the link chain from the current leaf
		extendTraceMode(edges) {
			const mode = this.traceMode;
			if (!mode) return;
			if (!mode.erroredNames) {
				mode.erroredNames = new Set();
			}
			// Late completions: an edge entered green via 'enter' and now
			// arrives errored via 'settle' — recolor the sphere it owns
			for (const edge of edges) {
				if (!edge || typeof edge !== 'object') continue;
				if (edge.status !== 'error') continue;
				const nm = edge.instanceType || (typeof edge.name === 'string' ? edge.name : null);
				if (!nm || mode.erroredNames.has(nm)) continue;
				mode.erroredNames.add(nm);
				const mesh = this.findMeshByName(nm);
				if (mesh) {
					mesh.material.emissive = new THREE.Color(Graph3DRenderer.TRACE_ERROR_COLOR);
					mesh.material.needsUpdate = true;
				}
			}
			const newNames = [];
			for (const edge of edges) {
				if (!edge || typeof edge !== 'object') continue;
				const nm = edge.instanceType || (typeof edge.name === 'string' ? edge.name : null);
				if (nm && mode.names.indexOf(nm) === -1 && newNames.indexOf(nm) === -1) {
					newNames.push(nm);
				}
			}
			let previous = mode.names[mode.names.length - 1];
			for (const nm of newNames) {
				const mesh = this.findMeshByName(nm);
				if (mesh) {
					const m = mesh.material;
					m.transparent = false;
					m.opacity = 1;
					m.emissive = new THREE.Color(mode.erroredNames.has(nm)
						? Graph3DRenderer.TRACE_ERROR_COLOR
						: Graph3DRenderer.TRACE_COLOR);
					m.emissiveIntensity = 0.9;
					m.needsUpdate = true;
					if (mesh.userData.label) {
						mesh.userData.label.material.opacity = 1;
					}
					mode.meshes.push(mesh);
				}
				if (previous) {
					this.highlightLinkBetween(previous, nm, mode.links);
				}
				mode.names.push(nm);
				previous = nm;
			}
			// Late recolors/undims are plain mutations, not animations
			this.needsRender = true;
		}

		// Leave trace mode: restore dimmed spheres/links and the shared
		// materials; focus pulse and ambient flashes resume
		exitTraceMode() {
			const mode = this.traceMode;
			if (!mode) return;
			this.cancelReplay();
			const inPath = new Set(mode.meshes);
			this.nodeMeshes.forEach(mesh => {
				const m = mesh.material;
				const node = mesh.userData.node;
				const isRoot = node && node.isRoot;
				if (node && isRoot) {
					m.emissive = new THREE.Color(0x8B0000);
				}
				m.emissiveIntensity = isRoot ? 0.3 : 0;
				if (!inPath.has(mesh)) {
					m.opacity = 1;
					m.transparent = false;
					if (mesh.userData.label) {
						mesh.userData.label.material.opacity = 1;
					}
				}
				m.needsUpdate = true;
			});
			for (const entry of mode.links) {
				if (entry.origLineMaterial) {
					entry.line.material.dispose();
					entry.arrow.material.dispose();
					entry.line.material = entry.origLineMaterial;
					entry.arrow.material = entry.origArrowMaterial;
					entry.origLineMaterial = null;
					entry.origArrowMaterial = null;
				}
			}
			if (mode.dimmed.line) {
				mode.dimmed.line.opacity = 0.8;
				mode.dimmed.line.needsUpdate = true;
			}
			if (mode.dimmed.arrow) {
				mode.dimmed.arrow.transparent = false;
				mode.dimmed.arrow.opacity = 1;
				mode.dimmed.arrow.needsUpdate = true;
			}
			if (mode.dimmed.pathHit) {
				mode.dimmed.pathHit.forEach(m => {
					m.opacity = m.userData.restoreOpacity ?? 0.5;
					m.needsUpdate = true;
				});
			}
			this.traceMode = null;
			// The restore above mutated materials outside any animation
			this.needsRender = true;
		}

		// Unit view direction (camera → orbit center) for given angles,
		// inverse of the updateCameraPosition spherical placement
		viewFromAngles(rotX, rotY) {
			const result = {
				x : -Math.sin(rotY) * Math.cos(rotX),
				y : -Math.sin(rotX),
				z : -Math.cos(rotY) * Math.cos(rotX)
			};
			return result;
		}

		// True when the node is inside the current frame (with margin
		// for its label) and unoccluded from the live camera — the
		// condition for the highlight-only fast path in focusNode
		isNodeInCurrentView(mesh) {
			const projected = mesh.position.clone().project(this.camera);
			if (projected.z > 1 || projected.z < -1) {
				const offscreen = false;
				return offscreen;
			}
			if (Math.abs(projected.x) > 0.85 || Math.abs(projected.y) > 0.85) {
				const offscreen = false;
				return offscreen;
			}
			const clear = this.isViewClearFrom(this.camera.position, mesh.position, mesh);
			return clear;
		}

		// True when no other sphere blocks the focused node from the
		// camera position implied by these angles and zoom
		isViewClear(rotX, rotY, zoom, nodePos, focusedMesh) {
			const view = this.viewFromAngles(rotX, rotY);
			const camPos = {
				x : nodePos.x - view.x * zoom,
				y : nodePos.y - view.y * zoom,
				z : nodePos.z - view.z * zoom
			};
			const result = this.isViewClearFrom(camPos, nodePos, focusedMesh);
			return result;
		}

		// Occlusion test from an explicit camera position — shared by
		// the hypothetical-camera sweep (isViewClear) and the
		// live-camera visibility check (isNodeInCurrentView)
		isViewClearFrom(camPos, nodePos, focusedMesh) {
			const nx = nodePos.x - camPos.x;
			const ny = nodePos.y - camPos.y;
			const nz = nodePos.z - camPos.z;
			const nodeDist = Math.sqrt(nx * nx + ny * ny + nz * nz);
			if (nodeDist < 0.0001) {
				const atop = true;
				return atop;
			}
			const dirX = nx / nodeDist;
			const dirY = ny / nodeDist;
			const dirZ = nz / nodeDist;
			for (const other of this.nodeMeshes.values()) {
				if (other === focusedMesh) { continue; }
				const ox = other.position.x - camPos.x;
				const oy = other.position.y - camPos.y;
				const oz = other.position.z - camPos.z;
				const dist = Math.sqrt(ox * ox + oy * oy + oz * oz);
				// Only spheres meaningfully closer than the target can occlude it
				if (dist >= nodeDist - 12) { continue; }
				// Behind the camera never occludes
				const toward = (ox * dirX + oy * dirY + oz * dirZ) / dist;
				if (toward <= 0) { continue; }
				// Angular radius of a sphere (diameter ~16) at that distance
				const threshold = Math.cos(Math.atan(16 / dist));
				if (toward > threshold) {
					const blocked = false;
					return blocked;
				}
			}
			const clear = true;
			return clear;
		}

		// Distance from a camera position to the closest sphere OTHER
		// than the focused one — used to prefer views where the
		// selected element is also the nearest, so its caption reads
		// as the biggest in frame
		nearestOtherDistance(camPos, focusedMesh) {
			let nearest = Infinity;
			for (const other of this.nodeMeshes.values()) {
				if (other === focusedMesh) { continue; }
				const ox = other.position.x - camPos.x;
				const oy = other.position.y - camPos.y;
				const oz = other.position.z - camPos.z;
				const dist = Math.sqrt(ox * ox + oy * oy + oz * oz);
				if (dist < nearest) {
					nearest = dist;
				}
			}
			return nearest;
		}

		// Rotate the view around world Y in 20° steps until the focused
		// node is unoccluded; falls back to the original angles with a
		// warning when nothing clears (dense ball of nodes).
		// Two passes, caption rule: the biggest caption in
		// frame should belong to the selected element, so pass 1 only
		// accepts angles where the focused sphere is ALSO the nearest
		// one to the camera; pass 2 falls back to merely unoccluded
		// (dense branches where a child legitimately sits closer)
		pickClearView(rotX, rotY, zoom, nodePos, focusedMesh) {
			const steps = [0, 20, -20, 40, -40, 60, -60, 80, -80, 100, -100, 120, -120, 140, -140, 160, -160, 180];
			const base = this.viewFromAngles(rotX, rotY);
			for (const preferClosest of [true, false]) {
				for (const stepDeg of steps) {
					const step = stepDeg * Math.PI / 180;
					const cosS = Math.cos(step);
					const sinS = Math.sin(step);
					const viewX = base.x * cosS + base.z * sinS;
					const viewZ = -base.x * sinS + base.z * cosS;
					const viewY = base.y;
					const candRotX = Math.asin(Math.max(-1, Math.min(1, -viewY)));
					const candRotY = Math.atan2(-viewX, -viewZ);
					if (!this.isViewClear(candRotX, candRotY, zoom, nodePos, focusedMesh)) { continue; }
					if (preferClosest) {
						const camPos = {
							x : nodePos.x - viewX * zoom,
							y : nodePos.y - viewY * zoom,
							z : nodePos.z - viewZ * zoom
						};
						const nearest = this.nearestOtherDistance(camPos, focusedMesh);
						if (nearest < zoom - 12) { continue; }
					}
					const result = { rotX: candRotX, rotY: candRotY };
					return result;
				}
			}
			debugLog('[focusNode] no occlusion-free angle found, keeping base view', 'warn');
			const fallback = { rotX, rotY };
			return fallback;
		}

		updateHover(event) {
			const rect = this.renderer.domElement.getBoundingClientRect();
			this.mouseVector.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
			this.mouseVector.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

			this.raycaster.setFromCamera(this.mouseVector, this.camera);
			const intersects = this.raycaster.intersectObjects(this.interactive);

			// Reset all emissive to each element's build-time base (except
			// the focused node — its pulse is driven by updateFocusPulse)
			this.interactive.forEach(mesh => {
				if (mesh === this.focusedMesh) return;
				const material = mesh.material;
				if (!material || material.emissiveIntensity === undefined) { return; }
				material.emissiveIntensity = mesh.userData.baseEmissive || 0;
			});

			// Highlight hovered only (no tooltip)
			const hoverHit = firstVisibleIntersect(intersects);
			if (hoverHit) {
				const mesh = hoverHit.object;
				mesh.material.emissiveIntensity = 0.5;
				this.container.style.cursor = 'pointer';
			} else {
				this.container.style.cursor = 'default';
			}
			// The emissive reset loop + hover highlight mutate materials
			this.needsRender = true;
		}

		handleNodeClick3D(event, node) {
			if (ANONYMIZE) { return; } // no names, no tooltips — shapes only
			if (!node) return;

			// Single click - show/hide tooltip
			const tooltip = d3.select('#tooltip');
			const existingNodeId = tooltip.attr('data-node-id');
			if (tooltip.classed('visible') && existingNodeId === node.id) {
				tooltip.classed('visible', false);
			} else {
				const props = (node.properties || [])
					.map(p => p.name + ': ' + p.type)
					.join('<br>');
				const edsEntries = node.edsEntries || [];
				const edsRows = edsEntries.map((e, i) => {
					const site = e.parsedLocation;
					const siteHint = site ? ' ' + fileBaseName(site.fileName) + ':' + site.line : '';
					const scopeHint = e.scope ? ' [' + (e.scope === 'unknown' ? 'module' : e.scope) + ']' : '';
					return '<span class="eds-entry" data-eds-index="' + i + '" style="cursor:pointer;text-decoration:underline">' +
						e.kind + siteHint + scopeHint + '</span>';
				}).join('<br>');
				tooltip
					.attr('data-node-id', node.id)
					.classed('visible', true)
					.html('<strong>' + node.name + '</strong><br>' +
						'<em>depth: ' + node.depth + '</em><br>' +
						(props ? '<hr>' + props : '') +
						(edsRows ? '<hr>' + edsRows : ''))
					.style('left', (event.pageX + 10) + 'px')
					.style('top', (event.pageY - 10) + 'px');

				// Jump to the EDS (wrap/consume/hook) site on entry click
				tooltip.selectAll('.eds-entry').on('click', (event) => {
					event.stopPropagation();
					const entry = edsEntries[+event.currentTarget.getAttribute('data-eds-index')];
					if (entry && entry.parsedLocation) {
						d3.select('#tooltip').classed('visible', false);
						vscode.postMessage({
							command: 'goToDefinition',
							data: entry.parsedLocation
						});
					}
				});
			}
		}

		// Jump to the code behind a picked element (double-click, the XR
		// A/X button): spheres to their define(), diamonds to their
		// scope, bagels to the wrap call site; knots cite sources outside
		// the workspace — no jump there
		openMeshSource(mesh) {
			const node = mesh.userData.node;
			if (node) {
				this.handleNodeDoubleClick3D(node);
				return;
			}
			if (ANONYMIZE) { return; }
			const jumpNode = mesh.userData.creationNode || mesh.userData.wrapperNode;
			if (jumpNode && jumpNode.location && vscodeRef) {
				vscodeRef.postMessage({
					command : 'goToDefinition',
					data    : jumpNode.location
				});
			}
		}

		handleNodeDoubleClick3D(node, _event) {
			if (ANONYMIZE) { return; } // no jump targets in a shapes-only page
			// Double click - jump to definition
			if ((node.location || node.definitionLocation) && this.onNodeClick) {
				this.onNodeClick(node);
			}
		}

		/**
		 * Tooltip for a creation-layer diamond: what scope it is, where it
		 * lives, which types it creates. The location row jumps to code —
		 * the same goToDefinition message the sphere EDS entries use
		 */
		handleCreationClick(event, node) {
			if (ANONYMIZE) { return; } // shapes only — no scope names, no sites
			const tooltip = d3.select('#tooltip');
			const existingId = tooltip.attr('data-node-id');
			if (tooltip.classed('visible') && existingId === node.id) {
				tooltip.classed('visible', false);
				return;
			}
			const site = node.location;
			const siteText = site ? fileBaseName(site.fileName) + ':' + site.line + ':' + site.column : '';
			const siteRow = site
				? '<span class="jump-entry" style="cursor:pointer;text-decoration:underline">' + siteText + '</span>'
				: '';
			const createsRows = (node.creates || [])
				.map(c => c.typePath.split('.').pop())
				.join(', ');
			tooltip
				.attr('data-node-id', node.id)
				.classed('visible', true)
				.html('<strong>' + node.name + '</strong><br>' +
					'<em>' + node.kind + (node.starter ? ' · starter' : '') + '</em><br>' +
					(siteRow ? 'site: ' + siteRow + '<br>' : '') +
					(createsRows ? '<hr>creates: ' + createsRows : ''))
				.style('left', (event.pageX + 10) + 'px')
				.style('top', (event.pageY - 10) + 'px');
			if (site) {
				tooltip.selectAll('.jump-entry').on('click', (ev) => {
					ev.stopPropagation();
					d3.select('#tooltip').classed('visible', false);
					vscode.postMessage({ command: 'goToDefinition', data: site });
				});
			}
		}

		/**
		 * Tooltip for a wrapper bagel: what it wraps, where the wrap call
		 * site is, how it joins the graph. Joinless bagels are honest:
		 * terminal fibers with no wrapped descendants recorded
		 */
		handleWrapperClick(event, node) {
			if (ANONYMIZE) { return; } // shapes only — no wrap sites, no types
			const tooltip = d3.select('#tooltip');
			const existingId = tooltip.attr('data-node-id');
			if (tooltip.classed('visible') && existingId === node.id) {
				tooltip.classed('visible', false);
				return;
			}
			const site = node.location;
			const siteText = site ? fileBaseName(site.fileName) + ':' + site.line + ':' + site.column : '';
			const siteRow = site
				? '<span class="jump-entry" style="cursor:pointer;text-decoration:underline">' + siteText + '</span>'
				: '';
			const relations = [];
			if (node.wrapsTypePath) { relations.push('wraps: ' + node.wrapsTypePath); }
			if (node.hostTypePath) { relations.push('produced by: ' + node.hostTypePath); }
			if (node.callbackScopeId || node.holderScopeId) {
				const scopeName = fileBaseName(node.callbackScopeId || node.holderScopeId);
				relations.push('scope: ' + scopeName);
			}
			if (relations.length === 0) {
				relations.push('<em>ambient — no instance carried; terminal fiber, no wrapped descendants</em>');
			}
			tooltip
				.attr('data-node-id', node.id)
				.classed('visible', true)
				.html('<strong>' + node.name + '</strong><br>' +
					'<em>wrap · generation ' + node.generation + '</em><br>' +
					(siteRow ? 'site: ' + siteRow : '') +
					'<hr>' + relations.join('<br>'))
				.style('left', (event.pageX + 10) + 'px')
				.style('top', (event.pageY - 10) + 'px');
			if (site) {
				tooltip.selectAll('.jump-entry').on('click', (ev) => {
					ev.stopPropagation();
					d3.select('#tooltip').classed('visible', false);
					vscode.postMessage({ command: 'goToDefinition', data: site });
				});
			}
		}

		/**
		 * Tooltip for an internals knot: name, role, and the source it
		 * mirrors. No jump — the citation lives in a sibling package,
		 * outside the analyzed workspace
		 */
		handleInternalClick(event, knot) {
			if (ANONYMIZE) { return; } // shapes only — no knot names/citations
			const tooltip = d3.select('#tooltip');
			const existingId = tooltip.attr('data-node-id');
			if (tooltip.classed('visible') && existingId === knot.id) {
				tooltip.classed('visible', false);
				return;
			}
			tooltip
				.attr('data-node-id', knot.id)
				.classed('visible', true)
				.html('<strong>' + knot.name + '</strong><br>' +
					'<em>' + knot.role + '</em>' +
					(knot.citation ? '<br><em>mirrors: ' + knot.citation + '</em>' : ''))
				.style('left', (event.pageX + 10) + 'px')
				.style('top', (event.pageY - 10) + 'px');
		}

		/**
		 * 3D Layout with human-readable spacing
		 * 
		 * 1. Root spacing based on actual label widths (char count × avg char width)
		 * 2. Generation gaps are smaller and more consistent
		 * 3. Center marker at origin
		 */
		renderGraph(data, onDone) {
			// onDone (optional) fires when the progressive build queue
			// drains — saved pins, the fresh-camera fit and pending
			// focus ride it, since their meshes must exist
			// Snapshot user-placed elements BEFORE clear() disposes them,
			// so a knob-driven relayout restores CURRENT positions instead
			// of the initial layout (increase/decrease must look at current
			// positions, not initial render positions). Spheres ride
			// node.x3d (the drag writes it); non-sphere pins ride this
			// map, keyed by node id
			const pinnedSnapshot = new Map();
			const snapMesh = (mesh, key) => {
				if (!key || !mesh.userData.pinned) { return; }
				pinnedSnapshot.set(key, {
					hasAnchor : !!mesh.userData.pinAnchor,
					offset    : mesh.userData.pinOffset
						? { x: mesh.userData.pinOffset.x, y: mesh.userData.pinOffset.y, z: mesh.userData.pinOffset.z }
						: null,
					position  : { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z }
				});
			};
			this.creationMeshes.forEach(m => snapMesh(m, m.userData.creationNode && m.userData.creationNode.id));
			this.wrapperMeshes.forEach(m => snapMesh(m, m.userData.wrapperNode && m.userData.wrapperNode.id));
			this.internalsMeshes.forEach(m => snapMesh(m, m.userData.internalNode && m.userData.internalNode.id));

			// Layer visibility survives the rebuild: the checkboxes flip
			// .visible on the LIVE groups, and clear() disposes them — a
			// fresh Group defaults to visible, so a knob-driven rebuild
			// would silently re-show every layer the user had hidden.
			// Snapshot before clear(), re-apply to the fresh groups below
			const layerVisibility = {
				types           : this.typesGroup ? this.typesGroup.visible : true,
				instrumentation : this.instrumentationGroup ? this.instrumentationGroup.visible : true,
				dive            : this.diveGroup ? this.diveGroup.visible : true
			};

			this.clear();

			// Layer groups — the "Layers" checkboxes flip their
			// .visible; one scene, one camera, all rotate together.
			// Wrappers + dive internals + adapter sinks share the single
			// diveGroup — the combined Dive graph
			this.typesGroup = new THREE.Group();
			this.instrumentationGroup = new THREE.Group();
			this.diveGroup = new THREE.Group();
			this.typesGroup.visible = layerVisibility.types;
			this.instrumentationGroup.visible = layerVisibility.instrumentation;
			this.diveGroup.visible = layerVisibility.dive;
			this.graphRoot.add(this.typesGroup);
			this.graphRoot.add(this.instrumentationGroup);
			this.graphRoot.add(this.diveGroup);

			// Restore 3D coordinates if they exist
			data.nodes.forEach(node => {
				if (node.x3d !== undefined && node.y3d !== undefined) {
					node.x = node.x3d;
					node.y = node.y3d;
					node.z = node.z3d || 0;
				}
			});

			const colors = [
				0x4e79a7, 0xf28e2c, 0xe15759, 0x76b7b2, 0x59a14f,
				0xedc949, 0xaf7aa1, 0xff9da7, 0x9c755f, 0xbab0ab
			];

			// Build node lookup and parent-child relationships
			const nodeMap = new Map();
			data.nodes.forEach(node => {
				nodeMap.set(node.id, node);
				node.children = [];
			});

			// Build tree structure from links and resolve references
			const rootNodes = [];
			data.links.forEach(link => {
				const source = typeof link.source === 'object' ? link.source : nodeMap.get(link.source);
				const target = typeof link.target === 'object' ? link.target : nodeMap.get(link.target);
				if (source && target) {
					// Update link to use node objects
					link.source = source;
					link.target = target;
					source.children.push(target);
					target.parent = source;
				}
			});

			// Find root nodes (no parent)
			data.nodes.forEach(node => {
				if (!node.parent) {
					rootNodes.push(node);
				}
			});

			// Group nodes by depth
			const nodesByDepth = new Map();
			data.nodes.forEach(node => {
				const depth = node.depth || 0;
				if (!nodesByDepth.has(depth)) {
					nodesByDepth.set(depth, []);
				}
				nodesByDepth.get(depth).push(node);
			});

			// Configuration - TRUE 3D SPHERICAL LAYOUT
			const nodeRadius = 8;

			// Labels alternate above/below their sphere, so two screen rows
			// share one shell's circumference; the margin keeps leader
			// lines clear of neighbouring signs
			const LABEL_ROWS = 2;
			const LABEL_MARGIN = 1.15;

			// Label metrics are the layout's spacing source: measured text
			// widths (the label font at its 25-world-unit height) drive the
			// shells' circumference rule, the sibling cone caps, sprite
			// sizing in addLabel, and relaxation collision radii — one
			// measurement, every spacing decision
			const labelMetrics = measureLabelWidths(data.nodes);
			this.labelMetrics = labelMetrics;

			/**
			 * TRUE 3D SPHERICAL LAYOUT
			 * Each generation forms a complete spherical shell
			 * INCREASED distances for better visibility
			 */
			// Use instance depthRadii if available (for adjustments), otherwise use defaults
			// User preference: root ~105px (90-120 range), gen1 ~180px, gen2 ~245px, +65px each
			const maxDepth = Math.max(...data.nodes.map(n => n.depth || 0));
			if (!this.depthRadii) {
				const radii = get3D_Radii(maxDepth).map((r, i) => {
					// Data-driven widening: a crowded shell needs the
					// circumference to fit its nodes — spheres claim
					// 4.4 nodeRadii each (the relaxation collision rule),
					// labels claim their MEASURED width split across the
					// two alternating label rows; whichever is larger wins.
					// Runs only at init — the Generation Distances rows own
					// the values afterwards
					const shellNodes = nodesByDepth.get(i) || [];
					const sphereArc = shellNodes.length * nodeRadius * 4.4;
					const labelArc = shellNodes.reduce(
						(sum, n) => sum + (labelMetrics.get(n.name) || 0), 0
					) / LABEL_ROWS * LABEL_MARGIN;
					const needed = Math.max(sphereArc, labelArc) / (2 * Math.PI);
					const widened = Math.max(r, needed);
					return widened;
				});
				// A seeded radius (the wheel's values, from the session
				// hand-off or the saved layout) wins over the formula;
				// depths the seed never knew — a deeper graph since —
				// keep the formula value. The ordering pass below
				// repairs any crossing the seed introduces
				if (this.seededGenRadii) {
					for (let i = 0; i < radii.length; i++) {
						const seeded = this.seededGenRadii.get(i);
						if (typeof seeded === 'number' && seeded > 0) { radii[i] = seeded; }
					}
				}
				// Keep shells strictly ordered after widening
				for (let i = 1; i < radii.length; i++) {
					if (radii[i] < radii[i - 1] + 40) { radii[i] = radii[i - 1] + 40; }
				}
				this.depthRadii = new Map(radii.map((r, i) => [i, r]));
			}
			const depthRadii = this.depthRadii;

			/**
			 * Measure label texts once, at the label's own font: canvas px
			 * converted to world units (25 world units per 256 canvas px,
			 * addLabel's sprite height) plus the stroke's padding. Keyed by
			 * text — duplicate names measure identically anyway
			 */
			function measureLabelWidths(nodes) {
				const canvas = document.createElement('canvas');
				const ctx = canvas.getContext('2d');
				const WORLD_PER_PX = 25 / 256;
				const PADDING_PX = 36;
				ctx.font = 'bold 64px Arial, sans-serif';
				const metrics = new Map();
				nodes.forEach(node => {
					if (metrics.has(node.name)) { return; }
					const px = ctx.measureText(node.name).width + PADDING_PX;
					metrics.set(node.name, px * WORLD_PER_PX);
				});
				return metrics;
			}

			/**
			 * Distribute points evenly on a sphere surface
			 * Uses Fibonacci sphere algorithm for uniform distribution
			 */
			function placeOnSphere(radius, index, total) {
				if (total === 1) {
					return { x: radius, y: 0, z: 0 };
				}

				// Golden angle for uniform distribution
				const goldenAngle = Math.PI * (3 - Math.sqrt(5));

				// y goes from 1 to -1 (top to bottom of sphere)
				const y = 1 - (index / (total - 1)) * 2;
				const radiusAtY = Math.sqrt(1 - y * y);
				const theta = goldenAngle * index;

				return {
					x: radius * radiusAtY * Math.cos(theta),
					y: radius * y,
					z: radius * radiusAtY * Math.sin(theta)
				};
			}

			/**
			 * Place children in cone from parent direction
			 */
			function placeInCone(parentPos, childIndex, childCount, radius, maxAngle) {
				const parentR = Math.sqrt(parentPos.x ** 2 + parentPos.y ** 2 + parentPos.z ** 2);

				if (parentR < 0.001) {
					// Parent at center - distribute evenly on sphere
					return placeOnSphere(radius, childIndex, childCount);
				}

				// Parent direction
				const px = parentPos.x / parentR;
				const py = parentPos.y / parentR;
				const pz = parentPos.z / parentR;

				// Uniform-area sampling of the cap: sqrt annuli give every
				// sibling the same area, the golden angle keeps successive
				// siblings off each other's radial line
				const goldenAngle = Math.PI * (3 - Math.sqrt(5));
				const deviation = maxAngle * Math.sqrt((childIndex + 0.5) / childCount);
				const theta = childIndex * goldenAngle;

				// Orthonormal basis
				let ux, uy, uz;
				if (Math.abs(px) < 0.9) {
					ux = 0; uy = -pz; uz = py;
				} else {
					ux = -pz; uy = 0; uz = px;
				}
				const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz);
				ux /= ulen; uy /= ulen; uz /= ulen;

				const vx = py * uz - pz * uy;
				const vy = pz * ux - px * uz;
				const vz = px * uy - py * ux;

				// Direction
				const cosD = Math.cos(deviation);
				const sinD = Math.sin(deviation);
				const cosT = Math.cos(theta);
				const sinT = Math.sin(theta);

				const dx = cosD * px + sinD * (cosT * ux + sinT * vx);
				const dy = cosD * py + sinD * (cosT * uy + sinT * vy);
				const dz = cosD * pz + sinD * (cosT * uz + sinT * vz);

				return {
					x: radius * dx,
					y: radius * dy,
					z: radius * dz
				};
			}

			/**
			 * Calculate 3D position
			 * Uses saved x3d/y3d/z3d if available, otherwise calculates.
			 * x3d is ALSO the user-placed marker: the sphere drag writes
			 * it, so dragged spheres survive knob-driven relayouts
			 */
			function calculatePosition(node, depth, index, totalAtDepth) {
				// Check if we have saved 3D coordinates - use them!
				// (mode-switch restore, or a user-dragged sphere)
				if (node.x3d !== undefined && node.y3d !== undefined && node.z3d !== undefined) {
					return { x: node.x3d, y: node.y3d, z: node.z3d };
				}

				const radius = depthRadii.get(depth) || (105 + depth * 75);

				// ROOTS: distributed on sphere surface (not just a circle!)
				if (depth === 0) {
					return placeOnSphere(radius, index, totalAtDepth);
				}

				// CHILDREN: cone from parent
				if (!node.parent || node.parent.x === undefined) {
					return placeOnSphere(radius, index, totalAtDepth);
				}

				const siblings = node.parent.children;
				const siblingIndex = siblings.indexOf(node);
				const siblingCount = siblings.length;

				// The cap must give every sibling its measured claim — the
				// same sphere/label footprint the shell rule uses: a fixed
				// small angle piles a wide sibling group into a wedge
				// relaxation cannot finish spreading, so the angle grows
				// with the sibling count and shrinks on wider shells
				const spacing = siblings.reduce(
					(sum, sib) => sum + Math.max(nodeRadius * 4.4, labelMetrics.get(sib.name) || 0),
					0
				) / siblingCount;
				const capChord = Math.sqrt(siblingCount) * spacing;
				const maxAngle = Math.asin(Math.min(1, capChord / (2 * radius)));

				return placeInCone(node.parent, siblingIndex, siblingCount, radius, maxAngle);
			}

			// Add center marker sphere at origin (0,0,0) — the types
			// graph's orientation anchor, labeled with the collection
			// name. The creation layer's own center (a gold diamond)
			// sits tangent to this sphere's right side — both graphs
			// keep their centers, side by side
			const centerGeometry = new THREE.SphereGeometry(nodeRadius * 0.5, 16, 16);
			const centerMaterial = new THREE.MeshPhongMaterial({
				color: 0x800000, // Maroon
				emissive: 0x400000,
				emissiveIntensity: 0.5
			});
			const centerSphere = new THREE.Mesh(centerGeometry, centerMaterial);
			centerSphere.position.set(0, 0, 0);
			this.centerMarker = centerSphere;
			this.graphRoot.add(centerSphere);
			// The shown collection's display name: the collections.json
			// name when the manifest exists, else the raw id
			// ('defaultTypes' for the default universe). The combined
			// all-collections view gets no label — the marker is the
			// shared orientation anchor, not a collection's badge.
			// Anonymised exports get no badge either: a collection name
			// is a name
			if (data.collection !== ALL_COLLECTIONS && !ANONYMIZE) {
				const collectionsInventory = Array.isArray(data.collections) ? data.collections : [];
				const shownCollection = collectionsInventory.find(function (c) { return c.id === data.collection; });
				const centerLabel = (shownCollection && shownCollection.name) || data.collection || 'defaultTypes';
				this.addLabel(centerSphere, centerLabel, 0.6);
			}
			if (centerSphere.userData.label) {
				this.typesGroup.add(centerSphere.userData.label);
				this.typesGroup.add(centerSphere.userData.leader);
			}
			this.updateCenterMarkerVisibility();

			// Progressive build queue: the heavy construction below runs
			// in time-budgeted rAF ticks — the center marker is already
			// on screen, spheres grow center-out generation by
			// generation, edges and the other layers follow, and the
			// user WATCHES the graph assemble instead of staring at a
			// blank panel. Each unit is { step, done }; the scheduler at
			// the bottom runs steps until the ~12ms frame budget, then
			// yields. A newer renderGraph invalidates the queue via
			// buildToken; dispose() cancels the pending tick
			this.buildToken = (this.buildToken || 0) + 1;
			const buildToken = this.buildToken;
			const buildQueue = [];
			const once = (fn) => {
				let fired = false;
				return {
					done : () => fired,
					step : () => { fired = true; fn(); }
				};
			};

			// Depth-ordered node list — parents build BEFORE children
			// (placeInCone reads the parent's live position); center-out
			// is also the visible growth story
			const orderedNodes = [];
			Array.from(nodesByDepth.keys()).sort((a, b) => a - b).forEach(depth => {
				const nodesAtDepth = nodesByDepth.get(depth);
				nodesAtDepth.forEach((node, index) => {
					orderedNodes.push({ node, depth, index, total: nodesAtDepth.length });
				});
			});

			// Create node meshes — one sphere per type node, a few per
			// frame. Positions compute AT BUILD TIME (calculatePosition
			// reads depthRadii and the parent's live seat), so a
			// mid-build radius change still seats unbuilt shells
			// correctly
			const sphereGeometry = new THREE.SphereGeometry(nodeRadius, 32, 32);
			const createNodeMesh = (node) => {
				const color = colors[node.depth % colors.length];
				const material = new THREE.MeshPhongMaterial({
					color: color,
					shininess: 100,
					specular: 0x111111
				});

				if (node.isRoot) {
					material.emissive = new THREE.Color(0x8B0000);
					material.emissiveIntensity = 0.3;
				}

				// Diagnostic: no instantiation in usages.json — the type
				// never happens at runtime (the EdsProbe case); dim the
				// sphere. Its outgoing path-hits are never-taken too
				if (node.neverCreated) {
					material.transparent = true;
					material.opacity = 0.35;
				}

				const mesh = new THREE.Mesh(sphereGeometry, material);
				mesh.position.set(node.x, node.y, node.z);
				mesh.userData = { node, baseEmissive: node.isRoot ? 0.3 : 0 };
				// Computed visibility: the sphere answers its generation's
				// flag through a getter — a checkbox flip needs no loop
				// and no rebuild; edges/labels/wraps read this .visible
				// and compose it further
				defineComputedVisible(mesh, () => genDepthVisible(node.depth || 0));

				this.addLabel(mesh, node.name);

				// addLabel attaches the sprite to the scene — re-parent it
				// into the layer group so the toggle hides labels too
				if (mesh.userData.label) {
					this.typesGroup.add(mesh.userData.label);
					this.typesGroup.add(mesh.userData.leader);
				}
				this.typesGroup.add(mesh);
				this.nodeMeshes.set(node.id, mesh);
			};

			// Unit 1: type spheres + labels, center-out, a few per frame
			let nodeCursor = 0;
			buildQueue.push({
				done : () => nodeCursor >= orderedNodes.length,
				step : () => {
					const entry = orderedNodes[nodeCursor++];
					const node = entry.node;
					const pos = calculatePosition(node, entry.depth, entry.index, entry.total);
					node.x = pos.x;
					node.y = pos.y;
					node.z = pos.z;
					node.fx = node.x;
					node.fy = node.y;
					node.fz = node.z;
					createNodeMesh(node);
				}
			});

			// Create link lines - more visible
			const lineMaterial = new THREE.LineBasicMaterial({
				color: 0xaaaaaa,
				transparent: true,
				opacity: 0.8,
				linewidth: 2
			});

			// Arrow geometry for directional indicators
			const arrowGeometry = new THREE.ConeGeometry(3, 8, 8);
			arrowGeometry.rotateX(Math.PI / 2); // Point along Z axis initially
			const arrowMaterial = new THREE.MeshBasicMaterial({ color: 0xaaaaaa });

			const createLinkLine = (link) => {
				const geometry = new THREE.BufferGeometry();
				const positions = new Float32Array([0, 0, 0, 0, 0, 0]);
				geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
				const line = new THREE.Line(geometry, lineMaterial);
				this.typesGroup.add(line);

				// Add arrowhead
				const arrow = new THREE.Mesh(arrowGeometry, arrowMaterial);
				this.typesGroup.add(arrow);

				// An inheritance edge shows only when BOTH endpoint
				// generations do. Endpoints are resolved node objects by
				// now — except unresolved ids, which stay strings: those
				// read as visible here and stay zero-length (the updater
				// never writes them)
				const endpointsVisible = () => {
					const s = link.source;
					const t = link.target;
					const sOk = !s || typeof s !== 'object' || genDepthVisible(s.depth || 0);
					const tOk = !t || typeof t !== 'object' || genDepthVisible(t.depth || 0);
					return sOk && tOk;
				};
				defineComputedVisible(line, endpointsVisible);
				defineComputedVisible(arrow, endpointsVisible);

				this.linkLines.push({ line, arrow, link });
			};

			// Unit 2: inheritance edges, a few per frame
			let linkCursor = 0;
			buildQueue.push({
				done : () => linkCursor >= data.links.length,
				step : () => {
					createLinkLine(data.links[linkCursor++]);
				}
			});

			// EDS path-hit edges (createsTypes): guaranteed runtime paths from
			// a wrapped scope to the types it constructs. Thin cyan lines with
			// small arrowheads — wrap scope → constructed type. Never-taken
			// hits (the SOURCE type has no instantiation in usages.json — the
			// EdsProbe diagnostic) ride a dimmer material
			this.nodeRadius3d = nodeRadius;
			const pathHitMaterial = new THREE.LineBasicMaterial({
				color: 0x66ccff,
				transparent: true,
				opacity: 0.5
			});
			const pathHitNeverMaterial = new THREE.LineBasicMaterial({
				color: 0x66ccff,
				transparent: true,
				opacity: 0.12
			});
			const pathHitArrowGeometry = new THREE.ConeGeometry(1.8, 5, 8);
			pathHitArrowGeometry.rotateX(Math.PI / 2); // tip along +Z
			const pathHitArrowMaterial = new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.6 });
			const pathHitEdges = (data.execflow || []).filter(edge => edge.kind === 'edsPathHit');
			const createPathHit = (edge) => {
				const source = nodeMap.get(edge.source);
				const target = nodeMap.get(edge.target);
				if (!source || !target) return;
				const geometry = new THREE.BufferGeometry();
				const positions = new Float32Array([0, 0, 0, 0, 0, 0]);
				geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
				const line = new THREE.Line(geometry, edge.neverTaken ? pathHitNeverMaterial : pathHitMaterial);
				const arrow = new THREE.Mesh(pathHitArrowGeometry, pathHitArrowMaterial);
				this.typesGroup.add(line);
				this.typesGroup.add(arrow);
				// Path-hits hide with either endpoint's generation —
				// source/target are guaranteed node objects by the guard
				// above
				const hitVisible = () => genDepthVisible(source.depth || 0) && genDepthVisible(target.depth || 0);
				defineComputedVisible(line, hitVisible);
				defineComputedVisible(arrow, hitVisible);
				this.pathHitLines.push({ line, arrow, source, target });
			};

			// Unit 3: path-hit edges
			let hitCursor = 0;
			buildQueue.push({
				done : () => hitCursor >= pathHitEdges.length,
				step : () => {
					createPathHit(pathHitEdges[hitCursor++]);
				}
			});

			// Units 4-6: the other layers, one unit each — their internal
			// loops stay monolithic for now, so the visible progress
			// story here is layer by layer. Creation graph layer
			// (instrumentation.json v2): call chains from entry points to
			// `new` sites — diamonds for the knot scopes that create
			// types, on hidden shells around the created type's sphere
			buildQueue.push(once(() => this.buildCreationLayer(data, nodeMap, placeOnSphere, nodeRadius)));

			// Wrappers graph layer (eds.json wrap entries): dive wrap
			// sites as rings, DIRECTED fiber edges between them, joined to
			// the creation diamonds whose scopes they wrap and to the type
			// spheres they wrap.
			// Builds AFTER the creation layer — ring positions hang off
			// live creation meshes
			buildQueue.push(once(() => this.buildWrappersLayer(data, nodeMap, placeOnSphere, nodeRadius)));

			// Combined Dive backplane (declared ring/hub/sinks, attachHooks
			// grafts): builds AFTER wrappers — graft endpoints hang off live
			// type spheres, so it needs the nodeMap
			buildQueue.push(once(() => this.buildInternalsLayer(data, nodeMap, nodeRadius)));

			// The final unit: pins restore, shell relax, the interactive
			// set, the first full dynamics pass — then the caller's
			// onDone (saved pins, camera fit, pending focus)
			const finalizeBuild = () => {
				// Restore the pins snapshotted before clear(): relative pins
				// re-resolve their (new) anchor mesh and keep their offset,
				// absolute pins land on their stored spot. The dynamics chain
				// below owns them from there
				const restoreMesh = (mesh, key) => {
					const snap = key ? pinnedSnapshot.get(key) : undefined;
					if (!snap) { return; }
					mesh.userData.pinned = true;
					if (snap.hasAnchor && snap.offset) {
						const anchor = this.resolvePinAnchor(mesh);
						if (anchor) {
							mesh.userData.pinAnchor = anchor;
							mesh.userData.pinOffset = new THREE.Vector3(snap.offset.x, snap.offset.y, snap.offset.z);
							mesh.position.copy(anchor.position).add(mesh.userData.pinOffset);
							return;
						}
					}
					mesh.position.set(snap.position.x, snap.position.y, snap.position.z);
				};
				this.creationMeshes.forEach(m => restoreMesh(m, m.userData.creationNode && m.userData.creationNode.id));
				this.wrapperMeshes.forEach(m => restoreMesh(m, m.userData.wrapperNode && m.userData.wrapperNode.id));
				this.internalsMeshes.forEach(m => restoreMesh(m, m.userData.internalNode && m.userData.internalNode.id));

				// Second layout step: deterministic shell-constrained
				// relaxation — spheres slide ON their shells until no two
				// effective discs overlap, then labels alternate above/below
				this.relaxTypeShells(data, nodeRadius);

				// Everything the pointer may grab or click. Rings/knots join
				// by their userData payload (arrows ride the same buckets for
				// disposal but carry none — filtered out). Rebuilt per render
				this.interactive = [
					...Array.from(this.nodeMeshes.values()),
					...this.creationMeshes.filter(m => m.userData.creationNode),
					...this.wrapperMeshes.filter(m => m.userData.wrapperNode),
					...this.internalsMeshes.filter(m => m.userData.internalNode)
				];

				// Update link positions
				this.updateLinkPositions();
			};
			buildQueue.push(once(() => {
				finalizeBuild();
				if (typeof onDone === 'function') { onDone(); }
			}));

			// The scheduler: time-budgeted ticks (~12ms) — spend the
			// frame budget on queue steps, flag the paint, yield to the
			// next frame. A stale token means a newer renderGraph owns
			// the scene now: the queue dies silently
			const runBuildQueue = () => {
				if (buildToken !== this.buildToken) { return; }
				const deadline = performance.now() + 12;
				while (buildQueue.length && performance.now() < deadline) {
					const head = buildQueue[0];
					if (head.done()) {
						buildQueue.shift();
						continue;
					}
					head.step();
					if (head.done()) { buildQueue.shift(); }
				}
				this.needsRender = true;
				if (buildQueue.length) {
					this.buildRafId = requestAnimationFrame(runBuildQueue);
				}
			};
			this.buildRafId = requestAnimationFrame(runBuildQueue);
		}

		/**
		 * Snapshot the pins of every non-sphere element (creation diamonds,
		 * wrapper bagels, internals knots), keyed by node id. The single
		 * snap shape collectLayout (Save button) and render3DGraph's
		 * rebuild hand-off both ride on
		 */
		snapshotPins() {
			const pins = {};
			const snapMesh = (mesh, key) => {
				if (!key || !mesh.userData.pinned) { return; }
				pins[key] = {
					hasAnchor : !!mesh.userData.pinAnchor,
					offset    : mesh.userData.pinOffset
						? { x: mesh.userData.pinOffset.x, y: mesh.userData.pinOffset.y, z: mesh.userData.pinOffset.z }
						: null,
					position  : { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z }
				};
			};
			this.creationMeshes.forEach(m => snapMesh(m, m.userData.creationNode && m.userData.creationNode.id));
			this.wrapperMeshes.forEach(m => snapMesh(m, m.userData.wrapperNode && m.userData.wrapperNode.id));
			this.internalsMeshes.forEach(m => snapMesh(m, m.userData.internalNode && m.userData.internalNode.id));
			return pins;
		}

		/**
		 * Collect the savable layout (Save button → host writes
		 * .mnemographica/layout.json). User-placed spheres only —
		 * untouched nodes reproduce from the deterministic layout anyway. Pins ride the same snap shape
		 * renderGraph's pinnedSnapshot uses, keyed by node id. Camera
		 * matches the constructor's initialCameraState shape
		 */
		collectLayout(data) {
			const nodes = {};
			data.nodes.forEach(node => {
				if (node.x3d === undefined) { return; }
				nodes[node.id] = { x: node.x3d, y: node.y3d, z: node.z3d };
			});
			const pins = this.snapshotPins();
			// The vector-sphere control's state: caption vector +
			// per-caption Shift-drag overrides + diamond/bagel/sink orients
			// — arrangement is more than positions
			const captionOverrides = {};
			this.labeledMeshes.forEach(mesh => {
				if (!mesh.userData.captionViewOffset) { return; }
				const key = this.captionOverrideKey(mesh);
				if (!key) { return; }
				const v = mesh.userData.captionViewOffset;
				captionOverrides[key] = { x: v.x, y: v.y, z: v.z };
			});
			const orient = {
				captions         : {
					x    : this.captionVector.x,
					y    : this.captionVector.y,
					z    : this.captionVector.z,
					dist : this.captionDist
				},
				captionOverrides : captionOverrides,
				diamonds         : this.diamondOrient
					? {
						dir   : { x: this.diamondOrient.dir.x, y: this.diamondOrient.dir.y, z: this.diamondOrient.dir.z },
						scale : this.diamondOrient.scale
					}
					: null,
				bagels           : this.bagelOrient
					? {
						dir  : { x: this.bagelOrient.dir.x, y: this.bagelOrient.dir.y, z: this.bagelOrient.dir.z },
						dist : this.bagelOrient.dist
					}
					: null,
				sinks            : this.sinkOrient
					? {
						dir  : { x: this.sinkOrient.dir.x, y: this.sinkOrient.dir.y, z: this.sinkOrient.dir.z },
						dist : this.sinkOrient.dist
					}
					: null
				// NO jaeger key: the cone rides the sinks orient —
				// nothing of its own to persist
			};
			const layout = {
				version : 1,
				savedAt : new Date().toISOString(),
				nodes   : nodes,
				pins    : pins,
				// The wheel-driven generation shell radii — distances
				// are arrangement too. Entries [[depth, radius], …],
				// overlaid on the formula defaults at the next open
				genRadii : this.depthRadii ? Array.from(this.depthRadii.entries()) : null,
				camera  : {
					// The quaternion is the exact orbit state; the
					// derived spherical angles ride along for the
					// Camera3D census (rotationX/rotationY) and for
					// legacy readers of older layout files
					orbitQuat      : {
						x : this.orbitQuat.x,
						y : this.orbitQuat.y,
						z : this.orbitQuat.z,
						w : this.orbitQuat.w
					},
					cameraRotation : orbitAnglesFromQuat(this.orbitQuat),
					zoom           : this.zoom,
					panOffset      : { ...this.panOffset }
				},
				orient  : orient
			};
			return layout;
		}

		/**
		 * Re-apply the saved pins after a fresh render — mirrors the
		 * pinnedSnapshot restoreMesh inside renderGraph: relative pins
		 * re-resolve their anchor mesh and keep the offset, absolute pins
		 * land on their stored spot. Ends with updateLinkPositions so the
		 * dynamics chain sees the restored spots
		 */
		applySavedPins(pins) {
			if (!pins) { return; }
			const applyMesh = (mesh, key) => {
				const snap = key ? pins[key] : undefined;
				if (!snap) { return; }
				mesh.userData.pinned = true;
				if (snap.hasAnchor && snap.offset) {
					const anchor = this.resolvePinAnchor(mesh);
					if (anchor) {
						mesh.userData.pinAnchor = anchor;
						mesh.userData.pinOffset = new THREE.Vector3(snap.offset.x, snap.offset.y, snap.offset.z);
						mesh.position.copy(anchor.position).add(mesh.userData.pinOffset);
						return;
					}
				}
				mesh.position.set(snap.position.x, snap.position.y, snap.position.z);
			};
			this.creationMeshes.forEach(m => applyMesh(m, m.userData.creationNode && m.userData.creationNode.id));
			this.wrapperMeshes.forEach(m => applyMesh(m, m.userData.wrapperNode && m.userData.wrapperNode.id));
			this.internalsMeshes.forEach(m => applyMesh(m, m.userData.internalNode && m.userData.internalNode.id));
			this.updateLinkPositions();
		}

		/**
		 * The session/save key a captioned mesh answers to: type spheres
		 * by node id (the typePath), the rest by their payload node id —
		 * mirrors snapshotPins keying
		 */
		captionOverrideKey(mesh) {
			const userData = mesh.userData;
			if (userData.node && userData.node.id) { return userData.node.id; }
			if (userData.creationNode && userData.creationNode.id) { return userData.creationNode.id; }
			if (userData.wrapperNode && userData.wrapperNode.id) { return userData.wrapperNode.id; }
			if (userData.internalNode && userData.internalNode.id) { return userData.internalNode.id; }
			return null;
		}

		/**
		 * Re-apply per-caption Shift-drag overrides after a fresh render —
		 * the VIEW-relative offsets land on the rebuilt meshes and the
		 * signs re-seat immediately
		 */
		applyCaptionOverrides(overrides) {
			if (!overrides) { return; }
			this.labeledMeshes.forEach(mesh => {
				const key = this.captionOverrideKey(mesh);
				const saved = key ? overrides[key] : undefined;
				if (!saved) { return; }
				mesh.userData.captionViewOffset = new THREE.Vector3(saved.x, saved.y, saved.z);
				this.updateLabelPosition(mesh);
			});
			this.needsRender = true;
		}

		/**
		 * Layout relaxation, the deterministic second step after initial
		 * placement: dense initial shells cross figures and labels.
		 * Type spheres repel SLIDING ON THEIR OWN SHELL — the radial
		 * distance (generation geometry) never changes, only the angular
		 * position. A sphere's effective radius grows with its holder
		 * crown (diamonds live at ×2.4 around it) so crowns stop
		 * colliding too. Fixed iteration order, fixed cap: same graph,
		 * same layout, every render. Ends by alternating label sides
		 * (even above, odd below) so neighbouring signs don't stack.
		 * Everything downstream (diamond shells, bagels, edges) follows
		 * through the dynamics chain in updateLinkPositions().
		 */
		relaxTypeShells(data, nodeRadius) {
			const meshes = Array.from(this.nodeMeshes.values());
			if (meshes.length < 2 || !this.depthRadii) { return; }

			// Holder crown sizes from the creation data (primary anchor
			// only — a diamond sits on its primary's shell)
			const crownByType = new Map();
			const creation = data.creation;
			if (creation && Array.isArray(creation.nodes)) {
				creation.nodes.forEach(n => {
					if (!Array.isArray(n.creates) || n.creates.length === 0) { return; }
					const primary = n.creates[0].typePath;
					crownByType.set(primary, (crownByType.get(primary) || 0) + 1);
				});
			}
			const effRadius = meshes.map(mesh => {
				const id = mesh.userData.node ? mesh.userData.node.id : '';
				const crown = crownByType.get(id) || 0;
				// Effective radii: crowded shells must stay readable at a
				// glance, not just non-overlapping — ×2.2 uncrowned,
				// ×(3.3 + min(crown,8)×0.15) crowned. The label's measured
				// half-width joins as a floor: labels, not spheres, are
				// what actually overlaps on a dense shell
				const labelHalf = (mesh.userData.node && this.labelMetrics)
					? (this.labelMetrics.get(mesh.userData.node.name) || 0) / 2
					: 0;
				const r = Math.max(
					crown > 0
						? nodeRadius * (3.3 + Math.min(crown, 8) * 0.15)
						: nodeRadius * 2.2,
					labelHalf
				);
				return r;
			});
			const shellRadius = meshes.map(mesh => {
				const depth = mesh.userData.node ? (mesh.userData.node.depth || 0) : 0;
				const r = this.depthRadii.get(depth) || mesh.position.length() || 1;
				return r;
			});

			// The cap only bounds pathological piles (dense crowns, pinned
			// anchors); sane seeds stop through EPSILON long before it
			const ITERATIONS = 400;
			const DAMPING = 0.4;
			const EPSILON = 0.05;
			for (let iter = 0; iter < ITERATIONS; iter++) {
				let maxPush = 0;
				for (let i = 0; i < meshes.length; i++) {
					for (let j = i + 1; j < meshes.length; j++) {
						const a = meshes[i].position;
						const b = meshes[j].position;
						const dx = b.x - a.x;
						const dy = b.y - a.y;
						const dz = b.z - a.z;
						const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
						const minD = effRadius[i] + effRadius[j];
						if (d >= minD || d < 1e-9) { continue; }
						const push = (minD - d) * DAMPING;
						const ux = dx / d;
						const uy = dy / d;
						const uz = dz / d;
						// Project the push onto each sphere's own tangent
						// plane (drop the radial component), apply, then
						// renormalize back to the shell radius
						[a, b].forEach((pos, k) => {
							const sign = k === 0 ? -1 : 1;
							const idx = k === 0 ? i : j;
							// User-placed spheres (dragged — x3d set)
							// anchor the layout: they repel neighbours
							// but never move themselves
							const nodeData = meshes[idx].userData.node;
							if (nodeData && nodeData.x3d !== undefined) { return; }
							let mx = sign * ux * push;
							let my = sign * uy * push;
							let mz = sign * uz * push;
							const len = pos.length() || 1;
							const rx = pos.x / len;
							const ry = pos.y / len;
							const rz = pos.z / len;
							const radialPart = mx * rx + my * ry + mz * rz;
							mx -= radialPart * rx;
							my -= radialPart * ry;
							mz -= radialPart * rz;
							pos.x += mx;
							pos.y += my;
							pos.z += mz;
							const newLen = pos.length() || 1;
							pos.multiplyScalar(shellRadius[idx] / newLen);
						});
						if (push > maxPush) { maxPush = push; }
					}
				}
				if (maxPush < EPSILON) { break; }
			}

			// Labels alternate above/below their sphere so neighbouring
			// signs don't stack; the leader lines keep attribution
			meshes.forEach((mesh, i) => {
				if (!mesh.userData.label) { return; }
				const scale = mesh.userData.labelScale || 1;
				mesh.userData.labelOffsetY = (i % 2 === 0 ? 1 : -1) * 35 * scale;
			});
		}

		updateLinkPositions() {
			// Catch-all invalidation: renderGraph, node drag, and the
			// gen-radius relayout all end up here
			this.needsRender = true;
			this.pathHitLines.forEach(({ line, arrow, source, target }) => {
				const positions = line.geometry.attributes.position.array;
				const sx = source.x || 0;
				const sy = source.y || 0;
				const sz = source.z || 0;
				const tx = target.x || 0;
				const ty = target.y || 0;
				const tz = target.z || 0;
				positions[0] = sx;
				positions[1] = sy;
				positions[2] = sz;
				positions[3] = tx;
				positions[4] = ty;
				positions[5] = tz;
				line.geometry.attributes.position.needsUpdate = true;
				// Arrowhead on the target sphere's surface — same ratio
				// trick as the skeleton arrows
				if (arrow) {
					const dx = tx - sx;
					const dy = ty - sy;
					const dz = tz - sz;
					const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
					const nodeRadius = this.nodeRadius3d || 12;
					if (len > nodeRadius) {
						const ratio = (len - nodeRadius) / len;
						arrow.position.set(sx + dx * ratio, sy + dy * ratio, sz + dz * ratio);
						arrow.lookAt(tx, ty, tz);
					}
				}
			});
			this.linkLines.forEach(({ line, arrow, link }) => {
				const positions = line.geometry.attributes.position.array;
				const source = typeof link.source === 'object' ? link.source : null;
				const target = typeof link.target === 'object' ? link.target : null;
				if (source && target) {
					const sx = source.x || 0;
					const sy = source.y || 0;
					const sz = source.z || 0;
					const tx = target.x || 0;
					const ty = target.y || 0;
					const tz = target.z || 0;

					positions[0] = sx;
					positions[1] = sy;
					positions[2] = sz;
					positions[3] = tx;
					positions[4] = ty;
					positions[5] = tz;
					line.geometry.attributes.position.needsUpdate = true;

					// Position arrow at target, pointing from source to target
					if (arrow) {
						// Position arrow slightly before target (to not overlap node)
						const dx = tx - sx;
						const dy = ty - sy;
						const dz = tz - sz;
						const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
						const nodeRadius = 12; // Approximate node radius

						if (len > nodeRadius) {
							// Position arrow before the target node
							const ratio = (len - nodeRadius) / len;
							const ax = sx + dx * ratio;
							const ay = sy + dy * ratio;
							const az = sz + dz * ratio;

							arrow.position.set(ax, ay, az);

							// Orient arrow to point from source to target
							arrow.lookAt(tx, ty, tz);
						}
					}
				}
			});
			// Creation-layer geometry follows type spheres when they move
			// (drag): holder tangents, mid-chain interpolations, and the
			// creation edge lines all recompute from live node coords
			this.creationDynamics.forEach(update => update());
			// Wrapper rings hang off creation meshes, so they update AFTER
			// the creation dynamics have produced fresh holder positions
			this.wrapperDynamics.forEach(update => update());
			// Hookup edges hang off bagel meshes — last in the chain
			this.internalsDynamics.forEach(update => update());
			// The selection tube reads the freshest positions, after every
			// writer — it rebuilds only when a chain sphere actually moved
			this.updateSelectionTube();
		}

		/**
		 * The creation-graph center node — the main.ts module starter (the
		 * "center sphere" of the creation paradigm), falling back to any
		 * module starter, then any starter, then the first node.
		 */
		findCreationCenter(creation) {
			if (!creation || !Array.isArray(creation.nodes) || creation.nodes.length === 0) {
				return null;
			}
			const nodes = creation.nodes;
			const starters = nodes.filter(n => n.starter);
			const result = starters.find(n => n.kind === 'module' && /\/main\.ts$/.test(n.filePath)) ||
				starters.find(n => n.kind === 'module') ||
				starters[0] ||
				nodes[0];
			return result;
		}

		/**
		 * The maroon collection marker belongs to the types layer: it is
		 * visible exactly when that layer is. The creation layer keeps
		 * its own center instead — a diamond tangent to the marker's
		 * right side.
		 */
		updateCenterMarkerVisibility() {
			if (!this.centerMarker) {
				return;
			}
			const visible = !this.typesGroup || this.typesGroup.visible;
			this.centerMarker.visible = visible;
			// The marker's caption obeys BOTH masters: the types layer
			// toggle and the global captions flag. That AND lives in the
			// caption's computed-visibility getter (this.captionsVisible
			// && mesh.visible) — nothing to assign here
		}

		/**
		 * Second-pass de-collision for the creation layer. The first pass
		 * maps (upstream starter, downstream holder, t) to a point, which
		 * is NOT injective: DI-symmetric chains — every feature module
		 * the same hop count from the same starter to the same shared
		 * holder — collapse onto identical coordinates, and
		 * placeOnSphere's index 0 is the north pole for ANY ring total,
		 * so same-ring starter/fallback groups stack there. This pass
		 * fans exact piles onto mini Fibonacci shells, then relaxes
		 * near-misses out to minSep.
		 * FIXED obstacles: the creation center, holder diamonds (their
		 * shell seats are semantic), the maroon collection marker, and
		 * every pinned mesh (user authority — a node being DRAGGED is
		 * pinned, so the crowd yields to the cursor, never the drag).
		 * Runs inside the creation dynamics writer so live re-seats
		 * (type-sphere drags) re-converge the same spread.
		 */
		decollideCreationLayer(centerId, holderRecords, nodeRadius) {
			const minSep = nodeRadius;
			const movable = [];
			const obstacles = [];
			this.creationMeshById.forEach((mesh, id) => {
				if (id === centerId || holderRecords.has(id) || mesh.userData.pinned) {
					obstacles.push(mesh);
					return;
				}
				movable.push(mesh);
			});
			if (this.centerMarker) {
				obstacles.push(this.centerMarker);
			}
			if (movable.length === 0) {
				return;
			}

			const goldenAngle = Math.PI * (3 - Math.sqrt(5));
			const cellOf = (v) => Math.floor(v / minSep);
			// Neighbor pairs within maxDist via a 27-cell stencil of a
			// uniform grid (cell = maxDist); cb(i, j, distSq), j > i
			const forEachNearPair = (meshes, maxDist, cb) => {
				const grid = new Map();
				meshes.forEach((mesh, i) => {
					const key = cellOf(mesh.position.x) + ',' + cellOf(mesh.position.y) + ',' + cellOf(mesh.position.z);
					if (!grid.has(key)) { grid.set(key, []); }
					grid.get(key).push(i);
				});
				const maxDistSq = maxDist * maxDist;
				meshes.forEach((mesh, i) => {
					const cx = cellOf(mesh.position.x);
					const cy = cellOf(mesh.position.y);
					const cz = cellOf(mesh.position.z);
					for (let dx = -1; dx <= 1; dx++) {
						for (let dy = -1; dy <= 1; dy++) {
							for (let dz = -1; dz <= 1; dz++) {
								const cell = grid.get((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz));
								if (!cell) { continue; }
								cell.forEach(j => {
									if (j <= i) { return; }
									const other = meshes[j];
									const ddx = other.position.x - mesh.position.x;
									const ddy = other.position.y - mesh.position.y;
									const ddz = other.position.z - mesh.position.z;
									const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
									if (distSq < maxDistSq) {
										cb(i, j, distSq);
									}
								});
							}
						}
					}
				});
			};

			let moved = false;

			// Pass 1 — fan EXACT piles: union-find over near-zero distances,
			// then spread each pile on a mini Fibonacci shell around its
			// centroid (relaxation alone has no push direction for a
			// perfectly symmetric pile)
			const eps = minSep * 0.02;
			const parent = movable.map((mesh, i) => i);
			const findRoot = (i) => {
				let root = i;
				while (parent[root] !== root) { root = parent[root]; }
				while (parent[i] !== root) {
					const next = parent[i];
					parent[i] = root;
					i = next;
				}
				return root;
			};
			forEachNearPair(movable, eps, (i, j) => {
				const ri = findRoot(i);
				const rj = findRoot(j);
				if (ri !== rj) { parent[ri] = rj; }
			});
			const piles = new Map();
			movable.forEach((mesh, i) => {
				const root = findRoot(i);
				if (!piles.has(root)) { piles.set(root, []); }
				piles.get(root).push(i);
			});
			piles.forEach(members => {
				if (members.length < 2) { return; }
				let cx = 0;
				let cy = 0;
				let cz = 0;
				members.forEach(i => {
					cx += movable[i].position.x;
					cy += movable[i].position.y;
					cz += movable[i].position.z;
				});
				cx /= members.length;
				cy /= members.length;
				cz /= members.length;
				const fanRadius = minSep * Math.max(1, Math.sqrt(members.length) / 2);
				members.forEach((mi, k) => {
					const y = 1 - (k / (members.length - 1)) * 2;
					const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
					const theta = goldenAngle * k;
					movable[mi].position.set(
						cx + fanRadius * radiusAtY * Math.cos(theta),
						cy + fanRadius * y,
						cz + fanRadius * radiusAtY * Math.sin(theta)
					);
				});
				moved = true;
			});

			// Pass 2 — relax near-misses out to minSep. Gauss-Seidel in
			// fixed build order: deterministic across updates, so a live
			// re-seat reproduces the same spread. Movable/movable pairs
			// split the push; an obstacle's pair partner takes it all
			const combined = movable.concat(obstacles);
			const movableCount = movable.length;
			for (let iter = 0; iter < 6; iter++) {
				let iterMoved = false;
				forEachNearPair(combined, minSep, (i, j, distSq) => {
					const a = combined[i];
					const b = combined[j];
					const aMovable = i < movableCount;
					const bMovable = j < movableCount;
					if (!aMovable && !bMovable) { return; }
					const dist = Math.sqrt(distSq);
					let dx;
					let dy;
					let dz;
					if (dist < 1e-6) {
						// Zero-length pair (movable exactly ON an obstacle):
						// no natural push direction — pick a deterministic
						// one from the golden angle by index
						const theta = goldenAngle * (i + 1);
						dx = Math.cos(theta);
						dy = 0;
						dz = Math.sin(theta);
					} else {
						dx = (a.position.x - b.position.x) / dist;
						dy = (a.position.y - b.position.y) / dist;
						dz = (a.position.z - b.position.z) / dist;
					}
					const overlap = minSep - dist;
					const aShare = aMovable ? (bMovable ? 0.5 : 1) : 0;
					const bShare = bMovable ? (aMovable ? 0.5 : 1) : 0;
					if (aMovable) {
						a.position.x += dx * overlap * aShare;
						a.position.y += dy * overlap * aShare;
						a.position.z += dz * overlap * aShare;
					}
					if (bMovable) {
						b.position.x -= dx * overlap * bShare;
						b.position.y -= dy * overlap * bShare;
						b.position.z -= dz * overlap * bShare;
					}
					iterMoved = true;
				});
				if (!iterMoved) { break; }
				moved = true;
			}

			if (moved) {
				movable.forEach(mesh => this.updateLabelPosition(mesh));
				this.needsRender = true;
			}
		}

		/**
		 * Creation graph layer (control.json callers). Nodes are scopes
		 * on the static call path to `new` sites, edges run caller → callee
		 * with the callee one hop closer to creation. Deterministic pinned
		 * layout mirroring the type shells:
		 *  - the main.ts starter is a gold DIAMOND tangent to the
		 *    collection marker's right side (+X) — both graphs keep their
		 *    own center, side by side
		 *  - other starters occupy normalized sub-rings between the center
		 *    and the gen-0 shell, one ring per hop from the center,
		 *    Fibonacci spread
		 *  - holders (scopes with `new` anchors) are diamonds placed on a
		 *    hidden CONCENTRIC SHELL around their created type's sphere
		 *    (dir × nodeRadius × 2.4 from the sphere center; the first
		 *    holder keeps the +X anchor, co-holders Fibonacci-spread
		 *    over the whole shell); EVERY held type gets a DASHED edge
		 *    with an arrowhead at the sphere tip (diamond → sphere: the
		 *    holder creates the type) — the diamond keeps its shape, the
		 *    links read as invocation edges. Call edges carry arrowheads
		 *    too (caller → callee).
		 *    Holders wired into the call graph (any edge in/out) glow
		 *    cyan; isolated ones (their own entry points) keep orchid
		 *  - mid-chain nodes interpolate between their chain's starter and
		 *    holder positions by relative hop distance
		 * Everything lands in instrumentationGroup — the Layers checkbox
		 * toggles the whole layer, labels included. Creation meshes stay
		 * OUT of nodeMeshes but ride the interactive list: drag pins
		 * them, click shows the scope tooltip, double-click jumps to
		 * the scope's location.
		 */
		buildCreationLayer(data, nodeMap, placeOnSphere, nodeRadius) {
			const creation = data.creation;
			if (!creation || !Array.isArray(creation.nodes) || creation.nodes.length === 0) {
				return;
			}
			const nodes = creation.nodes;
			const links = Array.isArray(creation.links) ? creation.links : [];
			const byId = new Map();
			nodes.forEach(n => byId.set(n.id, n));

			const outgoing = new Map();
			const incoming = new Map();
			links.forEach(link => {
				if (!byId.has(link.source) || !byId.has(link.target)) { return; }
				if (!outgoing.has(link.source)) { outgoing.set(link.source, []); }
				outgoing.get(link.source).push(link.target);
				if (!incoming.has(link.target)) { incoming.set(link.target, []); }
				incoming.get(link.target).push(link.source);
			});

			const center = this.findCreationCenter(creation);

			// Hop depth from the center, walking caller → callee
			const hop = new Map();
			if (center) {
				hop.set(center.id, 0);
				const queue = [center.id];
				while (queue.length) {
					const current = queue.shift();
					const nextHop = hop.get(current) + 1;
					(outgoing.get(current) || []).forEach(next => {
						if (!hop.has(next)) {
							hop.set(next, nextHop);
							queue.push(next);
						}
					});
				}
			}
			const maxHop = Math.max(0, ...hop.values());

			// Starters the center cannot reach are entry points of their
			// own — they land on the outermost sub-ring
			const hasOuterStarterRing = nodes.some(n => n.starter && n !== center && !hop.has(n.id));
			const maxRing = Math.max(maxHop + (hasOuterStarterRing ? 1 : 0), 1);
			const gen0Radius = (this.depthRadii && this.depthRadii.get(0)) || 105;
			const ringRadius = (h) => gen0Radius * h / (maxRing + 1);

			const diamondRadius = nodeRadius * 0.55;

			const positions = new Map();
			if (center) {
				// The creation center is a diamond too, tangent to the
				// collection marker's RIGHT side (+X): both graphs keep
				// their own center, side by side
				positions.set(center.id, { x: nodeRadius * 0.5 + diamondRadius, y: 0, z: 0 });
			}

			// Non-center starters on their sub-rings, Fibonacci spread
			const startersByRing = new Map();
			nodes.forEach(n => {
				if (!n.starter || n === center) { return; }
				const h = hop.has(n.id) ? hop.get(n.id) : maxRing;
				const ring = Math.min(Math.max(h, 1), maxRing);
				if (!startersByRing.has(ring)) { startersByRing.set(ring, []); }
				startersByRing.get(ring).push(n);
			});
			startersByRing.forEach((ringNodes, ring) => {
				const r = ringRadius(ring);
				ringNodes.forEach((n, i) => {
					positions.set(n.id, placeOnSphere(r, i, ringNodes.length));
				});
			});

			// Holder anchors resolve to their type spheres. Co-holders of
			// one type spread over a hidden CONCENTRIC SHELL around the
			// sphere: k=0 keeps the canonical +X anchor, k≥1 walks a
			// golden-angle Fibonacci lattice over the whole shell, so a
			// pile of co-holder labels never hides the sphere
			const goldenAngle = Math.PI * (3 - Math.sqrt(5));
			// Count co-holders per type first (mirroring the resolution
			// guards below) so the lattice knows its total
			const holderCountByType = new Map();
			nodes.forEach(holder => {
				if (!Array.isArray(holder.creates) || holder.creates.length === 0) { return; }
				const seenTypes = new Set();
				holder.creates.forEach(anchor => {
					if (seenTypes.has(anchor.typePath)) { return; }
					seenTypes.add(anchor.typePath);
					const typeNode = nodeMap.get(anchor.typePath);
					if (!typeNode || typeNode.x === undefined) { return; }
					holderCountByType.set(anchor.typePath, (holderCountByType.get(anchor.typePath) || 0) + 1);
				});
			});
			const typeHolderSpread = new Map();
			const holderAnchors = new Map();
			nodes.forEach(holder => {
				if (!Array.isArray(holder.creates) || holder.creates.length === 0) { return; }
				const entries = [];
				const seenTypes = new Set();
				holder.creates.forEach(anchor => {
					if (seenTypes.has(anchor.typePath)) { return; }
					seenTypes.add(anchor.typePath);
					const typeNode = nodeMap.get(anchor.typePath);
					if (!typeNode || typeNode.x === undefined) { return; }
					let spread = typeHolderSpread.get(anchor.typePath);
					if (!spread) { spread = new Set(); typeHolderSpread.set(anchor.typePath, spread); }
					const k = spread.size;
					spread.add(holder.id);
					let dir;
					if (k === 0) {
						dir = new THREE.Vector3(1, 0, 0);
					} else {
						const total = holderCountByType.get(anchor.typePath) || 1;
						const remaining = Math.max(total - 1, 1);
						const y = 1 - ((k - 0.5) / remaining) * 2;
						const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
						const theta = k * goldenAngle;
						dir = new THREE.Vector3(
							radiusAtY * Math.cos(theta), y, radiusAtY * Math.sin(theta)
						).normalize();
					}
					entries.push({ typePath: anchor.typePath, typeNode, dir });
				});
				if (entries.length > 0) {
					// Shallowest shell first, typePath as tie-break — the
					// extremes of this ordering define the bar tips
					entries.sort((a, b) => {
						const dd = (a.typeNode.depth || 0) - (b.typeNode.depth || 0);
						const cmp = dd !== 0 ? dd : (a.typePath < b.typePath ? -1 : (a.typePath > b.typePath ? 1 : 0));
						return cmp;
					});
					holderAnchors.set(holder.id, entries);
				}
			});

			// The connector aims THROUGH the sphere center and ends on the
			// surface point FACING the diamond (a tangent point keeps the
			// INITIAL shell-slot direction, so a dragged diamond's arrow
			// reads as off-center). Live positions on both ends — the
			// sphere mesh is authoritative (drags, shell relaxation)
			const sphereTipToward = (entry, fromPos) => {
				const sphereMesh = this.nodeMeshes.get(entry.typePath);
				const cx = sphereMesh ? sphereMesh.position.x : (entry.typeNode.x || 0);
				const cy = sphereMesh ? sphereMesh.position.y : (entry.typeNode.y || 0);
				const cz = sphereMesh ? sphereMesh.position.z : (entry.typeNode.z || 0);
				const dx = cx - fromPos.x;
				const dy = cy - fromPos.y;
				const dz = cz - fromPos.z;
				const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
				const result = new THREE.Vector3(
					cx - (dx / len) * nodeRadius,
					cy - (dy / len) * nodeRadius,
					cz - (dz / len) * nodeRadius
				);
				return result;
			};

			// The hidden concentric shell: co-holder diamonds live well off
			// the sphere surface (dir × nodeRadius × SHELL_FACTOR from the
			// sphere center) so their labels stay readable and the sphere
			// behind them stays visible. SHELL_FACTOR is
			// layerDistances.creation.holderShell — the default the
			// Diamonds ⌖ wheel stretches
			const SHELL_FACTOR = this.layerDistances.creation.holderShell;
			const shellPoint = (entry) => {
				const typeNode = entry.typeNode;
				// The vector-sphere orient: every shell direction rotates
				// rigidly around the bound sphere — the co-holder Fibonacci
				// spread keeps its shape — and the wheel stretches the
				// ring. Read LIVE: the creation dynamics writer re-seats
				// through this same helper, no rebuild needed
				let dir = entry.dir;
				let factor = SHELL_FACTOR;
				if (this.diamondOrient) {
					dir = dir.clone().applyQuaternion(this.diamondOrient.quaternion);
					factor = SHELL_FACTOR * this.diamondOrient.scale;
				}
				const result = new THREE.Vector3(
					(typeNode.x || 0) + dir.x * nodeRadius * factor,
					(typeNode.y || 0) + dir.y * nodeRadius * factor,
					(typeNode.z || 0) + dir.z * nodeRadius * factor
				);
				return result;
			};

			const starterGeometry = new THREE.SphereGeometry(nodeRadius * 0.42, 16, 16);
			const chainGeometry = new THREE.SphereGeometry(nodeRadius * 0.36, 16, 16);
			const diamondGeometry = new THREE.OctahedronGeometry(diamondRadius);
			this.creationGeometries.push(starterGeometry, chainGeometry, diamondGeometry);

			const centerColor = 0xffd700;
			const starterColor = 0x40c4ff;
			const chainColor = 0x90a4ae;
			// Holder scheme: orchid = isolated (no invocation edges — the
			// scope is its own entry point), cyan = wired into the call
			// graph. Cyan stays in the starter/chain blue family and clear
			// of maroon (collection center) and red (errors)
			const holderColor = 0xda70d6;
			const holderConnectedColor = 0x26c6da;
			const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x8a7ca8, transparent: true, opacity: 0.35 });
			// Held types beyond the primary link to the diamond DASHED —
			// the diamond keeps its shape and the connections read as
			// edges of the invocation graph
			const connectorMaterial = new THREE.LineDashedMaterial({
				color: holderColor,
				dashSize: diamondRadius * 0.6,
				gapSize: diamondRadius * 0.4,
				transparent: true,
				opacity: 0.7
			});
			// Arrowhead at the sphere tip of every connector: the holder
			// CREATES the type, so the direction is diamond → sphere
			const connectorArrowGeometry = new THREE.ConeGeometry(1.2, 3.5, 8);
			connectorArrowGeometry.rotateX(Math.PI / 2); // tip along +Z
			const connectorArrowMaterial = new THREE.MeshBasicMaterial({ color: holderColor, transparent: true, opacity: 0.85 });
			this.creationGeometries.push(connectorArrowGeometry);
			this.creationMaterials.push(connectorArrowMaterial);
			this.creationMaterials.push(edgeMaterial, connectorMaterial);

			// Holder meshes: one diamond tangent to the primary held type
			// at exactly one point; every further held type gets a dashed
			// connector edge
			const holderRecords = new Map();
			holderAnchors.forEach((entries, holderId) => {
				const holder = byId.get(holderId);
				// Connected holders (any invocation edge in/out) glow cyan;
				// isolated ones keep the orchid they had
				const connected = incoming.has(holderId) || outgoing.has(holderId);
				const baseColor = connected ? holderConnectedColor : holderColor;
				const material = new THREE.MeshPhongMaterial({
					color: baseColor,
					emissive: baseColor,
					emissiveIntensity: 0.25,
					shininess: 60,
					specular: 0x222222
				});
				const mesh = new THREE.Mesh(diamondGeometry, material);
				mesh.userData = { creationNode: holder, baseEmissive: 0.25 };
				const record = { holder, mesh, entries, connectors: [] };
				const primary = entries[0];
				// A vertex of the octahedron FACES the sphere: local +Y
				// rotated onto the direction pointing AWAY from it
				mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), primary.dir.clone().negate());
				mesh.position.copy(shellPoint(primary));
				// EVERY held type gets a dashed connector — the primary too:
				// a dragged diamond must stay attributable to what it creates
				entries.forEach(entry => {
					const geometry = new THREE.BufferGeometry();
					geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
					const line = new THREE.Line(geometry, connectorMaterial);
					this.instrumentationGroup.add(line);
					this.creationLines.push(line);
					const arrow = new THREE.Mesh(connectorArrowGeometry, connectorArrowMaterial);
					arrow.userData = {};
					this.instrumentationGroup.add(arrow);
					this.creationMeshes.push(arrow);
					record.connectors.push({ line, entry, arrow });
				});
				this.instrumentationGroup.add(mesh);
				this.creationMeshes.push(mesh);
				this.creationMeshById.set(holderId, mesh);
				this.addLabel(mesh, holder.name, 0.55);
				if (mesh.userData.label) {
					this.instrumentationGroup.add(mesh.userData.label);
					this.instrumentationGroup.add(mesh.userData.leader);
				}
				positions.set(holderId, { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z });
				holderRecords.set(holderId, record);
			});

			// Mid-chain placement: nearest upstream starter and nearest
			// downstream holder, interpolated by relative hop distance
			const starterIds = new Set(nodes.filter(n => n.starter).map(n => n.id));
			const bfsTo = (startId, nextMap, accept) => {
				const dist = new Map([[startId, 0]]);
				const queue = [startId];
				while (queue.length) {
					const current = queue.shift();
					const d = dist.get(current);
					if (d > 0 && accept(current)) {
						const found = { id: current, dist: d };
						return found;
					}
					(nextMap.get(current) || []).forEach(next => {
						if (!dist.has(next)) {
							dist.set(next, d + 1);
							queue.push(next);
						}
					});
				}
				return null;
			};

			const chainRecords = [];
			const fallbackByRing = new Map();
			nodes.forEach(n => {
				if (positions.has(n.id)) { return; }
				const up = bfsTo(n.id, incoming, id => starterIds.has(id));
				const down = bfsTo(n.id, outgoing, id => holderRecords.has(id));
				if (up && down) {
					chainRecords.push({ node: n, upId: up.id, holderId: down.id, t: up.dist / (up.dist + down.dist), mesh: null });
				} else {
					const h = hop.has(n.id) ? hop.get(n.id) : maxRing;
					const ring = Math.min(Math.max(h, 1), maxRing);
					if (!fallbackByRing.has(ring)) { fallbackByRing.set(ring, []); }
					fallbackByRing.get(ring).push(n);
				}
			});
			fallbackByRing.forEach((ringNodes, ring) => {
				const r = ringRadius(ring);
				ringNodes.forEach((n, i) => {
					positions.set(n.id, placeOnSphere(r, i, ringNodes.length));
				});
			});

			chainRecords.forEach(record => {
				const a = positions.get(record.upId);
				const b = holderRecords.get(record.holderId).mesh.position;
				const mesh = new THREE.Mesh(chainGeometry, new THREE.MeshPhongMaterial({ color: chainColor, shininess: 40 }));
				mesh.userData = { creationNode: record.node };
				mesh.position.set(
					a.x + (b.x - a.x) * record.t,
					a.y + (b.y - a.y) * record.t,
					a.z + (b.z - a.z) * record.t
				);
				record.mesh = mesh;
				this.instrumentationGroup.add(mesh);
				this.creationMeshes.push(mesh);
				this.creationMeshById.set(record.node.id, mesh);
				this.addLabel(mesh, record.node.name, 0.55);
				if (mesh.userData.label) {
					this.instrumentationGroup.add(mesh.userData.label);
					this.instrumentationGroup.add(mesh.userData.leader);
				}
				positions.set(record.node.id, { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z });
			});

			// Center (a diamond — the diamond graph's own center), starter,
			// and fallback meshes
			nodes.forEach(n => {
				if (this.creationMeshById.has(n.id)) { return; }
				const pos = positions.get(n.id) || { x: 0, y: 0, z: 0 };
				const isCenter = center && n.id === center.id;
				const geometry = isCenter ? diamondGeometry : (n.starter ? starterGeometry : chainGeometry);
				const color = isCenter ? centerColor : (n.starter ? starterColor : chainColor);
				const material = new THREE.MeshPhongMaterial({
					color: color,
					shininess: 60,
					emissive: isCenter ? 0x8a6d00 : 0x000000,
					emissiveIntensity: isCenter ? 0.5 : 0
				});
				const mesh = new THREE.Mesh(geometry, material);
				mesh.userData = { creationNode: n, baseEmissive: isCenter ? 0.5 : 0 };
				mesh.position.set(pos.x, pos.y, pos.z);
				this.instrumentationGroup.add(mesh);
				this.creationMeshes.push(mesh);
				this.creationMeshById.set(n.id, mesh);
				this.addLabel(mesh, n.name, isCenter ? 0.7 : 0.55);
				if (mesh.userData.label) {
					this.instrumentationGroup.add(mesh.userData.label);
					this.instrumentationGroup.add(mesh.userData.leader);
				}
			});

			// Computed visibility for every scope mesh: a holder hides when
			// ALL its created types' generations are hidden; starters and
			// chain scopes carry no creates and always show. One pass
			// covers holder/chain/starter meshes — the arrowheads carry no
			// creationNode and skip. Edges, connectors and hosted bagels
			// read these .visible values and compose
			const depthOfType = (typePath) => {
				const typeNode = nodeMap.get(typePath);
				return typeNode ? (typeNode.depth || 0) : null;
			};
			this.creationMeshes.forEach(scopeMesh => {
				const scopeNode = scopeMesh.userData.creationNode;
				if (!scopeNode) { return; }
				// The invocations path filter composes with the generation
				// rule: a scope hides when its generation anchors say so OR
				// when its filePath matches the user's RegExp — the
				// "observe just app" switch
				defineComputedVisible(scopeMesh, () => !scopeHiddenByGen(scopeNode, depthOfType) && !invocationPathFiltered(scopeNode));
			});

			// Call edges as one LineSegments; endpoints are rewritten from
			// live mesh positions by the dynamic updater
			const pairs = [];
			links.forEach(link => {
				const from = this.creationMeshById.get(link.source);
				const to = this.creationMeshById.get(link.target);
				if (from && to) {
					pairs.push({ from, to });
				}
			});
			const edgePositions = new Float32Array(pairs.length * 6);
			const edgeGeometry = new THREE.BufferGeometry();
			edgeGeometry.setAttribute('position', new THREE.BufferAttribute(edgePositions, 3));
			const edgeSegments = new THREE.LineSegments(edgeGeometry, edgeMaterial);
			this.instrumentationGroup.add(edgeSegments);
			this.creationLines.push(edgeSegments);

			// Direction matters (caller → callee): one arrowhead cone per
			// call edge, rewritten together with the segment endpoints.
			// ONE InstancedMesh carries them all — a real callers graph has
			// thousands of call edges, and a mesh each was most of the
			// scene's draw calls (twice that in VR, one pass per eye).
			// Like the batched segments, a hidden arrow has no object to
			// hang a getter on: its instance gets a zero-scale matrix,
			// which rasterizes nothing. It rides creationMeshes for
			// disposal but carries no creationNode, so the interactive
			// filter never grabs it
			const callArrowGeometry = new THREE.ConeGeometry(1.4, 4, 8);
			callArrowGeometry.rotateX(Math.PI / 2); // tip along +Z
			const callArrowMaterial = new THREE.MeshBasicMaterial({ color: 0x8a7ca8, transparent: true, opacity: 0.85 });
			this.creationGeometries.push(callArrowGeometry);
			this.creationMaterials.push(callArrowMaterial);
			const callArrows = new THREE.InstancedMesh(callArrowGeometry, callArrowMaterial, Math.max(pairs.length, 1));
			callArrows.count = pairs.length;
			callArrows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
			// Instances move with the dynamics; the bounding sphere of the
			// base cone would cull the whole batch wrongly
			callArrows.frustumCulled = false;
			callArrows.userData = {};
			this.instrumentationGroup.add(callArrows);
			this.creationMeshes.push(callArrows);
			const arrowScratch = new THREE.Object3D();
			const hiddenArrow = new THREE.Matrix4().makeScale(0, 0, 0);

			this.creationDynamics.push(() => {
				holderRecords.forEach(record => {
					const primary = record.entries[0];
					// A pinned diamond keeps the user's chosen OFFSET from
					// its primary sphere: dragging the sphere carries the
					// diamond along, as if never detached. Anchor-less
					// pins stay absolute. Connectors below still follow
					// from wherever it lands
					if (record.mesh.userData.pinned) {
						if (record.mesh.userData.pinAnchor) {
							record.mesh.position.copy(record.mesh.userData.pinAnchor.position).add(record.mesh.userData.pinOffset);
						}
					} else {
						record.mesh.position.copy(shellPoint(primary));
					}
					// The orient control re-aims the octahedron vertex,
					// not just the seat: pinned diamonds keep the user's
					// placement but still FACE honestly
					if (this.diamondOrient) {
						const oriented = primary.dir.clone()
							.applyQuaternion(this.diamondOrient.quaternion)
							.negate();
						record.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), oriented);
					}
					this.updateLabelPosition(record.mesh);
					record.connectors.forEach(({ line, entry, arrow }) => {
						// The connector shows exactly when its diamond
						// AND the held type's generation both show —
						// decided HERE, in the regular update pass, no
						// flip-time loop
						const connVisible = record.mesh.visible && genDepthVisible(entry.typeNode.depth || 0);
						line.visible = connVisible;
						const p = line.geometry.attributes.position.array;
						p[0] = record.mesh.position.x;
						p[1] = record.mesh.position.y;
						p[2] = record.mesh.position.z;
						const tip = sphereTipToward(entry, record.mesh.position);
						p[3] = tip.x;
						p[4] = tip.y;
						p[5] = tip.z;
						line.geometry.attributes.position.needsUpdate = true;
						// LineDashedMaterial needs fresh distances after
						// every position rewrite or the dash pattern breaks
						line.computeLineDistances();
						// Arrowhead rides just off the sphere surface tip
						const a = record.mesh.position;
						const dx = tip.x - a.x;
						const dy = tip.y - a.y;
						const dz = tip.z - a.z;
						const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
						const gap = 2;
						arrow.visible = connVisible && len > gap * 2;
						if (arrow.visible) {
							const ratio = (len - gap) / len;
							arrow.position.set(a.x + dx * ratio, a.y + dy * ratio, a.z + dz * ratio);
							arrow.lookAt(tip.x, tip.y, tip.z);
						}
					});
				});
				chainRecords.forEach(record => {
					const upMesh = this.creationMeshById.get(record.upId);
					if (!upMesh || !record.mesh) { return; }
					// A pinned chain scope keeps the user's drop spot —
					// this interpolation would otherwise rewrite its
					// position on every update, so it would read as "not
					// movable" next to the freely draggable center
					// diamond. Same absolute-pin rule as anchor-less
					// holders
					if (record.mesh.userData.pinned) {
						this.updateLabelPosition(record.mesh);
						return;
					}
					const b = holderRecords.get(record.holderId).mesh.position;
					record.mesh.position.set(
						upMesh.position.x + (b.x - upMesh.position.x) * record.t,
						upMesh.position.y + (b.y - upMesh.position.y) * record.t,
						upMesh.position.z + (b.z - upMesh.position.z) * record.t
					);
					this.updateLabelPosition(record.mesh);
				});
				// Second-pass de-collision BEFORE the edges read positions:
				// fans pile-ups (DI-symmetric chains landing on one point)
				// and relaxes near-misses, respecting pins — fully
				// overlapping spheres must not happen
				this.decollideCreationLayer(center ? center.id : null, holderRecords, nodeRadius);
				const ep = edgeSegments.geometry.attributes.position.array;
				pairs.forEach((pair, i) => {
					// Batched segments have no per-edge object to hang a
					// getter on: a hidden pair writes DEGENERATE vertices
					// — a zero-length segment rasterizes nothing. The
					// endpoint meshes' computed .visible answers, read in
					// this regular pass
					const pairVisible = pair.from.visible && pair.to.visible;
					ep[i * 6] = pair.from.position.x;
					ep[i * 6 + 1] = pair.from.position.y;
					ep[i * 6 + 2] = pair.from.position.z;
					ep[i * 6 + 3] = pairVisible ? pair.to.position.x : pair.from.position.x;
					ep[i * 6 + 4] = pairVisible ? pair.to.position.y : pair.from.position.y;
					ep[i * 6 + 5] = pairVisible ? pair.to.position.z : pair.from.position.z;
				});
				edgeSegments.geometry.attributes.position.needsUpdate = true;
				pairs.forEach((pair, i) => {
					const a = pair.from.position;
					const b = pair.to.position;
					const dx = b.x - a.x;
					const dy = b.y - a.y;
					const dz = b.z - a.z;
					const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
					const gap = nodeRadius * 0.7;
					if (pair.from.visible && pair.to.visible && len > gap) {
						const ratio = (len - gap) / len;
						arrowScratch.position.set(a.x + dx * ratio, a.y + dy * ratio, a.z + dz * ratio);
						arrowScratch.lookAt(b.x, b.y, b.z);
						arrowScratch.updateMatrix();
						callArrows.setMatrixAt(i, arrowScratch.matrix);
					} else {
						callArrows.setMatrixAt(i, hiddenArrow);
					}
				});
				callArrows.instanceMatrix.needsUpdate = true;
			});

			// Place everything before the first frame paints
			this.creationDynamics.forEach(update => update());
		}

		/**
		 * Wrappers graph layer (eds.json wrap entries) — the bagels of the
		 * combined Dive graph. One ring (torus — the dive "wrap" made
		 * visible) per wrap call site. A bagel ENCIRCLES the element it
		 * wraps, drawn vertical (the EDS ring at the origin stays the
		 * horizontal-tilted one):
		 *  - joined to a creation scope: centered on that scope's
		 *    DIAMOND, snug (the wrapped element is the callback —
		 *    wrap(fn, instance) wraps fn; the instance is context)
		 *  - else, with no scope to host it, wraps a type's constructor
		 *    (wrapsTypePath — dive('T', wrap(fn), scope) at define
		 *    time): centered on the type SPHERE, snug
		 *  - else ambient: the outer shell past gen-0, Fibonacci spread
		 * Several bagels on one target onion out: radius × (1 + k·0.22),
		 * the vertical axis rotated k·goldenAngle around Y — a gyroscope
		 * shell, never a stack.
		 * Fiber edges are DIRECTED (arrowheads on the target): solid amber
		 * for `via` generation chains, dashed light-amber for `ctor`
		 * construction-mediated hops, salmon diamond → bagel for the scope
		 * the wrap is called in, warm orange sphere → bagel for the type
		 * whose handler PRODUCED the wrap (hostTypePath). Everything lands
		 * in diveGroup — the single "dive" Layers checkbox toggles the
		 * whole combined graph. Rings are interactive (drag pins them,
		 * click shows the wrap tooltip, double-click jumps to the site)
		 * but stay OUT of nodeMeshes.
		 */
		buildWrappersLayer(data, nodeMap, placeOnSphere, nodeRadius) {
			const wrappers = data.wrappers;
			if (!wrappers || !Array.isArray(wrappers.nodes) || wrappers.nodes.length === 0) {
				return;
			}
			const nodes = wrappers.nodes;
			const links = Array.isArray(wrappers.links) ? wrappers.links : [];
			const byId = new Map();
			nodes.forEach(n => byId.set(n.id, n));

			// Unit torus, scaled per ring — onion shells need per-ring radii,
			// so the geometry stays shared and the mesh carries the scale.
			// Tube ratio 0.12 keeps big rings slender
			const ringGeometry = new THREE.TorusGeometry(1, 0.12, 12, 32);
			this.wrapperGeometries.push(ringGeometry);

			// Amber family for the wrap itself; salmon for the join from a
			// creation diamond; warm orange for the host-type edge (the
			// instance's handler produced the wrap). ctor fiber links are
			// dashed light-amber, distinct from the solid via amber. All
			// stay clear of the creation layer's orchid/cyan, the maroon
			// center, and the red error color
			const wrapColor = 0xffb300;
			const ctorColor = 0xffd54f;
			const hostColor = 0xf9a825;
			const creationLinkMaterial = new THREE.LineBasicMaterial({ color: 0xff8a65, transparent: true, opacity: 0.7 });
			const hostLinkMaterial = new THREE.LineBasicMaterial({ color: hostColor, transparent: true, opacity: 0.75 });
			const viaMaterial = new THREE.LineBasicMaterial({ color: wrapColor, transparent: true, opacity: 0.8 });
			const ctorMaterial = new THREE.LineDashedMaterial({ color: ctorColor, transparent: true, opacity: 0.9, dashSize: 4, gapSize: 3 });
			this.wrapperMaterials.push(creationLinkMaterial, hostLinkMaterial, viaMaterial, ctorMaterial);

			// Direction is the point of the fiber edges: one cone per link,
			// landed on the target by the dynamic updater
			const arrowGeometry = new THREE.ConeGeometry(1.8, 5, 8);
			arrowGeometry.rotateX(Math.PI / 2); // tip along +Z
			const viaArrowMaterial = new THREE.MeshBasicMaterial({ color: wrapColor, transparent: true, opacity: 0.9 });
			const ctorArrowMaterial = new THREE.MeshBasicMaterial({ color: ctorColor, transparent: true, opacity: 0.9 });
			const joinArrowMaterial = new THREE.MeshBasicMaterial({ color: 0xcccccc, transparent: true, opacity: 0.6 });
			const hostArrowMaterial = new THREE.MeshBasicMaterial({ color: hostColor, transparent: true, opacity: 0.9 });
			this.wrapperGeometries.push(arrowGeometry);
			this.wrapperMaterials.push(viaArrowMaterial, ctorArrowMaterial, joinArrowMaterial, hostArrowMaterial);

			const gen0Radius = (this.depthRadii && this.depthRadii.get(0)) || 105;
			// Dive distances are panel knobs (Layers & Distances → dive ◯):
			// read live so dynamics see adjustments without a rebuild
			const diveDist = this.layerDistances.dive;
			const ambientStep = nodeRadius * diveDist.ambientStep;
			const ambientRadius = (generation) => gen0Radius * diveDist.ambientBase + generation * ambientStep;
			const goldenAngle = Math.PI * (3 - Math.sqrt(5));

			// One record per node: the mesh plus the encirclement target
			// (or the ambient direction) the dynamic updater needs.
			// Encirclement precedence: the scope diamond FIRST — the
			// wrapped element is the callback (wrap(fn, instance) wraps
			// fn; the instance is only the context carried along) — then
			// the type sphere, only when there is no scope to host the
			// wrap (genuine constructor wrap at define time)
			const records = [];
			const ambient = [];
			const onionByTarget = new Map();
			const nextOnion = (key) => {
				const k = onionByTarget.get(key) || 0;
				onionByTarget.set(key, k + 1);
				return k;
			};
			nodes.forEach(node => {
				const creationId = node.callbackScopeId || node.holderScopeId;
				const creationMesh = creationId ? this.creationMeshById.get(creationId) : null;
				const typeMesh = node.wrapsTypePath ? this.nodeMeshes.get(node.wrapsTypePath) : null;
				const hostMesh = node.hostTypePath ? this.nodeMeshes.get(node.hostTypePath) : null;
				const record = { node, mesh: null, creationMesh, typeMesh, hostMesh, dir: null, ringR: 0 };
				if (creationMesh) {
					// Snug: just bigger than the diamond (its radius is
					// nodeRadius × 0.55), one tight onion step per
					// co-located bagel
					const k = nextOnion('creation:' + creationId);
					record.ringR = nodeRadius * 0.55 * 1.35 * (1 + k * diveDist.onionStep);
					record.onionK = k;
					records.push(record);
					return;
				}
				if (typeMesh) {
					// Constructor wrap with no hosting scope: encircle the
					// type's sphere, again just bigger than it
					const k = nextOnion('type:' + node.wrapsTypePath);
					record.ringR = nodeRadius * 1.25 * (1 + k * diveDist.onionStep);
					record.onionK = k;
					records.push(record);
					return;
				}
				ambient.push(record);
			});
			ambient.forEach((record, i) => {
				const pos = placeOnSphere(ambientRadius(record.node.generation), i, ambient.length);
				// placeOnSphere returns a plain {x, y, z} — the direction
				// has to be a real Vector3 for the dynamic updater
				record.dir = new THREE.Vector3(pos.x, pos.y, pos.z).normalize();
				if (record.dir.lengthSq() === 0) { record.dir.set(1, 0, 0); }
				record.ringR = nodeRadius * 0.42;
				record.onionK = 0;
				records.push(record);
			});

			const ringMaterial = new THREE.MeshPhongMaterial({
				color: wrapColor,
				emissive: wrapColor,
				emissiveIntensity: 0.3,
				shininess: 60,
				specular: 0x222222
			});
			this.wrapperMaterials.push(ringMaterial);

			records.forEach(record => {
				const mesh = new THREE.Mesh(ringGeometry, ringMaterial);
				// Unit torus scaled to the ring radius; vertical by
				// default (torus plane XY, Y up), onion rings fan around Y
				mesh.scale.set(record.ringR, record.ringR, record.ringR);
				mesh.rotation.y = record.onionK * goldenAngle;
				mesh.userData = {
					wrapperNode  : record.node,
					baseEmissive : 0.3,
					ringOuter    : record.ringR * 1.12,
					// Co-centered onion labels must not stack: one text
					// line per onion level on top of the ring's radius
					labelOffsetY : record.ringR + 6 + record.onionK * 14
				};
				record.mesh = mesh;
				// A bagel's visibility IS its anchor's visibility:
				// encircling a hidden scope diamond or a hidden type sphere
				// hides the wrap with it — the anchor's own computed
				// .visible answers, composed here, same precedence as the
				// encirclement. Ambient bagels anchor to nothing and
				// always show
				defineComputedVisible(mesh, () => {
					if (record.creationMesh) { return record.creationMesh.visible; }
					if (record.typeMesh) { return record.typeMesh.visible; }
					return true;
				});
				// Initial position — the dynamics writer owns it from here.
				// Same precedence as the ring sizing: scope diamond first,
				// type sphere only when no scope hosts the wrap
				if (record.creationMesh) {
					mesh.position.copy(record.creationMesh.position);
				} else if (record.typeMesh) {
					mesh.position.copy(record.typeMesh.position);
				} else {
					mesh.position.copy(record.dir).multiplyScalar(ambientRadius(record.node.generation));
				}
				this.diveGroup.add(mesh);
				this.wrapperMeshes.push(mesh);
				this.wrapperMeshById.set(record.node.id, mesh);
				this.addLabel(mesh, record.node.name, 0.5);
				if (mesh.userData.label) {
					this.diveGroup.add(mesh.userData.label);
					this.diveGroup.add(mesh.userData.leader);
				}
			});

			// Fiber edges (bagel → bagel) and join edges (to creation
			// meshes / type spheres) as LineSegments; one arrowhead cone
			// per edge. Endpoints are rewritten from live positions by the
			// dynamic updater
			const buildSegments = (pairs, material, dashed) => {
				const positions = new Float32Array(pairs.length * 6);
				const geometry = new THREE.BufferGeometry();
				geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
				const segments = new THREE.LineSegments(geometry, material);
				this.diveGroup.add(segments);
				this.wrapperLines.push(segments);
				const entry = { segments, pairs, dashed };
				return entry;
			};
			const viaPairs = [];
			const ctorPairs = [];
			links.forEach(link => {
				const from = this.wrapperMeshById.get(link.source);
				const to = this.wrapperMeshById.get(link.target);
				if (!from || !to) { return; }
				const pair = { from, to };
				if (link.kind === 'ctor') { ctorPairs.push(pair); } else { viaPairs.push(pair); }
			});
			const creationPairs = [];
			const hostPairs = [];
			records.forEach(record => {
				// The scope CALLS the wrap: directed diamond → bagel.
				// While the bagel encircles that very diamond the pair is
				// co-centered — zero-length, invisible; drag the bagel out
				// and the edge reappears, keeping attribution
				if (record.creationMesh) {
					creationPairs.push({ from: record.creationMesh, to: record.mesh });
				}
				// The instance's handler PRODUCED the wrap: directed
				// sphere → bagel. Skipped when the bagel already encircles
				// that very sphere — encirclement says it
				if (record.hostMesh && record.hostMesh !== record.typeMesh) {
					hostPairs.push({ from: record.hostMesh, to: record.mesh });
				}
			});
			const viaSegments = buildSegments(viaPairs, viaMaterial, false);
			const ctorSegments = buildSegments(ctorPairs, ctorMaterial, true);
			const creationSegments = buildSegments(creationPairs, creationLinkMaterial, false);
			const hostSegments = buildSegments(hostPairs, hostLinkMaterial, false);

			// Arrowheads join wrapperMeshes for disposal (shared geometry/
			// material, no label); positions follow the live endpoints.
			// Every fiber edge here lands ON a bagel — the updater reads
			// the target ring's outer radius as the gap
			const fiberArrows = [];
			const addArrows = (pairs, material) => {
				pairs.forEach(pair => {
					const arrow = new THREE.Mesh(arrowGeometry, material);
					this.diveGroup.add(arrow);
					this.wrapperMeshes.push(arrow);
					fiberArrows.push({ arrow, pair });
				});
			};
			addArrows(viaPairs, viaArrowMaterial);
			addArrows(ctorPairs, ctorArrowMaterial);
			addArrows(creationPairs, joinArrowMaterial);
			addArrows(hostPairs, hostArrowMaterial);

			const writePairs = (entry) => {
				const p = entry.segments.geometry.attributes.position.array;
				entry.pairs.forEach((pair, i) => {
					// A hidden pair writes DEGENERATE vertices — zero-length
					// segments rasterize nothing; the endpoint meshes'
					// computed .visible answers, read in this regular pass
					// (bagels compose their anchor, diamonds/spheres answer
					// their generation)
					const pairVisible = pair.from.visible && pair.to.visible;
					p[i * 6] = pair.from.position.x;
					p[i * 6 + 1] = pair.from.position.y;
					p[i * 6 + 2] = pair.from.position.z;
					p[i * 6 + 3] = pairVisible ? pair.to.position.x : pair.from.position.x;
					p[i * 6 + 4] = pairVisible ? pair.to.position.y : pair.from.position.y;
					p[i * 6 + 5] = pairVisible ? pair.to.position.z : pair.from.position.z;
				});
				entry.segments.geometry.attributes.position.needsUpdate = true;
				if (entry.dashed) {
					// LineDashedMaterial needs fresh distances after every
					// position rewrite or the dash pattern breaks
					entry.segments.computeLineDistances();
				}
			};

			// The vector-sphere orient: bagels sit OFF their anchor along
			// the picked world direction, at wheel distance in anchor radii
			// (floored at the encircling 0 — no wheel-driven antipode
			// walk); co-located bagels keep their onion step. The ring
			// FACES its anchor once pushed out (co-centered bagels keep
			// the golden-angle fan). Ambient bagels anchor to nothing —
			// the orient does not reach them
			const pushBagelOut = (record, anchorMesh, anchorRadius) => {
				const orient = this.bagelOrient;
				if (!orient || !orient.dist) { return; }
				const step = 1 + (record.onionK || 0) * diveDist.onionStep;
				record.mesh.position.addScaledVector(orient.dir, orient.dist * anchorRadius * step);
				record.mesh.lookAt(anchorMesh.position);
			};
			this.wrapperDynamics.push(() => {
				records.forEach(record => {
					const { node, mesh, dir } = record;
					if (mesh.userData.pinned) {
						// Relative pin: keep the user's offset from the
						// anchor (scope diamond / type sphere) — the set
						// moves as one when the anchor moves. Anchor-less
						// (ambient) pins stay absolute
						if (mesh.userData.pinAnchor) {
							mesh.position.copy(mesh.userData.pinAnchor.position).add(mesh.userData.pinOffset);
						}
					} else {
						// Encircling bagels follow their target's live
						// position — scope diamond first (the callback is
						// the wrapped element), type sphere only when no
						// scope hosts the wrap; ambient hold their slot
						if (record.creationMesh) {
							mesh.position.copy(record.creationMesh.position);
							pushBagelOut(record, record.creationMesh, nodeRadius * 0.55);
						} else if (record.typeMesh) {
							mesh.position.copy(record.typeMesh.position);
							pushBagelOut(record, record.typeMesh, nodeRadius);
						} else {
							mesh.position.copy(dir).multiplyScalar(ambientRadius(node.generation));
						}
					}
					this.updateLabelPosition(mesh);
				});
				writePairs(viaSegments);
				writePairs(ctorSegments);
				writePairs(creationSegments);
				writePairs(hostSegments);
				// Arrowheads land a `gap` short of the target center (the
				// target bagel's rim) and point along travel. Degenerate
				// co-centered pairs (two bagels on one target) hide their
				// arrow — the onion reads as the relation
				fiberArrows.forEach(({ arrow, pair }) => {
					const a = pair.from.position;
					const b = pair.to.position;
					const gap = pair.to.userData.ringOuter || nodeRadius;
					const dx = b.x - a.x;
					const dy = b.y - a.y;
					const dz = b.z - a.z;
					const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
					// Hidden when either endpoint is — the meshes' computed
					// .visible, read in this regular pass
					const pairVisible = pair.from.visible && pair.to.visible;
					if (pairVisible && len > gap) {
						const ratio = (len - gap) / len;
						arrow.visible = true;
						arrow.position.set(a.x + dx * ratio, a.y + dy * ratio, a.z + dz * ratio);
						arrow.lookAt(b.x, b.y, b.z);
					} else {
						arrow.visible = false;
					}
				});
			});

			// Place everything before the first frame paints
			this.wrapperDynamics.forEach(update => update());
		}

		/**
		 * Combined Dive backplane (declared — src/graph/internals-manifest.ts;
		 * declared, not discovered: the calls completing the fiber chain live
		 * inside the dive/adapter packages, no workspace analyzer can see
		 * them).
		 *
		 *  - The EDS RING encircles the collection marker at the origin —
		 *    dive records everything the collection constructs
		 *  - The attachHooks HUB (steel-blue octahedron) sits at the ring's
		 *    right side; CURVED grafts run from it to every constructed
		 *    type's sphere after-position — bootstrap wiring firing
		 *    pre/post/err hooks per construction (never-created types get
		 *    no graft: hooks never fire for them)
		 *  - Adapter SINKS (violet boxes) stack vertically at the LEFT mid
		 *    of the scene (deterministic, -X side): the ALS provider, the
		 *    OTEL provider, the exception filter — where a fiber's data
		 *    leaves. Directed edges: ring → sinks → Jaeger
		 *  - JAEGER (gold cone) leftmost of all — outside the system
		 * Everything lands in diveGroup — the single "dive" toggle.
		 */
		buildInternalsLayer(data, nodeMap, nodeRadius) {
			const internals = data.internals;
			if (!internals || !Array.isArray(internals.nodes) || internals.nodes.length === 0) {
				return;
			}
			const links = Array.isArray(internals.links) ? internals.links : [];
			const grafts = Array.isArray(internals.grafts) ? internals.grafts : [];
			const gen0Radius = (this.depthRadii && this.depthRadii.get(0)) || 105;
			const knotRadius = nodeRadius * 0.5;

			const diveColor = 0x7aa2f7;
			const adapterColor = 0xb48ead;
			const jaegerColor = 0xf0c674;
			const slate = 0x8a8f98;

			// Shared geometries/materials — one per shape, disposed once
			const octaGeometry = new THREE.OctahedronGeometry(knotRadius);
			const boxGeometry = new THREE.BoxGeometry(knotRadius * 1.4, knotRadius * 1.4, knotRadius * 1.4);
			const coneGeometry = new THREE.ConeGeometry(knotRadius * 0.9, knotRadius * 1.8, 20);
			// The EDS ring is no shell knot: a thin, wide torus built to
			// ENCIRCLE the maroon collection marker at the origin
			const edsRingGeometry = new THREE.TorusGeometry(nodeRadius * 0.9, nodeRadius * 0.08, 12, 48);
			const arrowGeometry = new THREE.ConeGeometry(1.8, 5, 8);
			arrowGeometry.rotateX(Math.PI / 2); // tip along +Z
			this.internalsGeometries.push(octaGeometry, boxGeometry, coneGeometry, edsRingGeometry, arrowGeometry);

			const diveMaterial = new THREE.MeshPhongMaterial({
				color: diveColor, emissive: diveColor, emissiveIntensity: 0.35, shininess: 60, specular: 0x222222
			});
			const adapterMaterial = new THREE.MeshPhongMaterial({
				color: adapterColor, emissive: adapterColor, emissiveIntensity: 0.35, shininess: 60, specular: 0x222222
			});
			const jaegerMaterial = new THREE.MeshPhongMaterial({
				color: jaegerColor, emissive: jaegerColor, emissiveIntensity: 0.45, shininess: 60, specular: 0x222222
			});
			const sinkLinkMaterial = new THREE.LineBasicMaterial({ color: slate, transparent: true, opacity: 0.55 });
			const hookupLinkMaterial = new THREE.LineDashedMaterial({
				color: slate, transparent: true, opacity: 0.85, dashSize: 6, gapSize: 4
			});
			// Grafts are whisper-thin: hundreds of constructions all pass
			// through the one hub, the curve must not shout
			const graftMaterial = new THREE.LineBasicMaterial({ color: diveColor, transparent: true, opacity: 0.22 });
			const sinkArrowMaterial = new THREE.MeshBasicMaterial({ color: slate, transparent: true, opacity: 0.8 });
			this.internalsMaterials.push(diveMaterial, adapterMaterial, jaegerMaterial, sinkLinkMaterial, hookupLinkMaterial, graftMaterial, sinkArrowMaterial);

			// The EDS ring is the third CENTER alongside the collection
			// marker (instances) and the main.ts diamond (invocations) —
			// all three are convergence points keyed by paths. It
			// ENCIRCLES the maroon sphere: dive records everything the
			// collection constructs
			const ringNode = internals.nodes.find(n => n.role === 'store');
			if (ringNode) {
				const ringMesh = new THREE.Mesh(edsRingGeometry, diveMaterial);
				ringMesh.position.set(0, 0, 0);
				// Saturn tilt: reads as encircling, clears the +X tangent diamond
				ringMesh.rotation.set(1.15, 0, 0.35);
				ringMesh.userData = { internalNode: ringNode, baseEmissive: 0.35 };
				this.diveGroup.add(ringMesh);
				this.internalsMeshes.push(ringMesh);
				this.internalsMeshById.set(ringNode.id, ringMesh);
				this.addLabel(ringMesh, ringNode.name, 0.5);
				if (ringMesh.userData.label) {
					// The marker's own label sits above — the ring's goes below
					ringMesh.userData.labelOffsetY = -35 * 0.5;
					this.updateLabelPosition(ringMesh);
					this.diveGroup.add(ringMesh.userData.label);
					this.diveGroup.add(ringMesh.userData.leader);
				}
			}

			// The attachHooks hub at the ring's right side (+X) — the same
			// side convention the creation center diamond uses
			const hubNode = internals.nodes.find(n => n.role === 'hub');
			let hubMesh = null;
			if (hubNode) {
				hubMesh = new THREE.Mesh(octaGeometry, diveMaterial);
				hubMesh.position.set(nodeRadius * 1.6, 0, 0);
				hubMesh.userData = { internalNode: hubNode, baseEmissive: 0.35 };
				this.diveGroup.add(hubMesh);
				this.internalsMeshes.push(hubMesh);
				this.internalsMeshById.set(hubNode.id, hubMesh);
				this.addLabel(hubMesh, hubNode.name, 0.5);
				if (hubMesh.userData.label) {
					this.diveGroup.add(hubMesh.userData.label);
					this.diveGroup.add(hubMesh.userData.leader);
				}
			}

			// Sinks and the external: the terminal zone where fiber data
			// leaves the trace system
			const placeKnot = (node, pos) => {
				const geometry = node.role === 'external' ? coneGeometry : boxGeometry;
				const material = node.role === 'external' ? jaegerMaterial : adapterMaterial;
				const mesh = new THREE.Mesh(geometry, material);
				mesh.position.set(pos.x, pos.y, pos.z);
				mesh.userData = { internalNode: node, baseEmissive: node.role === 'external' ? 0.45 : 0.35 };
				this.diveGroup.add(mesh);
				this.internalsMeshes.push(mesh);
				this.internalsMeshById.set(node.id, mesh);
				this.addLabel(mesh, node.name, 0.5);
				if (mesh.userData.label) {
					this.diveGroup.add(mesh.userData.label);
					this.diveGroup.add(mesh.userData.leader);
				}
			};
			// Terminal zone is DETERMINISTIC and NEAR: just outside the
			// gen-0 shell on the LEFT, the Jaeger cone leftmost, the
			// adapter sinks in a tight vertical stack right of it — close
			// enough to read together with the ring. The vector-sphere
			// orients re-aim that zone: dir is the zone's direction off
			// the origin, dist its reach in gen-0 radii; the stack spreads
			// along the world-up component perpendicular to dir. Read LIVE
			// through the re-seat dynamics below, so the control applies
			// without a rebuild — the shellPoint precedent
			const zoneAxis = (dir) => {
				const axis = new THREE.Vector3(0, 1, 0).addScaledVector(dir, -dir.y);
				if (axis.lengthSq() < 1e-9) {
					axis.set(0, 0, 1).addScaledVector(dir, -dir.z);
				}
				const result = axis.normalize();
				return result;
			};
			const sinkSeat = (i, count) => {
				const orient = this.sinkOrient;
				const dir = orient ? orient.dir : new THREE.Vector3(-1, 0, 0);
				const dist = orient ? orient.dist : this.layerDistances.dive.sinkOffset;
				const pos = dir.clone().multiplyScalar(gen0Radius * dist);
				pos.addScaledVector(zoneAxis(dir), (i - (count - 1) / 2) * gen0Radius * 0.5);
				return pos;
			};
			const jaegerSeat = (i) => {
				// Jaeger rides the SINKS orient — same zone direction as
				// the stack, reach stretched by the defaults' ratio so the
				// cone keeps its "leftmost of all" spot relative to its
				// company
				const orient = this.sinkOrient;
				const dir = orient ? orient.dir : new THREE.Vector3(-1, 0, 0);
				const ratio = this.layerDistances.dive.jaegerOffset / this.layerDistances.dive.sinkOffset;
				const dist = (orient ? orient.dist : this.layerDistances.dive.sinkOffset) * ratio;
				const pos = dir.clone().multiplyScalar(gen0Radius * dist);
				pos.addScaledVector(zoneAxis(dir), i * gen0Radius * 0.5);
				return pos;
			};
			const sinkNodes = internals.nodes.filter(n => n.role === 'sink');
			sinkNodes.forEach((node, i) => {
				placeKnot(node, sinkSeat(i, sinkNodes.length));
			});
			const externalNodes = internals.nodes.filter(n => n.role === 'external');
			externalNodes.forEach((node, i) => {
				placeKnot(node, jaegerSeat(i));
			});

			// Re-seat UNPINNED sinks/cones from the live orients — the
			// vector-sphere control applies without a rebuild. Must run
			// BEFORE the pinned-follow writer below: pinned sinks read
			// their anchor cone's fresh position — and both run before
			// writeSinks (the sink edges read live positions)
			this.internalsDynamics.push(() => {
				const sinks = sinkNodes.map(n => this.internalsMeshById.get(n.id)).filter(Boolean);
				sinks.forEach((mesh, i) => {
					if (mesh.userData.pinned) { return; }
					const seat = sinkSeat(i, sinks.length);
					mesh.position.copy(seat);
					this.updateLabelPosition(mesh);
				});
				const externals = externalNodes.map(n => this.internalsMeshById.get(n.id)).filter(Boolean);
				externals.forEach((mesh, i) => {
					if (mesh.userData.pinned) { return; }
					const seat = jaegerSeat(i);
					mesh.position.copy(seat);
					this.updateLabelPosition(mesh);
				});
			});

			// Sinks pin RELATIVE to the Jaeger cone. Re-apply anchor +
			// offset on every dynamics tick so dragging the cone carries
			// the stack — as if never detached, the same rule diamonds
			// follow on their spheres. Must run BEFORE writeSinks: the
			// sink edges read live positions and would lag a frame
			// otherwise
			this.internalsDynamics.push(() => {
				this.internalsMeshes.forEach(m => {
					const knot = m.userData.internalNode;
					if (!knot || knot.role !== 'sink' || !m.userData.pinned || !m.userData.pinAnchor || !m.userData.pinOffset) { return; }
					m.position.copy(m.userData.pinAnchor.position).add(m.userData.pinOffset);
					this.updateLabelPosition(m);
				});
			});

			// Sink edges — directed as DATA flows: ring → providers/filter
			// → Jaeger. Endpoints are draggable knots, so the edges and
			// arrowheads ride internalsDynamics (sticky, like every other
			// layer's links)
			const sinkPairs = [];
			const sinkArrows = [];
			links.forEach(link => {
				if (link.kind !== 'sink') { return; }
				const from = this.internalsMeshById.get(link.source);
				const to = this.internalsMeshById.get(link.target);
				if (!from || !to) { return; }
				sinkPairs.push({ from, to });
				const arrow = new THREE.Mesh(arrowGeometry, sinkArrowMaterial);
				this.diveGroup.add(arrow);
				// Arrows ride internalsMeshes for disposal (shared
				// geometry/material, no label)
				this.internalsMeshes.push(arrow);
				sinkArrows.push({ arrow, from, to });
			});
			if (sinkPairs.length > 0) {
				const sinkPositions = new Float32Array(sinkPairs.length * 6);
				const sinkGeometry = new THREE.BufferGeometry();
				sinkGeometry.setAttribute('position', new THREE.BufferAttribute(sinkPositions, 3));
				const sinkSegments = new THREE.LineSegments(sinkGeometry, sinkLinkMaterial);
				this.diveGroup.add(sinkSegments);
				this.internalsLines.push(sinkSegments);
				const writeSinks = () => {
					sinkPairs.forEach((pair, i) => {
						sinkPositions[i * 6] = pair.from.position.x;
						sinkPositions[i * 6 + 1] = pair.from.position.y;
						sinkPositions[i * 6 + 2] = pair.from.position.z;
						sinkPositions[i * 6 + 3] = pair.to.position.x;
						sinkPositions[i * 6 + 4] = pair.to.position.y;
						sinkPositions[i * 6 + 5] = pair.to.position.z;
					});
					sinkGeometry.attributes.position.needsUpdate = true;
					sinkArrows.forEach(({ arrow, from, to }) => {
						const a = from.position;
						const b = to.position;
						const dx = b.x - a.x;
						const dy = b.y - a.y;
						const dz = b.z - a.z;
						const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
						const gap = knotRadius * 1.6;
						arrow.visible = len > gap;
						if (arrow.visible) {
							const ratio = (len - gap) / len;
							arrow.position.set(a.x + dx * ratio, a.y + dy * ratio, a.z + dz * ratio);
							arrow.lookAt(b.x, b.y, b.z);
						}
					});
				};
				writeSinks();
				this.internalsDynamics.push(writeSinks);
			}

			// The collection → hub hookup (dashed): attachHooks wires the
			// whole collection. The marker sits at the origin; rewritten on
			// dynamics together with the grafts
			const hookupLink = links.find(l => l.kind === 'hookup');
			let hookupLine = null;
			if (hookupLink && hubMesh && this.centerMarker) {
				const hookupGeometry = new THREE.BufferGeometry();
				hookupGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
				hookupLine = new THREE.Line(hookupGeometry, hookupLinkMaterial);
				this.diveGroup.add(hookupLine);
				this.internalsLines.push(hookupLine);
			}

			// attachHooks grafts: CURVES from the hub to each constructed
			// type's after-position (just past the sphere, radially out).
			// The graft IS the hooks firing: preCreation enters the parent
			// context, postCreation records the create edge, creationError
			// pins the failure — per construction
			const GRAFT_POINTS = 20;
			const graftEntries = [];
			if (hubMesh) {
				grafts.forEach(typeId => {
					const target = nodeMap.get(typeId);
					if (!target) { return; }
					const graftGeometry = new THREE.BufferGeometry();
					graftGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(GRAFT_POINTS * 3), 3));
					const line = new THREE.Line(graftGeometry, graftMaterial);
					this.diveGroup.add(line);
					this.internalsLines.push(line);
					// The graft fires for ITS type's construction — it
					// hides with the type's generation
					defineComputedVisible(line, () => genDepthVisible(target.depth || 0));
					graftEntries.push({ line, target });
				});
			}

			const writeGrafts = () => {
				if (hubMesh) {
					const hubPos = hubMesh.position;
					graftEntries.forEach(({ line, target }) => {
						const tx = target.x || 0;
						const ty = target.y || 0;
						const tz = target.z || 0;
						const radial = new THREE.Vector3(tx, ty, tz);
						if (radial.lengthSq() === 0) { radial.set(1, 0, 0); }
						radial.normalize();
						const end = new THREE.Vector3(tx, ty, tz).add(radial.clone().multiplyScalar(nodeRadius * 1.15));
						const mid = hubPos.clone().lerp(end, 0.5);
						// Bow outward from the origin so the graft clears the ring
						const bow = mid.clone().normalize().multiplyScalar(Math.max(mid.length() * 0.35, 1));
						const control = mid.clone().add(bow);
						const curve = new THREE.QuadraticBezierCurve3(hubPos.clone(), control, end);
						const points = curve.getPoints(GRAFT_POINTS - 1);
						const p = line.geometry.attributes.position.array;
						points.forEach((pt, i) => {
							p[i * 3] = pt.x;
							p[i * 3 + 1] = pt.y;
							p[i * 3 + 2] = pt.z;
						});
						line.geometry.attributes.position.needsUpdate = true;
					});
				}
				if (hookupLine && hubMesh) {
					const p = hookupLine.geometry.attributes.position.array;
					p[0] = this.centerMarker.position.x;
					p[1] = this.centerMarker.position.y;
					p[2] = this.centerMarker.position.z;
					p[3] = hubMesh.position.x;
					p[4] = hubMesh.position.y;
					p[5] = hubMesh.position.z;
					hookupLine.geometry.attributes.position.needsUpdate = true;
					// LineDashedMaterial needs fresh distances after every rewrite
					hookupLine.computeLineDistances();
				}
			};

			// Graft endpoints hang off live type spheres — rewrite after the
			// wrappers pass (drags and gen-radius relayouts move them)
			writeGrafts();
			this.internalsDynamics.push(writeGrafts);
		}

		addLabel(mesh, text, scale = 1) {
			const canvas = document.createElement('canvas');
			// willReadFrequently: the Shift+drag caption pick samples this
			// canvas's alpha at the raycast hit UV (texel-exact grab) —
			// keep it CPU-backed
			const ctx = canvas.getContext('2d', { willReadFrequently: true });

			const LABEL_FONT = 'bold 64px Arial, sans-serif';
			ctx.font = LABEL_FONT;
			// The quad is cropped to the text: a fixed-width canvas made
			// every label claim the same world width, while the layout's
			// spacing constants read measured widths — the sprite must BE
			// the measured width or the two disagree. (Assigning
			// canvas.width resets context state, so the font is set twice.)
			const widthPx = Math.ceil(ctx.measureText(text).width) + 36;
			canvas.width = Math.max(64, widthPx);
			canvas.height = 256;

			ctx.clearRect(0, 0, canvas.width, canvas.height);

			ctx.font = LABEL_FONT;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';

			ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
			ctx.lineWidth = 12;
			ctx.strokeText(text, canvas.width / 2, 128);

			ctx.fillStyle = '#ffffff';
			ctx.fillText(text, canvas.width / 2, 128);

			const texture = new THREE.CanvasTexture(canvas);
			texture.minFilter = THREE.LinearFilter;
			const spriteMaterial = new THREE.SpriteMaterial({
				map: texture,
				transparent: true,
				alphaTest: 0.5,
				// Signs must never be hidden by spheres — holds on manual
				// rotations too since it needs no per-frame work (sprites
				// are billboards: they always face the camera; only depth
				// testing could hide them)
				depthTest: false,
				depthWrite: false
			});
			const sprite = new THREE.Sprite(spriteMaterial);
			// Drawn after every sphere
			sprite.renderOrder = 999;
			// 25 world units of height per 256 canvas px — the same
			// conversion measureLabelWidths uses for the layout constants
			const worldWidth = widthPx * (25 / 256);
			sprite.scale.set(worldWidth * scale, 25 * scale, 1);

			// Store sprite reference on mesh for updates (labelScale lets
			// updateLabelPosition keep the smaller creation-label offset)
			mesh.userData.label = sprite;
			mesh.userData.labelScale = scale;
			mesh.userData.labelWidth = worldWidth * scale;
			this.graphRoot.add(sprite);
			// The sign rides the caption vector (VIEW space) from birth —
			// screen-up by default, steady on rotation; labeledMeshes
			// feeds the camera watcher
			this.labeledMeshes.push(mesh);
			this.updateLabelPosition(mesh);

			// Every sign gets a leader line back to what it signs — when
			// labels outrun their mesh (dense clusters) the connection
			// must stay visible. Shared material, per-label geometry
			if (!this.leaderMaterial) {
				this.leaderMaterial = new THREE.LineBasicMaterial({ color: 0x9aa0a6, transparent: true, opacity: 0.35 });
			}
			const leaderGeometry = new THREE.BufferGeometry();
			leaderGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
				mesh.position.x, mesh.position.y, mesh.position.z,
				sprite.position.x, sprite.position.y, sprite.position.z
			]), 3));
			const leader = new THREE.Line(leaderGeometry, this.leaderMaterial);
			leader.renderOrder = 998;
			// Both sign and leader honor the captions flag from birth —
			// the toggle never fights a rebuild. Computed visibility
			// COMPOSES the captions flag with the owner mesh's own
			// .visible — a hidden generation's captions vanish with their
			// spheres, a hidden diamond's with it; no loop anywhere
			// (setCaptionsVisible only flips the flag)
			const captionVisible = () => this.captionsVisible && mesh.visible;
			defineComputedVisible(sprite, captionVisible);
			defineComputedVisible(leader, captionVisible);
			mesh.userData.leader = leader;
			this.leaderLines.push(leader);
			this.graphRoot.add(leader);
		}

		// The rotation captions ride: the camera's, expressed in graphRoot
		// space. On the desktop the root never turns, so it IS the camera
		// quaternion; in XR it is the headset relative to the grabbed model
		captionViewQuaternion() {
			const view = this.captionViewScratch || (this.captionViewScratch = new THREE.Quaternion());
			view.copy(this.graphRoot.quaternion).invert().multiply(this.camera.quaternion);
			return view;
		}

		updateLabelPosition(mesh) {
			if (mesh.userData.label) {
				const label = mesh.userData.label;
				const scale = mesh.userData.labelScale || 1;
				// VIEW-relative placement: the offset is the caption
				// vector rotated by the LIVE camera, so signs hold their
				// screen spot on rotation. labelOffsetY keeps its meaning
				// as a SIGNED distance along the vector — alternation and
				// bagel onion steps ride the sign; a Shift-drag override
				// (captionViewOffset) carries its own direction AND
				// distance, still view-relative
				const world = this.captionScratch || (this.captionScratch = new THREE.Vector3());
				const view = this.captionViewQuaternion();
				if (mesh.userData.captionViewOffset) {
					world.copy(mesh.userData.captionViewOffset).applyQuaternion(view);
				} else {
					// captionDist: the wheel's multiplier from the
					// vector-sphere control (×1.00 default)
					const signed = (mesh.userData.labelOffsetY !== undefined ? mesh.userData.labelOffsetY : 35 * scale)
						* this.captionDist;
					world.copy(this.captionVector).applyQuaternion(view).multiplyScalar(signed);
				}
				label.position.set(
					mesh.position.x + world.x,
					mesh.position.y + world.y,
					mesh.position.z + world.z
				);
			}
			if (mesh.userData.leader) {
				const positions = mesh.userData.leader.geometry.attributes.position;
				positions.setXYZ(0, mesh.position.x, mesh.position.y, mesh.position.z);
				const anchor = mesh.userData.label ? mesh.userData.label.position : mesh.position;
				positions.setXYZ(1, anchor.x, anchor.y, anchor.z);
				positions.needsUpdate = true;
			}
		}

		// Global captions on/off — flag-only: every sign + leader reads
		// this flag through its computed-visibility getter (composed with
		// the owner mesh's .visible), so a flip touches NOTHING but the
		// flag and the scene decides on the next frame. A per-mesh loop
		// cannot work here anyway: a getter-backed .visible has no setter
		setCaptionsVisible(visible) {
			this.captionsVisible = visible;
			this.updateCenterMarkerVisibility();
			this.needsRender = true;
		}

		/**
		 * Fit the whole scene into the viewport. The viewport-visibility
		 * check: the scene's bounding radius (the outermost mesh distance
		 * from the origin, plus a margin for node radii and caption
		 * reach) against the frustum — vertical AND horizontal (aspect),
		 * the larger wins. Runs ONCE per fresh renderer — a saved/live
		 * camera always wins, rebuilds keep the user's zoom. Also
		 * stretches the zoom-out clamp, the fog and the far plane: a
		 * camera beyond 2500 would otherwise stare into a fogged-out,
		 * clipped void
		 */
		fitCameraToView() {
			let outermost = 0;
			const grow = (mesh) => {
				const d = mesh.position.length();
				if (d > outermost) { outermost = d; }
			};
			this.nodeMeshes.forEach(grow);
			this.creationMeshes.forEach(grow);
			this.wrapperMeshes.forEach(grow);
			this.internalsMeshes.forEach(grow);
			if (outermost < 1) { return; }
			// Sphere radii, diamond/bagel extents and the caption reach
			// beyond the outermost mesh ride the margin
			const bounding = outermost + (this.nodeRadius3d || 8) * 2 + 90;
			const fovHalf = (this.camera.fov * Math.PI / 180) / 2;
			const aspect = this.camera.aspect || 1;
			const fitV = bounding / Math.tan(fovHalf);
			const fitH = bounding / (Math.tan(fovHalf) * aspect);
			const fitDist = Math.max(fitV, fitH) * 1.08;
			this.zoom = fitDist;
			this.fitZoom = fitDist;
			// The zoom-out clamp, the fog range and the far plane follow
			// the scene size — the viewport-visibility guarantee must
			// survive the user's own zoom-out
			this.maxZoomOut = Math.max(2500, fitDist * 2);
			if (this.scene.fog) {
				this.scene.fog.near = this.maxZoomOut * 0.2;
				this.scene.fog.far = this.maxZoomOut;
			}
			this.camera.far = Math.max(5000, fitDist + bounding * 2);
			this.camera.updateProjectionMatrix();
			// Label legibility floor: at the fitted distance a label should
			// render at ~1.6% of the viewport height (≈12px on a 768px
			// pane). World-sized sprites shrink as the graph grows, so a
			// huge graph's labels scale up here — layout spacing keeps the
			// scale-1 measurements (the floor trades a little fit-zoom
			// spacing honesty for legibility; zooming in restores both).
			// Fit runs only on a fresh camera, so Refresh keeps the user's
			// zoom and this never re-applies mid-session
			const viewportH = (this.renderer.domElement && this.renderer.domElement.clientHeight) || 768;
			const pxPerWorld = viewportH / (2 * fitDist * Math.tan(fovHalf));
			const legibility = Math.max(1, Math.min(4, (viewportH * 0.016) / (25 * pxPerWorld)));
			if (legibility > 1) {
				this.labeledMeshes.forEach(mesh => {
					const label = mesh.userData.label;
					if (!label) { return; }
					label.scale.x *= legibility;
					label.scale.y *= legibility;
					mesh.userData.labelScale = (mesh.userData.labelScale || 1) * legibility;
					if (mesh.userData.labelWidth) { mesh.userData.labelWidth *= legibility; }
				});
			}
			this.updateCameraPosition();
		}

		zoomIn() {
			this.zoom = Math.max(100, this.zoom * 0.7);
			this.updateCameraPosition();
		}

		zoomOut() {
			this.zoom = Math.min(this.maxZoomOut || 2500, this.zoom * 1.3);
			this.updateCameraPosition();
		}

		reset() {
			// Identity orbit: unrotated, unrolled — the fresh-render view
			this.orbitQuat.identity();
			this.panOffset = { x: 0, y: 0, z: 0 };
			// Home is the FITTED view when a fit ran — the whole graph in
			// frame, not an arbitrary 600
			this.zoom = this.fitZoom || 600;
			// Homing is a deliberate re-aim at the center — the decoupled
			// aim anchor from a focus drop no longer applies
			this.aimAnchor = null;
			this.updateCameraPosition();
		}

		// Hand the orbit center back to its ANCHOR: the focused sphere
		// while one is focused (rotation orbits the selection), the graph's
		// own origin — the maroon collection marker — otherwise. The frame
		// must NOT move: the camera keeps its exact position and
		// orientation, only the pivot the NEXT gesture orbits changes. The
		// spherical state is re-derived from the live camera position
		// relative to the anchor, so the next updateCameraPosition()
		// reproduces the same position; the aim is anchored to the live
		// frame (aimAnchor), so that gesture orbits the anchor WITHOUT
		// re-aiming at it — the frame holds its screen spot. No animation,
		// no jump, no-op when the pivot already sits on the anchor.
		restoreGraphCenter(anchor) {
			const target = anchor || { x: 0, y: 0, z: 0 };
			const pan = this.panOffset;
			const atHome = !pan ||
				(Math.abs(pan.x - target.x) < 0.001 &&
					Math.abs(pan.y - target.y) < 0.001 &&
					Math.abs((pan.z || 0) - target.z) < 0.001);
			if (atHome) return;
			const pos = this.camera.position;
			const relX = pos.x - target.x;
			const relY = pos.y - target.y;
			const relZ = pos.z - target.z;
			const dist = Math.sqrt(relX * relX + relY * relY + relZ * relZ);
			this.panOffset = { x: target.x, y: target.y, z: target.z };
			if (dist < 0.0001) {
				// Degenerate: the camera sits ON the anchor — the pivot snap
				// is all there is
				return;
			}
			this.zoom = dist;
			// Re-derive the orbit state for the new anchor: swing the
			// offset direction onto the camera's live direction FROM the
			// anchor with the minimal rotation — position math stays
			// continuous across the pivot swap, and the dialed-in twist
			// (roll) survives
			const prevDir = new THREE.Vector3(0, 0, 1).applyQuaternion(this.orbitQuat);
			const newDir = new THREE.Vector3(relX / dist, relY / dist, relZ / dist);
			const swing = new THREE.Quaternion().setFromUnitVectors(prevDir, newDir);
			this.orbitQuat.premultiply(swing);
			// camera.position and camera.quaternion stay untouched — the
			// frame the user is looking at is pixel-identical.
			// Anchor the live orientation against the coupled orientation
			// of THIS rotation state: the quotient is identity here, and
			// later gestures apply only the coupled delta, so nothing on
			// screen jumps when the pivot is already home
			const qFrom = this.coupledAimQuaternion(this.orbitQuat);
			this.aimAnchor = {
				fromInv    : qFrom.invert(),
				quaternion : this.camera.quaternion.clone()
			};
		}

		resize(width, height) {
			this.camera.aspect = width / height;
			this.camera.updateProjectionMatrix();
			this.renderer.setSize(width, height);
			this.needsRender = true;
		}

		setOnNodeClick(handler) {
			this.onNodeClick = handler;
		}

		// ── WebXR ─────────────────────────────────────────────────────
		// The headset view of the SAME scene: enterXR scales graphRoot
		// into a model XR_MODEL_SIZE metres across, floating in front of
		// the viewer (local-floor space, metres), and three drives the
		// camera from the headset pose. Controllers ray-pick the mouse's
		// own `interactive` set:
		//   trigger / pinch   select: focus glow + info card on that hand;
		//                     on empty space, clear
		//   grip (hold)       grab: the model follows the hand rigidly
		//   thumbstick        ← → turn the model, ↑ ↓ grow / shrink it
		//   A / X             open the selected element's code in the editor
		//   B / Y             re-seat the model
		static get XR_MODEL_SIZE() { return 1.2; }
		static get XR_MODEL_CENTER() { return new THREE.Vector3(0, 1.3, -1.0); }
		static get XR_RAY_LENGTH() { return 5; }
		static get XR_STICK_DEADZONE() { return 0.15; }
		// Thumbstick rates: radians per second, e-folds of scale per second
		static get XR_TURN_RATE() { return 1.5; }
		static get XR_GROW_RATE() { return 0.8; }

		async enterXR(session) {
			const renderer = this.renderer;
			renderer.xr.enabled = true;
			renderer.xr.setReferenceSpaceType('local-floor');
			renderer.xr.setFoveation(1);
			this.xr = {
				fog         : this.scene.fog,
				cameraFov   : this.camera.fov,
				controllers : [],
				grab        : null,
				selected    : null,
				card        : this.createXRCard(),
				// The graph-space point turns and scaling pivot around,
				// and the scale fitXR seated (the stick clamps around it)
				pivot       : new THREE.Vector3(),
				fitScale    : 1,
				lastTick    : 0,
				raycaster   : new THREE.Raycaster(),
				// XR frames painted and the last one's time — the page's
				// no-frames watchdog reads them
				frames      : 0,
				lastFrameAt : 0
			};
			// Fog distances are graph units: over a metre-sized model they
			// never bite — XR draws without fog
			this.scene.fog = null;
			// Stereo depth: a sign drawn over a nearer sphere floats at the
			// wrong depth for one eye — captions depth-test in XR
			this.setCaptionsDepthTest(true);
			for (let index = 0; index < 2; index++) {
				this.xr.controllers.push(this.createXRController(index));
			}
			this.fitXR();
			await renderer.xr.setSession(session);
		}

		exitXR() {
			const xr = this.xr;
			if (!xr) { return; }
			this.xr = null;
			xr.controllers.forEach(entry => {
				Object.keys(entry.listeners).forEach(type => {
					entry.controller.removeEventListener(type, entry.listeners[type]);
				});
				entry.controller.remove(entry.ray);
				this.scene.remove(entry.controller);
				this.scene.remove(entry.reticle);
				entry.ray.geometry.dispose();
				entry.ray.material.dispose();
				entry.reticle.geometry.dispose();
				entry.reticle.material.dispose();
			});
			if (xr.card.parent) {
				xr.card.parent.remove(xr.card);
			}
			xr.card.geometry.dispose();
			xr.card.material.map.dispose();
			xr.card.material.dispose();
			if (xr.selected && xr.selected === this.focusedMesh) {
				this.setFocusedMesh(null);
			}
			this.renderer.xr.enabled = false;
			this.scene.fog = xr.fog;
			this.setCaptionsDepthTest(false);
			this.graphRoot.position.set(0, 0, 0);
			this.graphRoot.quaternion.identity();
			this.graphRoot.scale.setScalar(1);
			// The headset wrote its pose and projection into the camera —
			// the orbit state rebuilds the desktop view
			this.camera.fov = xr.cameraFov;
			this.camera.zoom = 1;
			this.camera.scale.set(1, 1, 1);
			this.resize(this.container.clientWidth || 800, this.container.clientHeight || 600);
			this.updateCameraPosition();
		}

		setCaptionsDepthTest(on) {
			this.labeledMeshes.forEach(mesh => {
				if (mesh.userData.label) {
					mesh.userData.label.material.depthTest = on;
				}
			});
			this.needsRender = true;
		}

		// One XR input: three's target-ray controller group plus our ray
		// (child of the group, metres along -Z) and the hit reticle (room
		// space). Listeners are kept so exitXR can unhook them — the
		// groups outlive the session inside three's WebXRManager
		createXRController(index) {
			const controller = this.renderer.xr.getController(index);
			const ray = new THREE.Line(
				new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
				new THREE.LineBasicMaterial({ color: 0x9aa0a6, transparent: true, opacity: 0.8 })
			);
			ray.scale.z = Graph3DRenderer.XR_RAY_LENGTH;
			controller.add(ray);
			const reticle = new THREE.Mesh(
				new THREE.SphereGeometry(0.006, 12, 8),
				new THREE.MeshBasicMaterial({ color: 0xffffff })
			);
			reticle.visible = false;
			this.scene.add(reticle);
			const entry = {
				controller,
				ray,
				reticle,
				inputSource : null,
				hovered     : null,
				buttonA     : false,
				buttonB     : false,
				listeners   : null
			};
			entry.listeners = {
				connected    : (event) => { entry.inputSource = event.data; },
				disconnected : () => {
					entry.inputSource = null;
					entry.hovered = null;
					if (this.xr && this.xr.grab && this.xr.grab.entry === entry) {
						this.xr.grab = null;
					}
				},
				select       : () => this.selectXR(entry),
				squeezestart : () => this.grabXR(entry),
				squeezeend   : () => {
					if (this.xr && this.xr.grab && this.xr.grab.entry === entry) {
						this.xr.grab = null;
					}
				}
			};
			Object.keys(entry.listeners).forEach(type => {
				controller.addEventListener(type, entry.listeners[type]);
			});
			this.scene.add(controller);
			return entry;
		}

		// Seat the model: graphRoot scaled so the graph's largest extent
		// is XR_MODEL_SIZE metres, its centre at XR_MODEL_CENTER, upright
		// and facing the viewer the way the desktop's default camera does
		fitXR() {
			const xr = this.xr;
			if (!xr) { return; }
			const root = this.graphRoot;
			root.position.set(0, 0, 0);
			root.quaternion.identity();
			root.scale.setScalar(1);
			root.updateMatrixWorld(true);
			const box = new THREE.Box3().setFromObject(root);
			const center = new THREE.Vector3();
			const size = new THREE.Vector3(1, 1, 1);
			if (!box.isEmpty()) {
				box.getCenter(center);
				box.getSize(size);
			}
			const scale = Graph3DRenderer.XR_MODEL_SIZE / Math.max(size.x, size.y, size.z, 1);
			root.scale.setScalar(scale);
			root.position.copy(Graph3DRenderer.XR_MODEL_CENTER).addScaledVector(center, -scale);
			xr.pivot.copy(center);
			xr.fitScale = scale;
			this.needsRender = true;
		}

		// Turn the model around the vertical through its pivot and scale
		// it about the pivot — the pivot holds its spot in the room
		turnXR(angle, factor) {
			const xr = this.xr;
			const root = this.graphRoot;
			const scale = THREE.MathUtils.clamp(root.scale.x * factor, xr.fitScale / 10, xr.fitScale * 30);
			const appliedFactor = scale / root.scale.x;
			root.updateMatrixWorld(true);
			const pivot = root.localToWorld(xr.pivot.clone());
			const spin = new THREE.Quaternion().setFromAxisAngle(ORBIT_YAW_AXIS, angle);
			root.position.sub(pivot).applyQuaternion(spin).multiplyScalar(appliedFactor).add(pivot);
			root.quaternion.premultiply(spin);
			root.scale.setScalar(scale);
		}

		grabXR(entry) {
			const xr = this.xr;
			if (!xr || !entry.inputSource) { return; }
			entry.controller.updateMatrixWorld(true);
			this.graphRoot.updateMatrix();
			// graphRoot hangs off the untransformed scene: its matrix IS
			// its world matrix. Offset = hand₀⁻¹ × root₀
			xr.grab = {
				entry,
				offset : entry.controller.matrixWorld.clone().invert().multiply(this.graphRoot.matrix)
			};
		}

		selectXR(entry) {
			const xr = this.xr;
			if (!xr) { return; }
			const mesh = entry.hovered;
			xr.selected = mesh;
			// The focus glow is the spheres' own selection look
			if (!mesh || mesh.userData.node) {
				this.setFocusedMesh(mesh);
			}
			this.showXRCard(mesh, entry);
		}

		// Per-frame XR work (animate): the grab, the thumbsticks, the ray
		// picks and the A/B buttons. three has already written this
		// frame's controller poses into their groups
		updateXR() {
			const xr = this.xr;
			const now = performance.now();
			const dt = xr.lastTick ? Math.min((now - xr.lastTick) / 1000, 0.1) : 0;
			xr.lastTick = now;
			xr.frames++;
			xr.lastFrameAt = now;
			const root = this.graphRoot;
			if (xr.grab) {
				// The model rides the hand rigidly: hand × hand₀⁻¹ × root₀
				const hand = xr.grab.entry.controller;
				hand.updateMatrixWorld(true);
				const placed = this.xrScratchMatrix || (this.xrScratchMatrix = new THREE.Matrix4());
				placed.multiplyMatrices(hand.matrixWorld, xr.grab.offset);
				placed.decompose(root.position, root.quaternion, root.scale);
			}
			const deadzone = Graph3DRenderer.XR_STICK_DEADZONE;
			let turn = 0;
			let grow = 0;
			xr.controllers.forEach(entry => {
				const gamepad = entry.inputSource && entry.inputSource.gamepad;
				if (!gamepad) { return; }
				// xr-standard mapping: axes 2/3 the thumbstick, buttons
				// 4/5 A/B (right hand) or X/Y (left hand)
				const stickX = gamepad.axes[2] || 0;
				const stickY = gamepad.axes[3] || 0;
				if (Math.abs(stickX) > deadzone) { turn += stickX; }
				// Pushing the stick forward reads negative — forward grows
				if (Math.abs(stickY) > deadzone) { grow -= stickY; }
				const pressedA = Boolean(gamepad.buttons[4] && gamepad.buttons[4].pressed);
				const pressedB = Boolean(gamepad.buttons[5] && gamepad.buttons[5].pressed);
				if (pressedA && !entry.buttonA && xr.selected) {
					this.openMeshSource(xr.selected);
				}
				if (pressedB && !entry.buttonB) {
					xr.grab = null;
					this.fitXR();
				}
				entry.buttonA = pressedA;
				entry.buttonB = pressedB;
			});
			if (!xr.grab && (turn !== 0 || grow !== 0)) {
				this.turnXR(turn * Graph3DRenderer.XR_TURN_RATE * dt, Math.exp(grow * Graph3DRenderer.XR_GROW_RATE * dt));
			}
			// Picks run against this frame's model placement
			root.updateMatrixWorld(true);
			const rotation = this.xrScratchRotation || (this.xrScratchRotation = new THREE.Matrix4());
			const ray = xr.raycaster.ray;
			xr.controllers.forEach(entry => {
				const controller = entry.controller;
				if (!entry.inputSource || !controller.visible) {
					entry.hovered = null;
					entry.reticle.visible = false;
					return;
				}
				controller.updateMatrixWorld(true);
				rotation.extractRotation(controller.matrixWorld);
				ray.origin.setFromMatrixPosition(controller.matrixWorld);
				ray.direction.set(0, 0, -1).applyMatrix4(rotation);
				const hit = firstVisibleIntersect(xr.raycaster.intersectObjects(this.interactive));
				entry.hovered = hit ? hit.object : null;
				entry.ray.scale.z = hit ? hit.distance : Graph3DRenderer.XR_RAY_LENGTH;
				entry.ray.material.color.setHex(hit ? 0xffffff : 0x9aa0a6);
				entry.reticle.visible = Boolean(hit);
				if (hit) {
					entry.reticle.position.copy(hit.point);
				}
			});
		}

		// The info card: a canvas-textured plane riding the selecting
		// hand, above and ahead of it, tilted toward the eyes — the XR
		// stand-in for the DOM tooltip
		createXRCard() {
			const canvas = document.createElement('canvas');
			canvas.width = 1024;
			canvas.height = 576;
			const texture = new THREE.CanvasTexture(canvas);
			texture.minFilter = THREE.LinearFilter;
			// The canvas paints sRGB colours — tagged so, the dark card
			// stays dark instead of washing out to grey
			texture.colorSpace = THREE.SRGBColorSpace;
			const card = new THREE.Mesh(
				new THREE.PlaneGeometry(0.24, 0.135),
				new THREE.MeshBasicMaterial({ map: texture, transparent: true })
			);
			card.position.set(0, 0.08, -0.14);
			card.rotation.x = -0.5;
			card.visible = false;
			return card;
		}

		showXRCard(mesh, entry) {
			const card = this.xr.card;
			// Shapes-only pages show no names anywhere
			if (!mesh || ANONYMIZE) {
				card.visible = false;
				return;
			}
			const lines = this.xrCardLines(mesh);
			const canvas = card.material.map.image;
			const ctx = canvas.getContext('2d');
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			ctx.fillStyle = 'rgba(37, 37, 38, 0.94)';
			ctx.strokeStyle = '#454545';
			ctx.lineWidth = 4;
			ctx.beginPath();
			ctx.roundRect(2, 2, canvas.width - 4, canvas.height - 4, 24);
			ctx.fill();
			ctx.stroke();
			const fit = (text) => {
				let shown = text;
				while (shown.length > 1 && ctx.measureText(shown).width > canvas.width - 80) {
					shown = shown.slice(0, -2) + '…';
				}
				return shown;
			};
			let y = 76;
			lines.body.forEach((line, index) => {
				ctx.font = index === 0 ? 'bold 52px system-ui, sans-serif' : '36px system-ui, sans-serif';
				ctx.fillStyle = index === 0 ? '#ffffff' : '#cccccc';
				ctx.fillText(fit(line), 40, y);
				y += index === 0 ? 64 : 46;
			});
			if (lines.hint) {
				ctx.font = '30px system-ui, sans-serif';
				ctx.fillStyle = '#9aa0a6';
				ctx.fillText(fit(lines.hint), 40, canvas.height - 36);
			}
			card.material.map.needsUpdate = true;
			if (card.parent !== entry.controller) {
				entry.controller.add(card);
			}
			card.visible = true;
		}

		// The card's text for a picked element: title, kind line, a few
		// facts, and the jump hint when there is code to jump to
		xrCardLines(mesh) {
			const site = (location) => (location && typeof location === 'object' && location.fileName)
				? fileBaseName(location.fileName) + ':' + location.line
				: null;
			const data = mesh.userData;
			const body = [];
			let jump = null;
			if (data.node) {
				const node = data.node;
				body.push(node.name, 'type · depth ' + node.depth);
				(node.properties || []).slice(0, 5).forEach(p => body.push(p.name + ': ' + p.type));
				jump = site(node.definitionLocation || node.location);
			} else if (data.creationNode) {
				const node = data.creationNode;
				body.push(node.name, node.kind + (node.starter ? ' · starter' : ''));
				const creates = (node.creates || []).map(c => c.typePath.split('.').pop());
				if (creates.length) { body.push('creates: ' + creates.join(', ')); }
				jump = site(node.location);
			} else if (data.wrapperNode) {
				const node = data.wrapperNode;
				body.push(node.name, 'wrap · generation ' + node.generation);
				if (node.wrapsTypePath) { body.push('wraps: ' + node.wrapsTypePath); }
				if (node.hostTypePath) { body.push('produced by: ' + node.hostTypePath); }
				jump = site(node.location);
			} else if (data.internalNode) {
				const knot = data.internalNode;
				body.push(knot.name, knot.role);
				if (knot.citation) { body.push('mirrors: ' + knot.citation); }
			}
			if (jump) { body.push(jump); }
			const lines = {
				body,
				hint : jump ? 'A / X — open in editor · B / Y — re-seat' : 'B / Y — re-seat'
			};
			return lines;
		}

		animate() {
			// In XR the headset moves every frame: controllers pick, the
			// grabbed model follows, and the frame always paints
			if (this.xr) {
				this.updateXR();
				this.needsRender = true;
			}
			// Captions are VIEW-relative: a camera move re-anchors every
			// sign straight from the vector — no dynamics pass, just the
			// quaternion watch
			const viewQuaternion = this.captionViewQuaternion();
			if (!viewQuaternion.equals(this.lastCameraQuaternion)) {
				this.lastCameraQuaternion.copy(viewQuaternion);
				this.labeledMeshes.forEach(m => this.updateLabelPosition(m));
				this.needsRender = true;
			}
			// Render-on-demand gate: paint only when something changed.
			// The "was" snapshot matters — the updaters below can END an
			// animation on this very tick (last flash decayed, focus anim
			// landing), and that settle frame must still paint
			// A focused sphere keeps the loop awake only while its pulse
			// is live — settled, it paints through needsRender like
			// everything else
			const pulseLive = Boolean(this.focusedMesh) && !this.focusPulseSettled;
			const wasAnimating = Boolean(this.focusAnim || pulseLive ||
				this.traceFlashes.size > 0 || this.replayFlashes.size > 0);
			this.updateFocusAnimation();
			this.updateFocusPulse();
			this.updateTraceFlashes();
			const pulseLiveAfter = Boolean(this.focusedMesh) && !this.focusPulseSettled;
			const animating = wasAnimating || Boolean(this.focusAnim || pulseLiveAfter ||
				this.traceFlashes.size > 0 || this.replayFlashes.size > 0);
			const now = performance.now();
			// ~1Hz heartbeat: self-heal for an invalidation site that
			// forgot the flag — worst case the frame is one second late
			const heartbeat = now - this.lastRenderAt >= 1000;
			if (this.needsRender || animating || heartbeat) {
				this.needsRender = false;
				this.lastRenderAt = now;
				this.renderer.render(this.scene, this.camera);
			}
		}

		clear() {
			this.focusAnim = null;
			this.focusedMesh = null;
			// Flashes and the trace path point at meshes about to be
			// disposed — no restore needed, renderGraph rebuilds all
			this.traceFlashes.clear();
			this.traceMode = null;
			// Same story for the selection, except its tube hangs off the
			// SCENE (not a layer group) — it must be removed and disposed
			// or a ghost curve survives the rebuild
			this.clearSelectionHighlight();
			this.nodeMeshes.forEach(mesh => {
				// Remove label if exists — meshes and labels live inside
				// the layer groups now, so remove from the ACTUAL parent
				// (scene.remove is a no-op for non-direct children)
				if (mesh.userData.label) {
					const label = mesh.userData.label;
					if (label.parent) {
						label.parent.remove(label);
					}
					label.material.map.dispose();
					label.material.dispose();
				}
				if (mesh.parent) {
					mesh.parent.remove(mesh);
				}
				mesh.geometry.dispose();
				mesh.material.dispose();
			});
			this.nodeMeshes.clear();
			// The label census and any half-finished caption drag die with
			// the meshes — the session override map re-seats them after
			// the rebuild
			this.labeledMeshes = [];
			this.draggedCaption = null;

			this.linkLines.forEach(({ line, arrow }) => {
				if (line.parent) {
					line.parent.remove(line);
				}
				line.geometry.dispose();
				if (arrow) {
					if (arrow.parent) {
						arrow.parent.remove(arrow);
					}
					arrow.geometry.dispose();
					arrow.material.dispose();
				}
			});
			this.linkLines = [];

			this.pathHitLines.forEach(({ line, arrow }) => {
				if (line.parent) {
					line.parent.remove(line);
				}
				line.geometry.dispose();
				line.material.dispose();
				if (arrow) {
					if (arrow.parent) {
						arrow.parent.remove(arrow);
					}
					// Shared cone geometry/material — idempotent dispose,
					// same pattern as the skeleton linkLines arrows
					arrow.geometry.dispose();
					arrow.material.dispose();
				}
			});
			this.pathHitLines = [];

			// Creation layer — meshes carry per-mesh materials and labels;
			// geometries/materials are shared and disposed once
			this.creationMeshes.forEach(mesh => {
				if (mesh.userData.label) {
					const label = mesh.userData.label;
					if (label.parent) {
						label.parent.remove(label);
					}
					label.material.map.dispose();
					label.material.dispose();
				}
				if (mesh.parent) {
					mesh.parent.remove(mesh);
				}
				mesh.material.dispose();
				if (mesh.isInstancedMesh) {
					mesh.dispose();
				}
			});
			this.creationMeshes = [];
			this.creationMeshById = new Map();
			this.creationLines.forEach(line => {
				if (line.parent) {
					line.parent.remove(line);
				}
				line.geometry.dispose();
			});
			this.creationLines = [];
			this.creationGeometries.forEach(geometry => geometry.dispose());
			this.creationGeometries = [];
			this.creationMaterials.forEach(material => material.dispose());
			this.creationMaterials = [];
			this.creationDynamics = [];

			// Wrappers layer — ring meshes share their geometry and
			// material (disposed once below); labels are per-mesh
			this.wrapperMeshes.forEach(mesh => {
				if (mesh.userData.label) {
					const label = mesh.userData.label;
					if (label.parent) {
						label.parent.remove(label);
					}
					label.material.map.dispose();
					label.material.dispose();
				}
				if (mesh.parent) {
					mesh.parent.remove(mesh);
				}
			});
			this.wrapperMeshes = [];
			this.wrapperMeshById = new Map();
			this.wrapperLines.forEach(line => {
				if (line.parent) {
					line.parent.remove(line);
				}
				line.geometry.dispose();
			});
			this.wrapperLines = [];
			this.wrapperGeometries.forEach(geometry => geometry.dispose());
			this.wrapperGeometries = [];
			this.wrapperMaterials.forEach(material => material.dispose());
			this.wrapperMaterials = [];
			this.wrapperDynamics = [];

			// Internals backplane — same lifecycle: meshes share the
			// per-shape geometries/materials (disposed once below), labels
			// are per-mesh
			this.internalsMeshes.forEach(mesh => {
				if (mesh.userData.label) {
					const label = mesh.userData.label;
					if (label.parent) {
						label.parent.remove(label);
					}
					label.material.map.dispose();
					label.material.dispose();
				}
				if (mesh.parent) {
					mesh.parent.remove(mesh);
				}
			});
			this.internalsMeshes = [];
			this.internalsMeshById = new Map();
			this.internalsLines.forEach(line => {
				if (line.parent) {
					line.parent.remove(line);
				}
				line.geometry.dispose();
			});
			this.internalsLines = [];
			this.internalsGeometries.forEach(geometry => geometry.dispose());
			this.internalsGeometries = [];
			this.internalsMaterials.forEach(material => material.dispose());
			this.internalsMaterials = [];
			this.internalsDynamics = [];

			if (this.centerMarker) {
				this.graphRoot.remove(this.centerMarker);
				if (this.centerMarker.userData.label) {
					const label = this.centerMarker.userData.label;
					if (label.parent) {
						label.parent.remove(label);
					}
					label.material.map.dispose();
					label.material.dispose();
				}
				this.centerMarker.geometry.dispose();
				this.centerMarker.material.dispose();
				this.centerMarker = null;
			}

			// Label leaders: per-label geometries, one shared material
			this.leaderLines.forEach(line => {
				if (line.parent) {
					line.parent.remove(line);
				}
				line.geometry.dispose();
			});
			this.leaderLines = [];
			if (this.leaderMaterial) {
				this.leaderMaterial.dispose();
				this.leaderMaterial = null;
			}
			this.interactive = [];

			// Layer groups are rebuilt by renderGraph
			if (this.typesGroup) {
				this.graphRoot.remove(this.typesGroup);
				this.typesGroup = null;
			}
			if (this.instrumentationGroup) {
				this.graphRoot.remove(this.instrumentationGroup);
				this.instrumentationGroup = null;
			}
			if (this.diveGroup) {
				this.graphRoot.remove(this.diveGroup);
				this.diveGroup = null;
			}
		}

		dispose() {
			// A mid-flight progressive build dies with the renderer — the
			// buildToken guard only catches a renderGraph-on-renderGraph
			// race
			if (this.buildRafId) {
				cancelAnimationFrame(this.buildRafId);
				this.buildRafId = null;
			}
			this.clear();
			if (this.renderer) {
				this.renderer.setAnimationLoop(null);
				this.renderer.dispose();
				if (this.renderer.domElement.parentNode === this.container) {
					this.container.removeChild(this.renderer.domElement);
				}
			}
		}
	}
})();

