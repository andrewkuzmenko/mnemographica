/**
 * Type definitions for Mnemonica Graphica extension
 */

// Local tactica type definitions
export type {
	TypeNode,
	PropertyInfo
} from './tactica-types';

/**
 * D3-compatible node format for visualization
 */
export type D3Node = {
	/** Unique identifier (fullPath from TypeNode) */
	id: string;
	/** Display name */
	name: string;
	/** Depth in hierarchy */
	depth: number;
	/** Whether this is a root type (no parent) */
	isRoot: boolean;
	/** Properties as array for D3 */
	properties: Array<{ name: string; type: string; optional?: boolean }>;
	/** Source location for go-to-definition */
	location?: {
		fileName: string;
		line: number;
		column: number;
	};
	/** X position (set by D3 simulation) */
	x?: number;
	/** Y position (set by D3 simulation) */
	y?: number;
	/** Fixed X position (when dragging) */
	fx?: number | null;
	/** Fixed Y position (when dragging) */
	fy?: number | null;
	/** EDS status for this node */
	edsStatus?: 'none' | 'wrap' | 'link' | 'context' | 'hook' | 'error' | 'adapter';
	/** EDS entries for this node */
	edsEntries?: Array<{
		kind: string;
		location: string;
		code: string;
		/** Scope key from eds.json when it is NOT this node (external wrap site) */
		scope?: string;
		parsedLocation?: {
			fileName: string;
			line: number;
			column: number;
		};
	}>;
	/** Source location of the actual define() constructor (from definitions.json) */
	definitionLocation?: {
		fileName: string;
		line: number;
		column: number;
	};
	/** Diagnostic: no instantiation of this type exists in usages.json —
	 * the type never happens at runtime, and neither does anything only
	 * reachable through it (the EdsProbe case). Absent when usages.json
	 * is unavailable. */
	neverCreated?: boolean;
};

/**
 * D3-compatible link format
 */
export type D3Link = {
	/** Source node ID or reference */
	source: string | D3Node;
	/** Target node ID or reference */
	target: string | D3Node;
};

/**
 * Execution-flow link (the "muscle" layer)
 */
export type D3ExecLink = {
	/** Source node ID or reference */
	source: string | D3Node;
	/** Target node ID or reference */
	target: string | D3Node;
	/** Invocation kind */
	kind: string;
	/** Call-site location */
	location?: string;
	/** Source snippet */
	code?: string;
	/** Path-hit diagnostic: the SOURCE type has no instantiation in
	 * usages.json, so this guaranteed path is never taken at runtime.
	 * Only meaningful on kind === 'edsPathHit'. */
	neverTaken?: boolean;
};

/**
 * Creation-graph node (control.json callers): a scope on the static
 * call path from an entry point down to `new SomeType()` sites. Kept
 * OUT of GraphData.nodes — creation nodes are not types and must not
 * leak into depth stats, gen controls, or trace-mode mesh lookups.
 */
export type D3CreationNode = {
	/** tactica's scopeId — the file path for module scopes,
	 * "file:line:col" (1-based) for function scopes */
	id: string;
	/** Display name (module names shortened to the file basename) */
	name: string;
	/** tactica writes module/function/method/arrow; the lethe schema keeps
	 * the kind an open string (other languages add their own) */
	kind: string;
	filePath: string;
	/** Scope start, 1-based */
	location?: {
		fileName: string;
		line: number;
		column: number;
	};
	/** Entry point of a creation chain (main.ts module, exported scopes) */
	starter: boolean;
	/** `new` sites this scope holds; only anchors whose typePath resolves
	 * to a graph node survive — same no-dangling-reference policy as
	 * the execflow layer */
	creates: Array<{
		typePath: string;
		location?: {
			fileName: string;
			line: number;
			column: number;
		};
		constructorText?: string;
		variable?: string;
		rooted?: boolean;
		terminatedAt?: string;
	}>;
};

/**
 * Creation-graph call edge: caller → callee, the callee one step closer
 * to a creation site. Endpoints are D3CreationNode ids (scopeIds).
 */
export type D3CreationLink = {
	source: string;
	target: string;
};

/**
 * Wrappers-graph node (eds.json wrap entries): one dive wrap site.
 * Kept OUT of GraphData.nodes — wrap sites are not types and must not
 * leak into depth stats, gen controls, or trace-mode mesh lookups
 * (same isolation policy as creation nodes).
 */
export type D3WrapperNode = {
	/** The wrap call-site location ("file:line:col", 1-based) — unique per site */
	id: string;
	/** Display name: the wrap's label arg, or "basename:line" */
	name: string;
	/** Wrap generation: 0 when the wrap has no recorded parent (`via`),
	 * parent generation + 1 otherwise */
	generation: number;
	/** Call-site location, parsed */
	location?: {
		fileName: string;
		line: number;
		column: number;
	};
	/** The wrap's label arg when statically visible */
	label?: string;
	/** Source snippet */
	code?: string;
	/** Join to the creation graph: the wrapped callback's own scope
	 * (preferred join — the callback is what the wrapper runs) */
	callbackScopeId?: string;
	/** Join to the creation graph: the scope holding the wrap call site
	 * (fallback join when the callback scope is not on a creation path) */
	holderScopeId?: string;
	/** Join to the type graph: mnemonica fullPath of the wrapped instance */
	wrapsTypePath?: string;
	/** Join to the type graph: the EDS scope key when it names a known
	 * type — the wrap call lives inside that type's define handler, so
	 * the instance PRODUCED this wrap (directed edge sphere → bagel) */
	hostTypePath?: string;
};

/**
 * Wrappers-graph fiber edge. `via` links are generation chains: parent
 * wrap → child wrap (the child's `via` names the parent's call-site
 * location). `ctor` links are construction-mediated ancestry (the
 * T → W2 hop): the source wrap's callback constructs type T, and the
 * target wrap is hosted by T's define handler — at runtime the child's
 * first edge parents on T's create edge through attachHooks'
 * postCreation. Endpoints are D3WrapperNode ids. Cross-layer joins
 * travel on the NODE fields (callbackScopeId / holderScopeId /
 * wrapsTypePath), mirroring how creation nodes carry `creates`.
 */
export type D3WrapperLink = {
	source: string;
	target: string;
	/** 'via' — generation chain. 'ctor' — construction-mediated hop */
	kind: 'via' | 'ctor';
	/** On 'ctor' links: the constructed type's fullPath mediating the hop */
	viaType?: string;
};

/**
 * Combined-Dive-graph node (DECLARED, not discovered): the EDS store, the
 * attachHooks hub, or an adapter sink. The knots are fixed knowledge
 * about our own packages — eds.json never sees them because the calls
 * live inside the packages, not the analyzed workspace. Kept OUT of
 * GraphData.nodes, same isolation policy as creation and wrapper nodes.
 *
 * Terminology: EDS is dive's runtime trace storage (the recorded edges
 * and the object links that hold them); a Fiber is one context segment
 * of the trace; the Trace is the bigger linear-order chain the Adapter
 * constructs — Trace ⊃ Fiber ⊃ EDS. The `dive:edsRing` knot is that
 * storage made visible (drawn as the torus encircling the origin).
 */
export type D3InternalNode = {
	/** Stable knot id: 'dive:edsRing', 'adapter:attachHooks', 'adapter:jaeger' */
	id: string;
	/** Display name ('Dive: EDS', 'Adapter: attachHooks', 'Jaeger (OTEL)') */
	name: string;
	/** Structural role: store = EDS storage (center); hub = attachHooks
	 * bootstrap wiring (grafts to every construction); sink = adapter
	 * terminal a fiber's data leaves through; external = outside the
	 * system (Jaeger) */
	role: 'store' | 'hub' | 'sink' | 'external';
	/** Repo-relative source citation for the declared knot */
	citation?: string;
};

/**
 * Combined-Dive-graph edge. `sink` links are the directed export path:
 * store → providers/filter → Jaeger. `hookup` is the single anchor from
 * the special id 'collection' (the center marker) → adapter:attachHooks.
 * Bagel → bagel fiber edges are NOT here — they are D3WrapperLink.
 */
export type D3InternalLink = {
	source: string;
	target: string;
	kind: 'sink' | 'hookup';
	/** Edge annotation (the filter's read-back edge names the read APIs) */
	label?: string;
};

/**
 * Messages passed between the graph webview and the extension (only the
 * commands the host's message switch actually handles)
 */
export type WebviewMessage = {
	/** Command type */
	command: 'goToDefinition' | 'ready' | 'log' | 'viewState' | 'pickTrace' | 'traceModeExit' | 'saveLayout' | 'refreshGraph' | 'selectCollection' | 'exportHtml' | 'openVR';
	/** Optional payload */
	data?: unknown;
};

/**
 * Complete graph data for D3
 */
export type GraphData = {
	/** Array of nodes */
	nodes: D3Node[];
	/** Inheritance links (skeleton) */
	links: D3Link[];
	/** Execution-flow links (muscle) */
	execflow: D3ExecLink[];
	/** Creation-chain graph from control.json callers. Absent when the
	 * project has no usable control.json — every consumer must treat the
	 * section as optional. */
	creation?: {
		nodes: D3CreationNode[];
		links: D3CreationLink[];
	};
	/** Wrappers graph from eds.json wrap entries (dive wrap sites and
	 * their generation chains). Absent when EDS is disabled or no wrap
	 * entries exist — every consumer must treat the section as optional. */
	wrappers?: {
		nodes: D3WrapperNode[];
		links: D3WrapperLink[];
	};
	/** Combined Dive graph: declared ring/hub/sink knots, the directed
	 * export path, and the attachHooks grafts. Absent when the workspace
	 * shows no dive wiring — optional, same as the other sections. */
	internals?: {
		nodes: D3InternalNode[];
		links: D3InternalLink[];
		/** attachHooks graft endpoints: type ids whose construction passes
		 * through the hub (never-created types excluded) */
		grafts: string[];
	};
	/** The collection this payload renders ('defaultTypes' when the
	 * project has only the default collection). tactica keys
	 * custom-collection types by a `collectionId::`-prefixed fullPath;
	 * GraphBuilder renders ONE collection's universe per payload. */
	collection?: string;
	/** Inventory of every collection present in the source's .tactica, in
	 * first-seen (types walk) order — feeds the panel's collection
	 * selector, which hides itself when this holds fewer than two. `name`
	 * is the display name from collections.json (tactica ≥ 0.4.1); absent
	 * for older outputs — show the raw id then. */
	collections?: Array<{ id: string; count: number; name?: string }>;
};

