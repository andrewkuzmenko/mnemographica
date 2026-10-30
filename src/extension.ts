import * as vscode from 'vscode';
import * as path from 'path';
import { lookup } from 'mnemonica';
import { MnemonicaTreeProvider, MnemonicaTreeItem, type MnemonicaTreeItemData } from './views/treeProvider';
import { UsagesTreeProvider, UsageTreeItem } from './views/usagesTreeProvider';
import { FlowTreeProvider, FlowTreeItem } from './views/flowTreeProvider';
import { GenTreeProvider, GenTreeItem } from './views/genTreeProvider';
import { DiamondsTreeProvider, DiamondsTreeItem } from './views/diamondsTreeProvider';
import { BagelsTreeProvider, BagelsTreeItem } from './views/bagelsTreeProvider';
import { LiveTraceTreeProvider } from './views/liveTraceTreeProvider';
import { MnemonicaDefinitionProvider } from './providers/definitionProvider';
import { MnemonicaReferenceProvider } from './providers/referenceProvider';
import { StrategyServer } from './strategy';
import { getLogger } from './services/LoggerService';
import { VSCodeNavigation } from './services/NavigationAdapter';
import { loadModels, modelsLoaded } from './topologica/bootstrap';
import { MainOrchestrator, traceEdge } from './core/MainOrchestrator';
import type { BackendRegistry_Trie_GraphNodeTrie as Trie_GraphNodeTrie, Registry as RegistryModel } from '../.tactica/types';
import { GraphPanel } from './webview/panel';
import { VrBridge } from './webview/vrBridge';
import { StrategyPanel } from './webview/strategyPanel';
import { AppChannelPanel } from './webview/appChannelPanel';
import { stopStrategyProcess } from './strategy/processManager';
import { startSelfTrace, stopSelfTrace, wrapForSelfTrace } from './strategy/selfTrace';
import { onProjectRegistryReload, peekProjectRegistry, reloadProjectRegistry } from './core/registryStore';
import { projectKey, projectRootOfContractFile } from './utils/paths';
import { registerNavigationCommands } from './commands/navigationCommands';
import { registerTreeCommands } from './commands/treeCommands';
import { registerUtilityCommands } from './commands/utilityCommands';
import { registerWorkspaceCommands } from './commands/workspaceCommands';

let treeProvider: MnemonicaTreeProvider;
let treeView: vscode.TreeView<MnemonicaTreeItem>;
let usagesProvider: UsagesTreeProvider;
let usagesTreeView: vscode.TreeView<UsageTreeItem>;
let flowProvider: FlowTreeProvider;
let flowTreeView: vscode.TreeView<FlowTreeItem>;
let genProvider: GenTreeProvider;
let genTreeView: vscode.TreeView<GenTreeItem>;
let diamondsProvider: DiamondsTreeProvider;
let diamondsTreeView: vscode.TreeView<DiamondsTreeItem>;
let bagelsProvider: BagelsTreeProvider;
let bagelsTreeView: vscode.TreeView<BagelsTreeItem>;
let definitionProvider: MnemonicaDefinitionProvider;
let referenceProvider: MnemonicaReferenceProvider;
let strategyServer: StrategyServer;
let statusBarItem: vscode.StatusBarItem;
let mainOrchestrator: MainOrchestrator;
let liveTraceProvider: LiveTraceTreeProvider;
// refreshTypeGraph routed through dive's wrap once self-tracing is up;
// until then the plain function
let tracedRefresh: typeof refreshTypeGraph = refreshTypeGraph;

// The first workspace folder's path — the extension's default project
const firstWorkspacePath = function (): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	return folder;
};

// Every sidebar tree reads the same store-owned Registry — one wiring for
// the activation load, the store-reload listener and the global refresh
function wireSidebarProviders (registry: RegistryModel): void {
	treeProvider.setRegistry(registry);
	flowProvider.setRegistry(registry);
	diamondsProvider.setRegistry(registry);
	bagelsProvider.setRegistry(registry);
}

export function activate(context: vscode.ExtensionContext) {
	// Initialize logger first so we can capture all subsequent logs
	const logger = getLogger();
	logger.initialize(context);

	logger.info('Mnemonica Graphica extension activated');

	// Initialize tree provider
	treeProvider = new MnemonicaTreeProvider();
	logger.info('TreeProvider created');

	// Create tree view with explicit TreeView reference for programmatic control
	treeView = vscode.window.createTreeView('mnemonicaTypes', {
		treeDataProvider: treeProvider,
		canSelectMany: false
	});
	context.subscriptions.push(treeView);

	// Initialize usages tree provider
	usagesProvider = new UsagesTreeProvider();
	logger.info('UsagesTreeProvider created');

	// Create usages tree view positioned above main tree
	usagesTreeView = vscode.window.createTreeView('mnemonicaUsages', {
		treeDataProvider: usagesProvider,
		canSelectMany: false
	});
	context.subscriptions.push(usagesTreeView);

	// Initialize flow tree provider
	flowProvider = new FlowTreeProvider();
	logger.info('FlowTreeProvider created');

	// Create flow tree view
	flowTreeView = vscode.window.createTreeView('mnemonicaFlow', {
		treeDataProvider: flowProvider,
		canSelectMany: false
	});
	context.subscriptions.push(flowTreeView);

	// Initialize generation tree provider
	genProvider = new GenTreeProvider();
	logger.info('GenTreeProvider created');

	// Create generation tree view
	genTreeView = vscode.window.createTreeView('mnemonicaGen', {
		treeDataProvider: genProvider,
		canSelectMany: false
	});
	context.subscriptions.push(genTreeView);

	// Initialize creation-scope (diamonds) and wrap-site (bagels) tries —
	// the 3D panel's instrumentation/dive layers as sidebar trees
	diamondsProvider = new DiamondsTreeProvider();
	diamondsTreeView = vscode.window.createTreeView('mnemonicaDiamonds', {
		treeDataProvider: diamondsProvider,
		canSelectMany: false
	});
	context.subscriptions.push(diamondsTreeView);

	bagelsProvider = new BagelsTreeProvider();
	bagelsTreeView = vscode.window.createTreeView('mnemonicaBagels', {
		treeDataProvider: bagelsProvider,
		canSelectMany: false
	});
	context.subscriptions.push(bagelsTreeView);

	// Register navigation command for flow entries
	// NOTE: VSCodeNavigation.goTo converts 1-based locations to 0-based
	// internally — pass the raw 1-based line/column from flow.json through.
	context.subscriptions.push(
		vscode.commands.registerCommand('mnemographica.navigateToLocation', async (location: { filePath: string; line: number; column: number }) => {
			try {
				await VSCodeNavigation.goTo(location.filePath, location.line, location.column);
			} catch (err) {
				logger.error('Failed to navigate to:', location.filePath, err);
			}
		})
	);

	// Register focus-or-navigate command (By Generation panel clicks):
	// rotate the 3D graph when it is on screen, jump to file otherwise
	context.subscriptions.push(
		vscode.commands.registerCommand('mnemographica.focusOrNavigate', async (target: {
			id: string;
			name: string;
			filePath?: string;
			line?: number;
			column?: number;
		}) => {
			if (!target) { return; }
			const rotated = GraphPanel.focusNode({ id: target.id, name: target.name });
			if (rotated) { return; }
			if (target.filePath) {
				try {
					await VSCodeNavigation.goTo(target.filePath, target.line ?? 0, target.column ?? 0);
				} catch (err) {
					logger.error('Failed to navigate to:', target.filePath, err);
				}
			}
		})
	);

	// Register show flows command (right-click on type/definition)
	context.subscriptions.push(
		vscode.commands.registerCommand('mnemographica.showFlows', (item: { data: { fullName?: string; label: string } }) => {
			if (!item || !item.data) { return; }
			// fullName is the exact definitions.json key — no name mangling
			const typeName = item.data.fullName || item.data.label;
			flowProvider.setFilterType(typeName);
			// Focus the Flow panel
			vscode.commands.executeCommand('mnemonicaFlow.focus');
			logger.info(`[Extension] Show flows for: ${typeName}`);
		})
	);

	// Register clear flow filter command (toolbar button in Flow panel)
	context.subscriptions.push(
		vscode.commands.registerCommand('mnemographica.clearFlowFilter', () => {
			flowProvider.clearFilter();
			logger.info('[Extension] Flow filter cleared');
		})
	);

	// Register show-on-graph command (right-click on type/definition):
	// open the 3D panel when closed, then rotate onto the node. The
	// focusNode request rides the two-level queue (panel.pendingFocus
	// flushed on 'ready', webview stash flushed after first render), so
	// it survives the freshly-created panel's load window.
	context.subscriptions.push(
		vscode.commands.registerCommand('mnemographica.showOnGraph', (item: { data: { fullName?: string; label: string } }) => {
			if (!item || !item.data) { return; }
			// definitions rows carry dot-joined fullNames — used as-is
			const id = item.data.fullName || item.data.label;
			const name = id.split('.').pop() || id;
			const graphData = mainOrchestrator.getGraphData();
			if (!graphData) {
				logger.warn('[Extension] Show on Graph: no graph data loaded yet');
				return;
			}
			// The sidebar renders the primary Registry, so its nodes live
			// in the primary source's panel — open THAT tab
			const sourceRoot = treeProvider?.getCurrentWorkspace() || firstWorkspacePath();
			if (!sourceRoot) {
				logger.warn('[Extension] Show on Graph: no workspace folder');
				return;
			}
			GraphPanel.createOrShow(context.extensionUri, sourceRoot);
			GraphPanel.focusNode({ id, name });
			// Record the menu invocation on the Trie model — the context
			// menu is part of the trie's surface
			const trie = mainOrchestrator.getRegistry()?.getTrie();
			const trieNode = trie?.getNode(id);
			if (trie && trieNode) {
				const menu = new (trieNode as Trie_GraphNodeTrie).ContextMenu({
					targetNode : id,
					items      : [
						{ label: 'Open Definition', action: 'mnemographica.openTreeItem' },
						{ label: 'Show on Graph', action: 'mnemographica.showOnGraph' },
						{ label: 'Show Usages', action: 'mnemographica.showUsages' },
						{ label: 'Show Flows', action: 'mnemographica.showFlows' }
					],
					visible    : true
				});
				trie.addMenu(menu);
			}
			logger.info(`[Extension] Show on Graph: ${id}`);
		})
	);

	// Initialize and register navigation providers
	definitionProvider = new MnemonicaDefinitionProvider();
	referenceProvider = new MnemonicaReferenceProvider();

	// Register definition provider for TypeScript files
	context.subscriptions.push(
		vscode.languages.registerDefinitionProvider(
			{ scheme: 'file', language: 'typescript' },
			definitionProvider
		)
	);

	// Register reference provider for TypeScript files
	context.subscriptions.push(
		vscode.languages.registerReferenceProvider(
			{ scheme: 'file', language: 'typescript' },
			referenceProvider
		)
	);

	logger.info('Navigation providers registered');

	// Initialize and start Strategy MCP server
	// Ports are env-overridable so a dev-host instance (headless verify,
	// live demo) can run alongside a real window that already owns the
	// defaults — EADDRINUSE here would silently disable trace ingestion.
	const strategyPort = Number(process.env.MNEMOGRAPHICA_STRATEGY_PORT) || 9230;
	const strategyWsPort = Number(process.env.MNEMOGRAPHICA_WS_PORT) || 9231;
	strategyServer = new StrategyServer(strategyPort, strategyWsPort);
	strategyServer.start().catch((err: Error) => {
		logger.error('Failed to start Strategy server:', err);
	});

	// Register server cleanup on deactivation
	context.subscriptions.push({
		dispose: () => {
			strategyServer.stop();
		}
	});

	logger.info('Strategy MCP server initialized');

	// Load mnemonica models using topologica
	loadModels(context.extensionPath);
	logger.info('Models loaded via topologica bootstrap');

	// Create main orchestrator
	mainOrchestrator = new MainOrchestrator(context.extension.packageJSON.version || '0.1.0');
	// The subsystem adapters the extension runs, recorded as Main.Adapter
	// instances on the Main model — state/query 'server' reports them
	mainOrchestrator.registerAdapter('navigation', 'vscode', true);
	mainOrchestrator.registerAdapter('strategy-server', 'trace', true);
	// The strategy server's trace-ingest/state-query read through it
	strategyServer.setOrchestrator(mainOrchestrator);
	// The App Channel tab's direct connection lands its edges the same way
	AppChannelPanel.setOrchestrator(mainOrchestrator);
	// A panel-initiated reload of the project the sidebar shows refreshes
	// the sidebar too — the store reloaded the shared instance in place,
	// the trees re-read it. Sidebar-originated reloads skip this (the
	// refreshTypeGraph path already re-pulls the providers).
	onProjectRegistryReload((sourceRoot, origin) => {
		if (origin === 'sidebar') { return; }
		const sidebarRoot = mainOrchestrator?.getWorkspacePath();
		if (!sidebarRoot || projectKey(sidebarRoot) !== sourceRoot) { return; }
		const registry = mainOrchestrator.getRegistry();
		if (!registry || !treeProvider) { return; }
		wireSidebarProviders(registry);
		treeProvider.loadFromRegistry();
	});

	// Self-instrumentation: dive runs in the extension host and its edges
	// land on the same ingestTrace. The wrap context is the Registry
	// mnemonica instance — getProps resolves its TypeName at runtime and
	// tactica sees the wrap site for eds.json.
	// Fire-and-forget: a dive load failure never blocks activation
	void startSelfTrace(mainOrchestrator).then((started) => {
		// The wrap context only carries the TypeName at runtime (getProps) —
		// a context-only Registry instance does it; the sidebar's Registry
		// comes from the registryStore per project
		const RegistryType = lookup('Registry');
		const traceContext = mainOrchestrator.getRegistry() ?? new RegistryType();
		tracedRefresh = wrapForSelfTrace(refreshTypeGraph, traceContext, 'refreshTypeGraph');
		mainOrchestrator.registerAdapter('self-trace', 'trace', started);
	});
	// The two reframe tabs: run/watch Strategy MCP, and connect directly to
	// an app's self-hosted WS channel (no CDP, no strategy in the middle)
	context.subscriptions.push(
		vscode.commands.registerCommand('mnemographica.openStrategyTab', () => {
			StrategyPanel.createOrShow();
		}),
		vscode.commands.registerCommand('mnemographica.openAppChannelTab', () => {
			AppChannelPanel.createOrShow();
		}),
		// The Ø button on the Types view: the NATIVE Settings UI filtered
		// to this extension — no custom settings page to maintain
		vscode.commands.registerCommand('mnemographica.openSettings', () => {
			void vscode.commands.executeCommand('workbench.action.openSettings', 'mnemographica');
		}),
		// Settings are host-side: follow-.tactica re-arms the panels'
		// watchers, the UI settings re-push to the webviews, and the
		// Usages tree re-applies its path filter
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (!event.affectsConfiguration('mnemographica')) {
				return;
			}
			if (event.affectsConfiguration('mnemographica.followTacticaChanges')) {
				const followOn = vscode.workspace.getConfiguration('mnemographica').get<boolean>('followTacticaChanges', false);
				GraphPanel.applyFollowSetting(followOn);
			}
			GraphPanel.pushUiSettings();
			usagesProvider.refresh();
		}),
		{ dispose: () => stopStrategyProcess() }
	);
	// Trace mode (names-first tracing): the panel resolves lineages and
	// mid-flight continuations through the orchestrator's ring
	GraphPanel.setTraceResolver({
		resolve  : (name: string) => mainOrchestrator.getTraceLineage(name),
		resolveByRoot : (rootId: number) => mainOrchestrator.getTraceLineageByRoot(rootId),
		continue : (rootId: number, edges: traceEdge[]) => {
			const continuation = mainOrchestrator.getTraceContinuation(rootId, edges);
			return continuation;
		}
	});

	// Live Trace sidebar: the machine-speed stream collected into
	// human-speed rows — one per recent trace, edge count up front,
	// expandable to per-edge code jumps
	liveTraceProvider = new LiveTraceTreeProvider(mainOrchestrator);
	context.subscriptions.push(
		vscode.window.createTreeView('mnemonicaLiveTrace', {
			treeDataProvider: liveTraceProvider,
			canSelectMany: false
		})
	);
	// Trace commands open the panel first when it is not on screen yet;
	// the webview needs a tick to be message-ready after creation, so the
	// post is deferred
	const withTracePanel = (action: () => boolean, warnText: string) => {
		if (!GraphPanel.hasOpenPanel()) {
			const sourceRoot = firstWorkspacePath();
			if (sourceRoot) {
				GraphPanel.createOrShow(context.extensionUri, sourceRoot);
			}
		}
		setTimeout(() => {
			if (!action()) {
				logger.warn(warnText);
			}
		}, 300);
	};
	context.subscriptions.push(
		vscode.commands.registerCommand('mnemographica.showTrace', (data: { name: string; rootId?: number }) => {
			// Isolate the trace in the 3D panel
			withTracePanel(
				() => GraphPanel.openTraceMode(data.name, data.rootId),
				`[LiveTrace] no trace lineage for '${data.name}'`
			);
		}),
		vscode.commands.registerCommand('mnemographica.replayTrace', (arg: { name?: string; rootId?: number; traceData?: { name: string; rootId: number } }) => {
			// Replay (Wanted #5): same resolution as showTrace, then the
			// webview re-walks the lineage at human speed. Context-menu
			// invocations pass the tree ITEM — unwrap its traceData.
			const data = arg && arg.traceData ? arg.traceData : arg as { name: string; rootId?: number };
			if (!data || typeof data.name !== 'string') { return; }
			withTracePanel(
				() => GraphPanel.replayTrace(data.name, data.rootId),
				`[LiveTrace] no trace lineage to replay for '${data.name}'`
			);
		}),
		vscode.commands.registerCommand('mnemographica.openJaegerTrace', (arg: { traceId?: string; traceData?: { traceId: string | null } }) => {
			// Wanted #2: Live Trace → Jaeger. The traceId rides each pushed
			// edge (adapter records edgeId→traceId in-target)
			const data = arg && arg.traceData ? arg.traceData : arg as { traceId?: string };
			if (!data || typeof data.traceId !== 'string' || data.traceId.length === 0) {
				return;
			}
			const base = process.env.MNEMOGRAPHICA_JAEGER_URL || 'http://localhost:16686';
			void vscode.env.openExternal(vscode.Uri.parse(`${base}/trace/${data.traceId}`));
		}),
		vscode.commands.registerCommand('mnemographica.gotoTraceEdge', async (location: { filePath: string; line: number; column: number }) => {
			// Locations are 1-based (tactica/dive callsite format) —
			// VSCodeNavigation.goTo converts internally, never pre-decrement
			try {
				await VSCodeNavigation.goTo(location.filePath, location.line, location.column);
			} catch (err) {
				logger.error('Failed to navigate to:', location.filePath, err);
			}
		})
	);
	// Wanted #1: Jaeger → VS Code. Jaeger UI link patterns turn span tags
	// into `vscode://mythographica.mnemographica/trace?root=N` links; landing
	// here focuses the Live Trace sidebar and isolates that trace in 3D.
	context.subscriptions.push(vscode.window.registerUriHandler({
		handleUri: (uri: vscode.Uri) => {
			if (uri.path !== '/trace') {
				return;
			}
			const params = new URLSearchParams(uri.query);
			const groups = mainOrchestrator.getTraceGroups(50, 5000);
			// Two jump styles: ?root=N (exact dive root edge) or
			// ?jaeger=<traceId> (match any edge's OTEL traceId — robust
			// when the true root predates the push subscription window)
			type traceGroup = (typeof groups)[number];
			let found: traceGroup | undefined;
			const rootParam = Number(params.get('root'));
			if (Number.isFinite(rootParam) && rootParam > 0) {
				found = groups.find(g => g.rootId === rootParam);
			}
			const jaegerId = params.get('jaeger');
			if (!found && jaegerId) {
				found = groups.find(g => g.edges.some(e => e.traceId === jaegerId));
			}
			if (!found) {
				logger.warn(`[LiveTrace] URI jump: no trace in the ring for ${uri.query}`);
				return;
			}
			const group = found;
			void vscode.commands.executeCommand('mnemonicaLiveTrace.focus');
			withTracePanel(
				() => GraphPanel.openTraceMode(group.name, group.rootId),
				`[LiveTrace] URI jump: no lineage for root #${group.rootId}`
			);
		}
	}));
	// Reference provider reads usages from the orchestrator's Registry —
	// no private disk copy (single load path, model audit)
	referenceProvider.setOrchestrator(mainOrchestrator);
	logger.info('MainOrchestrator created');

	// Register commands from command files (all deps now initialized)
	const navigationCommands = registerNavigationCommands(usagesProvider);
	const treeCommands = registerTreeCommands(treeProvider, referenceProvider, mainOrchestrator);
	const utilityCommands = registerUtilityCommands(strategyServer);
	const workspaceCommands = registerWorkspaceCommands(treeProvider, referenceProvider, flowProvider, diamondsProvider, bagelsProvider, mainOrchestrator);

	navigationCommands.forEach(cmd => context.subscriptions.push(cmd));
	treeCommands.forEach(cmd => context.subscriptions.push(cmd));
	utilityCommands.forEach(cmd => context.subscriptions.push(cmd));
	workspaceCommands.forEach(cmd => context.subscriptions.push(cmd));

	// Graph commands. Panels are keyed by .tactica SOURCE — one tab per
	// project, each holding what it was rendered for. The Trie panel's
	// picked source ALWAYS wins, no matter how many panels are open —
	// the workspace picker made a browsed out-of-workspace .tactica
	// UNREACHABLE (discoverTacticaSources scans workspace folders only),
	// so its 3D render could never happen. Only with NO trie loaded does
	// the command fall through: no panel → import/browse advice (both
	// routed to mnemographica.selectWorkspace); panel(s) open → the
	// workspace picker (the open-another-project flow).
	context.subscriptions.push(
		vscode.commands.registerCommand('mnemographica.showTypeGraph', async () => {
			const trieSource = treeProvider.getCurrentWorkspace();
			if (trieSource) {
				logger.info(`[Extension] Opening 3D graph for the Trie panel source ${trieSource}`);
				GraphPanel.createOrShow(context.extensionUri, trieSource);
				return;
			}
			if (!GraphPanel.hasOpenPanel()) {
				const found = await discoverTacticaSources();
				if (found.length > 1) {
					const importing = await vscode.window.showInformationMessage(
						`${found.length} .tactica directories found in this workspace — import one to open its type graph.`,
						'Import...'
					);
					if (importing) {
						await vscode.commands.executeCommand('mnemographica.selectWorkspace');
					}
					return;
				}
				const browsing = await vscode.window.showInformationMessage(
					'No .tactica loaded in the Trie panel — browse for a directory containing .tactica to load it.',
					'Browse...'
				);
				if (browsing) {
					await vscode.commands.executeCommand('mnemographica.selectWorkspace');
				}
				return;
			}
			const sources = await discoverTacticaSources();
			if (sources.length === 0) {
				vscode.window.showErrorMessage('No .tactica found in this workspace. Run tactica first.');
				return;
			}
			let sourceRoot = sources[0];
			if (sources.length > 1) {
				const workspaceRoot = firstWorkspacePath() ?? '';
				const picked = await vscode.window.showQuickPick(
					sources.map(source => {
						const relative = path.relative(workspaceRoot, source);
						const item = {
							label       : relative === '' ? `${path.basename(source)} (workspace root)` : relative,
							description : source,
							source
						};
						return item;
					}),
					{ placeHolder: 'Which project’s type graph?' }
				);
				if (!picked) {
					return;
				}
				sourceRoot = picked.source;
			}
			logger.info(`[Extension] Opening 3D graph for ${sourceRoot}`);
			GraphPanel.createOrShow(context.extensionUri, sourceRoot);
		})
	);
	// The VR bridge serves graph panels to the system browser, where
	// WebXR reaches the headset; it listens only once a panel opens VR
	const vrBridge = new VrBridge(
		vscode.Uri.joinPath(context.extensionUri, 'media').fsPath,
		(message) => logger.info(message)
	);
	GraphPanel.setVrBridge(vrBridge);
	context.subscriptions.push(vrBridge);
	context.subscriptions.push(
		vscode.commands.registerCommand('mnemographica.openGraphInVR', async () => {
			const opened = await GraphPanel.openActiveInVR();
			if (!opened) {
				vscode.window.showInformationMessage('Open the Ψ 3D graph first — VR shows the graph of the active panel.');
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('mnemographica.refreshGraph', async () => {
			await tracedRefresh(context);
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('mnemographica.refreshGenTree', async () => {
			const graphData = mainOrchestrator.getGraphData();
			if (!graphData) {
				vscode.window.showWarningMessage('No graph data available. Load a workspace first.');
				return;
			}
			genProvider.setGraphData(graphData);
			logger.info(`[GenTree] Refreshed with ${graphData.nodes.length} nodes`);
			vscode.window.showInformationMessage(`By Generation: ${graphData.nodes.length} types loaded`);
		})
	);

	// The tree-click action, shared by onDidChangeSelection (first click on
	// a row, keyboard navigation) and the mnemographica.treeItemClick item
	// command below — re-clicks on the ALREADY-SELECTED row never fire the
	// selection event, only the command does
	const activateTreeItem = async (data: MnemonicaTreeItemData) => {
		if (!data.fullPath) {
			// Clear usages when nothing is selected
			usagesProvider.clear();
			return;
		}

		// Update usages view with usages for the selected type. fullName is
		// the exact definitions.json key (collection prefix included), the
		// same key usages.json uses — looked up as is
		const typeName = data.fullName || data.label;
		logger.info(`[Extension] Selection changed to: ${typeName}`);

		// Get usages from reference provider
		const usages = referenceProvider.getUsagesForType(typeName);
		if (usages && usages.length > 0) {
			usagesProvider.setType(typeName, usages);
			logger.info(`[Extension] Loaded ${usages.length} usages for ${typeName}`);
		} else {
			usagesProvider.clear();
			logger.info(`[Extension] No usages found for ${typeName}`);
		}

		// Navigate to the selected item — unless the 3D graph is on screen,
		// in which case rotate the graph to the node instead of stealing
		// the editor (rotate when 3D open, jump to file when it is
		// closed/hidden)
		const nodeId = data.fullName || data.label;
		const rotated = GraphPanel.focusNode({ id: nodeId, name: data.label });
		if (rotated) {
			return;
		}
		try {
			await VSCodeNavigation.goTo(
				data.fullPath,
				data.line ?? 0,
				data.column ?? 0
			);
		} catch (err) {
			logger.error('Failed to navigate to:', data.fullPath, err);
		}
	};

	// A first click on a row fires BOTH onDidChangeSelection and the item
	// command; keyboard navigation fires only the selection event, a re-click
	// on the selected row only the command. The two activations of one click
	// arrive together — collapse them into one
	let lastActivation: { id: string; at: number } | undefined;
	const activateTreeItemOnce = async (data: MnemonicaTreeItemData) => {
		const id = data.fullName || data.label;
		const now = Date.now();
		if (lastActivation && lastActivation.id === id && now - lastActivation.at < 300) {
			return;
		}
		lastActivation = { id, at: now };
		await activateTreeItem(data);
	};

	// Navigate to definition when item is selected and update usages view
	treeView.onDidChangeSelection(async (event) => {
		const selected = event.selection[0];
		if (!selected) {
			// Clear usages when nothing is selected
			usagesProvider.clear();
			return;
		}
		await activateTreeItemOnce(selected.data);
	});

	// The item command fires on EVERY row click, including the re-clicks
	// the selection event skips — clicking the same element again
	// re-selects its path in the 3D graph
	context.subscriptions.push(
		vscode.commands.registerCommand('mnemographica.treeItemClick', async (data: MnemonicaTreeItemData) => {
			await activateTreeItemOnce(data);
			// A label click also unfolds the row one level — with an item
			// command set, expansion is otherwise twistie-only
			const item = treeProvider.getCachedItem(data);
			if (item && item.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
				treeView.reveal(item, { select: false, focus: false, expand: true });
			}
		})
	);

	// Load definitions from workspace if available
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && modelsLoaded) {
		const workspacePath = workspaceFolders[0].uri.fsPath;
		logger.info('Loading tree definitions from:', workspacePath);
		// The sidebar trees render THIS source's Registry — sidebar-driven
		// focus and trace entry points route to its panel
		GraphPanel.primarySource = workspacePath;

		// Load all models through MainOrchestrator
		mainOrchestrator.loadWorkspace(workspacePath).then(async () => {
			logger.info('Workspace loaded successfully via MainOrchestrator');
			// Load navigation provider data — MUST run after the
			// orchestrator load: the reference provider no longer reads
			// usages.json itself, it reads the Registry's Usages
			// instance (single load path)
			logger.info('Loading navigation providers data...');
			referenceProvider.loadUsages();

			const registry = mainOrchestrator.getRegistry();
			if (registry) {
				// Update tree provider with registry data
				treeProvider.setWorkspace(workspacePath);
				wireSidebarProviders(registry);
				treeProvider.loadFromRegistry();
				treeProvider.refresh();
			}
			// Feed the generation tree view. The 3D panel is NOT fed here:
			// it loads its own bound source on open
			const graphData = mainOrchestrator.getGraphData();
			if (graphData) {
				logger.info(`[Extension] Graph data: ${graphData.nodes.length} nodes, ${graphData.links.length} links, ${graphData.execflow.length} exec links`);
				genProvider.setGraphData(graphData);
			}
		}).catch((err: Error) => {
			logger.error('Failed to load workspace:', err);
		});
	} else {
		logger.warn('No workspace folders found, skipping data load');
	}

	// Create status bar item
	statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);
	statusBarItem.text = 'Ψ';
	statusBarItem.tooltip = 'Show Mnemonica Types';
	statusBarItem.command = 'mnemonicaTypes.focus';
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	// Set up watcher for .tactica output — the seven lethe contract files
	// (types.ts / instrumentation.json are generator-internal and unread).
	// One tactica run rewrites several files: the batch debounces into ONE
	// reload per changed project — the store's listeners then rebuild the
	// sidebar (when it shows that project) and every follow-ON panel on it.
	const tacticaWatcher = vscode.workspace.createFileSystemWatcher('**/.tactica/{hierarchy,definitions,collections,usages,flow,eds,control}.json');
	const onTacticaEvent = (uri: vscode.Uri) => {
		tacticaChangedRoots.add(projectRootOfContractFile(uri.fsPath));
		if (tacticaDebounceTimer) {
			clearTimeout(tacticaDebounceTimer);
		}
		tacticaDebounceTimer = setTimeout(() => {
			void flushTacticaChanges(context);
		}, 2000);
	};
	tacticaWatcher.onDidChange(onTacticaEvent);
	tacticaWatcher.onDidCreate(onTacticaEvent);
	context.subscriptions.push(tacticaWatcher);

	// Debug handle for agent-driven automation (Strategy/CDP channel).
	// Deliberately global: the extension host exposes no other
	// reachable entrypoint for external tooling.
	const debugHandle = {
		version : context.extension.packageJSON.version as string,
		treeProvider,
		treeView,
		usagesProvider,
		flowProvider,
		genProvider,
		diamondsProvider,
		bagelsProvider,
		liveTraceProvider,
		mainOrchestrator,
		strategyServer
	};
	(globalThis as { __mnemographica?: unknown }).__mnemographica = debugHandle;
}

/**
 * Every project root carrying a .tactica in this workspace:
 * hierarchy.json is the load-bearing artifact the Registry reads.
 * Shortest-path-first ordering — the workspace root tends to sort
 * first, so the primary source opens without a pick when several exist.
 */
async function discoverTacticaSources (): Promise<string[]> {
	const found = await vscode.workspace.findFiles('**/.tactica/hierarchy.json', '**/node_modules/**');
	const roots = new Set<string>();
	for (const uri of found) {
		roots.add(projectRootOfContractFile(uri.fsPath));
	}
	const ordered = [...roots].sort((a, b) => a.length - b.length);
	return ordered;
}

async function refreshTypeGraph(_context: vscode.ExtensionContext) {
	const logger = getLogger();
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		return;
	}

	// Refresh registry and tree view
	if (treeProvider && mainOrchestrator) {
		await mainOrchestrator.refresh();
		treeProvider.refresh();
		// The store reloaded the SAME Registry instance in place —
		// provider caches are stale afterwards, reload them
		// (flowProvider included: it used to keep pre-refresh flow data)
		const registry = mainOrchestrator.getRegistry();
		if (registry) {
			wireSidebarProviders(registry);
		}
		const graphData = mainOrchestrator.getGraphData();
		if (graphData) {
			genProvider.setGraphData(graphData);
			// 3D panels are NOT pushed here: each tab is bound to its own
			// .tactica source and re-reads it only via its own Refresh
			// button or follow opt-in — a global refresh must never
			// clobber a bound tab
		}
	}

	// Refresh the reference provider's read of the (reloaded) store entry.
	if (referenceProvider) {
		referenceProvider.clear();
		await referenceProvider.loadUsages();
	}

	logger.info('Type graph refreshed');
	vscode.window.showInformationMessage('Type graph refreshed');
}

// The .tactica watcher's batch state: one tactica run rewrites several
// contract files — the roots collect during the debounce window and each
// changed project reloads exactly once
const tacticaChangedRoots = new Set<string>();
let tacticaDebounceTimer: NodeJS.Timeout | null = null;

// Flush: the sidebar's project goes through the full sidebar refresh
// (which reloads the store itself); other already-loaded projects reload
// in the store so follow-ON panels rebuild — never-loaded projects stay
// asleep (nobody watches their data)
async function flushTacticaChanges(context: vscode.ExtensionContext) {
	const roots = [...tacticaChangedRoots];
	tacticaChangedRoots.clear();
	const sidebarRoot = mainOrchestrator?.getWorkspacePath();
	for (const root of roots) {
		if (sidebarRoot && projectKey(root) === projectKey(sidebarRoot)) {
			await tracedRefresh(context);
		} else if (peekProjectRegistry(root)) {
			await reloadProjectRegistry(root, 'watcher');
		}
	}
}

export function deactivate() {
	// Clean up
	const logger = getLogger();
	stopSelfTrace();
	logger.info('Mnemonica Graphica extension deactivated');
}
