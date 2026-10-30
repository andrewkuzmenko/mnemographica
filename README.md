# Mnemonica Graphica

Explore mnemonica type hierarchies in VS Code: definitions, generated types, usages, execution flow and inheritance depth — with go-to-definition navigation throughout.

![Mnemonica Graphica drawing its own type registry: type spheres by generation, creation-graph diamonds, dive wrap rings, the Legend, the Layers & Distances panel and the full sidebar](img/screen.png)

## Features

- **Types Tree**: The full inheritance hierarchy — the `define()` sites, nested by parent
- **Usages View**: Every place the selected type is referenced, one click to jump
- **Flow View**: Execution flow from `flow.json`, grouped by kind (instantiation, property access, pass-as-arg, …) → type → entry
- **By Generation View**: All types grouped by inheritance depth
- **Diamonds View**: The callers graph — which scopes construct which types, from entry points down to every `new` site (`control.json`)
- **Bagels View**: Every `dive.wrap` call site from `eds.json`, as a trie keyed by the wrapped type
- **3D Graph**: The whole hierarchy as an interactive Three.js scene (`Mnemonica: Ψ 3D`) — type spheres, creation diamonds, wrap rings, and the dive internals backplane, with draggable nodes (Ctrl+drag a sphere to move its whole subtree; Ctrl+wheel in a generation's radius window spreads its siblings apart) and a persistent layout (Save)
- **VR**: The 🥽 button on the 3D graph (or `Mnemonica: Ψ 3D in VR`) opens the same graph in the browser, mirrored live with the editor; in Chrome or Edge with an OpenXR headset runtime (Meta Quest Link: Meta Horizon Link → Settings → General → OpenXR Runtime) **Enter VR** shows it as a model in the room — trigger selects (info card on the hand), grip grabs, the thumbstick turns and scales, A/X opens the selection in the editor, B/Y re-centers
- **Live Trace**: The sidebar collects a running app's dive-trace stream — recent traces grouped by shape, errored ones in red, click to isolate a trace in the 3D graph or open it in Jaeger
- **Code Navigation**: Ctrl+Click (Go to Definition) and Shift+F12 (Find References) for your mnemonica types
- **Live Connection Tabs**: `Ψ Strategy MCP` spawns and watches the strategy server; `Ψ App Channel` connects directly to a running app's embedded WS channel — no CDP, no debugger
- **Real-time Updates**: Views refresh automatically when source files or `.tactica` output change

## Take a Look

The extension reads `.tactica/` artifacts, so an empty project shows an empty sidebar. To simply **see it in action**, grab the demo app — a small NestJS project fully wired with the mnemonica ecosystem, `.tactica/` committed:

```bash
git clone https://github.com/mythographica/tactica-nestjs
code tactica-nestjs
```

In that window:

1. Open the **Ψ Mnemonica** container in the activity bar — Types, Usages, Flow, By Generation, Diamonds and Bagels are already populated
2. Run `Mnemonica: Ψ 3D` from the Command Palette for the interactive 3D type graph (loads d3/three from CDN — needs network)
3. To watch a **running** app: `npm install && npm run start:dev` in the demo, then run `Mnemonica: Ψ App Channel` → **Discover & Connect** — Live Trace in the sidebar starts collecting; `npm run demo:load` generates instant traffic, and clicking a trace isolates it in the 3D graph

To point the extension at **your own** project instead, see Requirements below.

## Requirements

- VS Code 1.74.0 or higher
- A TypeScript project using [mnemonica](https://www.npmjs.com/package/mnemonica)
- [@mnemonica/tactica](https://www.npmjs.com/package/@mnemonica/tactica) run on that project, producing a `.tactica/` directory in the lethe 1.2 format: `hierarchy.json`, `definitions.json`, `collections.json`, `usages.json`, `flow.json`, `control.json` (the callers graph behind the Diamonds view and the 3D diamond layer, plus plugin-supplied framework points — e.g. `@mnemonica/nestjs/tactica` enabled via a `.tactica.js` config next to `tsconfig.json`); `eds.json` when `@mnemonica/dive` is a dependency. Every file is validated against its `@mnemonica/lethe` schema at load — an invalid or older file is skipped with a logged warning, never a crash
- For the live views: a running app emitting dive traces — [`@mnemonica/otel`](https://www.npmjs.com/package/@mnemonica/otel) wires the lifecycle (`attachHooks`), and for the direct App Channel connection the app hosts [`@mnemonica/strategy`](https://www.npmjs.com/package/@mnemonica/strategy)'s channel via `startStrategyClient()`

## Usage

1. Open a project with a `.tactica/` directory
2. Open the Mnemonica activity bar container (Ψ)
3. Browse the Live Trace, Usages, Types, Flow, By Generation, Diamonds, and Bagels views
4. Run `Mnemonica: Ψ 3D` for the interactive 3D type graph (needs network access — the panel loads d3/three from CDN)

Navigation conventions:
- **Definitions** items jump to the original `define()` call
- Right-click any item for cross-navigation: Open Definition / Show Usages / Show Flows
- **Flow** entries and **By Generation** nodes jump to their call/define site on click

## Commands

| Command | Description |
|---------|-------------|
| `Mnemonica: Ψ 3D` | Open the interactive 3D type graph |
| `Mnemonica: Ψ 3D in VR (browser + WebXR)` | Open the active 3D graph in the browser for a WebXR headset |
| `Mnemonica: Ψ Strategy MCP` | Spawn and watch the `@mnemonica/strategy` MCP server |
| `Mnemonica: Ψ App Channel` | Connect directly to a running app's embedded strategy WS channel |
| `Mnemonica: Refresh Type Graph` | Reload all `.tactica` data and refresh every view |
| `Mnemonica: Refresh Tree View` | Reload the Definitions/Types tree |
| `Mnemonica: Refresh By Generation` | Rebuild the By Generation view |
| `Mnemonica: Show Tree View` | Focus the Types view |
| `Mnemonica: Select Workspace` | Load a different workspace containing `.tactica/` |
| `Mnemonica: Show Logger` | Open the Mnemonica Logger output channel |
| `Mnemonica: Show Strategy MCP Status` | Show the Strategy server status |

## Code Navigation (Go to Definition)

Mnemonica Graphica provides intelligent **Ctrl+Click** (Go to Definition) support for navigating your mnemonica codebase:

### Root Types (e.g., `RootAsync`)
When you Ctrl+Click on a root type name inside `lookup()` string literal:
- **Direct jump to definition** - VS Code navigates to the `define('RootAsync', ...)` call
- Shows the exact line where the type is originally defined

Example:
```typescript
const RootAsync = lookup('RootAsync');
//                    ^ Ctrl+Click here jumps to:
// define('RootAsync', async function (this: RootAsync, data: { value: number }) { ... }
```

### Nested Types (e.g., `RootAsync.ResultFromDecorate`)
When dealing with chained/nested type definitions:
- **Multi-location peek view** - VS Code shows "Definitions (N)" with all relevant locations:
  1. The original `define()` call in your entity file
  2. The type usage in controllers/services
  3. The `lookup()` registration
- Choose which location to navigate to

Example:
```typescript
// In async.entity.ts:
define('RootAsync', async function (this: RootAsync, data: { value: number }) {
    // ...
}).define('ResultFromDecorate', async function (this: ResultFromDecorate, data: { result: string }) {
//      ^ Ctrl+Click on 'ResultFromDecorate' shows locations in async.entity.ts, async.controller.ts, registry.ts
```

### Navigation Mechanics

The extension tracks type definitions through:
1. **`definitions.json`** - Generated by tactica, stores exact file:line:column locations
2. **`lookup()` tracking** - Analyzes variable assignments from `lookup()` calls

This creates a **bidirectional navigation** system:
- Usage → Definition (via lookup tracking)
- Type Reference → Source (via definitions.json)

### Sidebar Clicks and the 3D Graph

Clicking a type in the sidebar (Types or By Generation panels) behaves
depending on whether the 3D graph is on screen:

- **3D graph open and visible** — an animated focus runs. If the clicked
  type is already on screen and unoccluded, the camera keeps its
  orientation and only re-centers/zooms (rotation would just hide
  details). Otherwise the camera first rotates so the clicked type's
  chain spreads across the frame (the view sits ~80° off the chain axis,
  so branch nodes never stack behind each other), then zooms in — and
  the sweep prefers angles where the focused sphere is the nearest one,
  so its label reads as the biggest caption in frame. The zoom adapts
  to the node's neighborhood — parent, siblings, and children stay in
  frame (only a truly isolated node fills the view alone). The focused
  node keeps a pulsing gold glow until you click the background or focus
  another node. Node labels always draw on top of the spheres, on manual
  rotations too. No file is opened.
- **3D graph closed or hidden** — the click jumps to the type's source
  location, as before.

## Watching a running app

Mnemographica is also the live observability surface of the ecosystem — the place where a running mnemonica application becomes visible:

- **Live Trace** (the top sidebar pane) collects the dive-trace stream: recent traces grouped by root name and shape, errored ones in red, newest first. Clicking a trace isolates it in the 3D graph — the whole lineage glows acid-green, errored steps red — and traces carrying an OTEL `traceId` can jump to Jaeger. The trace ring is single-source: a `source: …` header row shows which process feeds it. `self:<pid>` is the extension itself — mnemographica instruments its own mnemonica models with dive, so you can watch the extension think while it works.
- **Ψ App Channel** connects directly to a running application's embedded strategy WS channel: discovery via `GET http://127.0.0.1:3000/strategy/channel` (configurable) or manual host/port/token, then `traceSubscribe` streams edges in — no CDP, no debugger, no MCP server in the middle.
- **Ψ Strategy MCP** spawns the [`@mnemonica/strategy`](https://www.npmjs.com/package/@mnemonica/strategy) server as a child process and mirrors its log socket into the panel.

The app side of the story: [`@mnemonica/otel`](https://www.npmjs.com/package/@mnemonica/otel) wires mnemonica's lifecycle hooks to dive (`attachHooks`), [`@mnemonica/nestjs`](https://www.npmjs.com/package/@mnemonica/nestjs) carries the NestJS seams, and [the adapter's dive-trace-chain doc](https://github.com/mythographica/nestjs/blob/main/docs/dive-trace-chain.md) maps how one construction becomes a Jaeger span — and how each link of that chain is drawn in the 3D scene. The runtime underneath it all: [mnemonica](https://github.com/wentout/mnemonica) (manual: [FOR_HUMANS.md](https://github.com/wentout/mnemonica/blob/master/FOR_HUMANS.md)); the live-craft mode (define and swap constructors without a restart): [strategy/docs/live-craft.md](https://github.com/mythographica/strategy/blob/main/docs/live-craft.md).

## How It Works

Mnemonica Graphica loads your project's `.tactica/` artifacts (generated by tactica) into mnemonica model instances via a Registry controller: hierarchy and structure from `hierarchy.json`, properties from `definitions.json` `fields`, plus usages, EDS, flow and the control.json callers graph. Every contract file is schema-validated at load. Tree views and navigation providers read from those models, and everything refreshes when the underlying files change. The extension is itself built from mnemonica types — the graph can draw the tool drawing itself.

All type identity is keyed by dot-joined full path (e.g. `Scene2D.GraphNode2D`), which is what makes the views join cleanly with definitions, usages, and flow data.

## Development

```bash
npm install
npm run compile   # tactica:generate + tsc
npm test          # compile + lint + node test suites
# Press F5 to launch extension host
```

## License

MIT
