// Stand-in for ace-server in tests: speaks the standard protocol when run as `standardIndex/index.js`, else the legacy one.
// usage: node <dir>/out[/standardIndex]/index.js --stdio
import { isAbsolute } from "node:path";

const standard = /standardIndex/.test(process.argv[1]);
let buffer = Buffer.alloc(0);

const send = (msg) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
};
const location = (uri, line) => ({ uri, range: { start: { line, character: 2 }, end: { line, character: 6 } } });
// Last version sent per document: definition answers on that line, so tests can see didChange arrive.
const versions = new Map();
const ANSWERS = {
  definition: (p) => location(p.textDocument.uri, versions.get(p.textDocument.uri) ?? 1),
  references: (p) => [location(p.textDocument.uri, 1), location(p.textDocument.uri, 7)],
};
// Call hierarchy around `rename` (lines 3-5): called from `build` at line 9, calls `save`.
const item = (uri, name, line) => ({ name, kind: 6, containerName: "P", uri, ...location(uri, line), selectionRange: location(uri, line).range });
const INCOMING = (uri) => [{ from: item(uri, "build", 8), fromRanges: [location(uri, 9).range] }];
const OUTGOING = (uri) => [{ to: item(uri, "save", 12), fromRanges: [location(uri, 99).range] }];

function standardMessage({ id, method, params }) {
  if (method === "initialize") {
    const o = params.initializationOptions;
    if (!o?.rootUri || !o.lspServerWorkspacePath || !o.modules?.length) return send({ id, result: { capabilities: {} } });
    send({ method: "$/progress", params: { token: "index", value: { kind: "report" } } });
    send({ id: 1000, method: "client/registerCapability", params: { registrations: [] } });
    return send({ id, result: { capabilities: { definitionProvider: true, referencesProvider: true } } });
  }
  if (method === "textDocument/didOpen" || method === "textDocument/didChange") return versions.set(params.textDocument.uri, params.textDocument.version);
  if (method === "textDocument/definition") return send({ id, result: ANSWERS.definition(params) });
  if (method === "textDocument/references") return send({ id, result: ANSWERS.references(params) });
  if (method === "textDocument/prepareCallHierarchy") return send({ id, result: [item(params.textDocument.uri, "rename", 3)] });
  if (method === "callHierarchy/incomingCalls") return send({ id, result: INCOMING(params.item.uri) });
  if (method === "callHierarchy/outgoingCalls") return send({ id, result: OUTGOING(params.item.uri) });
  if (method === "shutdown") return send({ id, result: null });
  if (method === "exit") process.exit(0);
}

// Like the real legacy server, find-usages sees open documents only.
const opened = new Set();
const LEGACY_QUERIES = {
  "aceProject/onAsyncDefinition": ANSWERS.definition,
  "aceProject/onAsyncFindUsages": () => [...opened].map((uri) => location(uri, 1)),
  // One answer for both directions; `info` nests the next level.
  "aceProject/onAsyncCallHierarchy": (p) => ({
    incoming: INCOMING(p.textDocument.uri).map((c) => ({ item: c, info: [{ item: { from: item(p.textDocument.uri, "aboutToAppear", 20), fromRanges: [] }, info: [] }] })),
    outgoing: OUTGOING(p.textDocument.uri).map((c) => ({ item: c, info: [] })),
    definition: [item(p.textDocument.uri, "rename", 3)],
  }),
};

function legacyMessage({ id, method, params }) {
  if (method === "aceProject/onAsyncDidOpen" || method === "aceProject/onAsyncDidChange") {
    versions.set(params.params.textDocument.uri, params.params.textDocument.version);
    return opened.add(params.params.textDocument.uri);
  }
  if (method === "textDocument/didClose") return opened.delete(params.textDocument.uri);
  if (method === "initialize") {
    send({ id, result: { capabilities: {} } });
    send({ method: "aceProject/onIndexingProgressUpdate", params: { done: 1, total: 2 } });
    const ok = params.initializationOptions?.completionSortSetting !== undefined && params.initializationOptions?.modules?.length > 0;
    return setTimeout(() => send({ method: "aceProject/onModuleInitFinish", params: { isSuccess: ok, isCache: false } }), 50);
  }
  if (LEGACY_QUERIES[method]) {
    // The real server reads editorFiles as file system paths.
    if (!params.editorFiles?.every((f) => isAbsolute(f) && !f.startsWith("file:"))) return;
    return send({ method, params: { requestId: params.requestId, result: LEGACY_QUERIES[method](params.params), traceId: params.traceId } });
  }
  if (method === "shutdown") return send({ id, result: null });
  if (method === "exit") process.exit(0);
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const msg = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString("utf8"));
    buffer = buffer.subarray(end + 4 + length);
    if (msg.method === undefined) continue;
    (standard ? standardMessage : legacyMessage)(msg);
  }
});
