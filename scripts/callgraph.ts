/**
 * Call-graph extractor for this repository.
 *
 *   npm run callgraph            -> docs/callgraph.{json,md,html}
 *
 * Uses the TypeScript type checker (not regex), so calls through properties and
 * parameters (`this.store.search()`, `ctx.retriever.retrieve()`) resolve to the
 * real declaration. Nodes are classes' methods and standalone functions; edges
 * are calls (or functions passed by reference, e.g. `.map(embeddingText)`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type NodeKind = "function" | "method" | "tool" | "cli" | "module" | "external";

export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  /** Class name for methods, file path for functions, "libraries" / "node built-ins" for externals. */
  group: string;
  layer: string;
  file?: string;
  line?: number;
  exported?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  count: number;
  lines: number[];
  /** Resolved through an interface (dynamic dispatch), not a direct call. */
  dynamic?: boolean;
}

export interface CallGraph {
  generatedAt: string;
  layers: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  limitations: string[];
}

/** Architecture layers, left → right in the diagram. First matching rule wins. */
const LAYER_RULES: [RegExp, string][] = [
  [/^src\/cli\.ts$/, "CLI"],
  [/^src\/agent\/tools\//, "Tools"],
  [/^src\/agent\//, "Agent"],
  [/^src\/retrieval\//, "Retrieval"],
  [/^src\/ingest\/indexer\.ts$/, "Index"],
  [/^src\/ingest\//, "Ingest"],
  [/^src\/(store|llm)\//, "Store & LLM"],
  [/^src\//, "Utilities"],
];
const LAYERS = ["CLI", "Agent", "Tools", "Retrieval", "Index", "Ingest", "Store & LLM", "Utilities", "External"];

/** Interface methods whose implementations are known: `iface.member` -> predicate on nodes. */
const DYNAMIC_DISPATCH: Record<string, (n: GraphNode) => boolean> = {
  "AgentTool.run": (n) => n.kind === "tool",
};

export function extractCallGraph(tsconfigPath: string): CallGraph {
  const configPath = path.resolve(tsconfigPath);
  const root = path.dirname(configPath);
  const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
  if (cfg.error) throw new Error(ts.flattenDiagnosticMessageText(cfg.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();

  const norm = (f: string) => path.resolve(f).toLowerCase();
  const projectFiles = new Set(parsed.fileNames.map(norm));
  const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
  const layerOf = (file: string) => LAYER_RULES.find(([re]) => re.test(file))?.[1] ?? "Utilities";

  const nodes = new Map<string, GraphNode>();
  const declToId = new Map<ts.Node, string>();
  const regions: { id: string; node: ts.Node }[] = [];
  const regionRoots = new Set<ts.Node>();
  const limitations = new Set<string>();
  const pendingModules = new Map<string, Omit<GraphNode, "id">>();

  const addNode = (n: Omit<GraphNode, "id"> & { id?: string }): string => {
    let id = n.id ?? n.label;
    if (nodes.has(id) && nodes.get(id)!.file !== n.file) id = `${n.file}:${n.label}`;
    if (!nodes.has(id)) nodes.set(id, { ...n, id });
    return id;
  };
  const addRegion = (id: string, node: ts.Node) => {
    regions.push({ id, node });
    regionRoots.add(node);
  };
  const isExported = (n: ts.Node) =>
    !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));

  const sources = program.getSourceFiles().filter((sf) => !sf.isDeclarationFile && projectFiles.has(norm(sf.fileName)));

  // ---------------------------------------------------------------- nodes
  for (const sf of sources) {
    const file = rel(sf.fileName);
    const layer = layerOf(file);
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const moduleStmts: ts.Statement[] = [];

    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        const id = addNode({ label: stmt.name.text, kind: "function", group: file, layer, file, line: lineOf(stmt), exported: isExported(stmt) });
        declToId.set(stmt, id);
        addRegion(id, stmt);
      } else if (ts.isClassDeclaration(stmt) && stmt.name) {
        const cls = stmt.name.text;
        let ctorId: string | undefined;
        for (const m of stmt.members) {
          const isCtor = ts.isConstructorDeclaration(m);
          if (!isCtor && !ts.isMethodDeclaration(m)) continue;
          const name = isCtor ? "constructor" : m.name.getText(sf);
          const id = addNode({ id: `${cls}.${name}`, label: `${cls}.${name}`, kind: "method", group: cls, layer, file, line: lineOf(m), exported: isExported(stmt) });
          declToId.set(m, id);
          addRegion(id, m);
          if (isCtor) ctorId = id;
        }
        ctorId ??= addNode({ id: `${cls}.constructor`, label: `${cls}.constructor`, kind: "method", group: cls, layer, file, line: lineOf(stmt), exported: isExported(stmt) });
        declToId.set(stmt, ctorId); // `new Cls()` -> constructor
      } else if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          const init = d.initializer;
          if (!init || !ts.isIdentifier(d.name)) continue;
          const name = d.name.text;
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            const id = addNode({ label: name, kind: "function", group: file, layer, file, line: lineOf(d), exported: isExported(stmt) });
            declToId.set(d, id);
            addRegion(id, init);
          } else if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "defineTool") {
            const first = init.arguments[0];
            const label = first && ts.isStringLiteral(first) ? first.text : name;
            const id = addNode({ id: label, label, kind: "tool", group: file, layer, file, line: lineOf(d), exported: isExported(stmt) });
            declToId.set(d, id);
            addRegion(id, init);
          } else if (!moduleStmts.includes(stmt)) {
            moduleStmts.push(stmt);
          }
        }
      } else if (!ts.isInterfaceDeclaration(stmt) && !ts.isTypeAliasDeclaration(stmt) && !ts.isImportDeclaration(stmt)) {
        moduleStmts.push(stmt);
      }
    }

    // CLI: program.command("x")....action(fn) -> synthetic node "cli x" owning fn.
    for (const stmt of moduleStmts) {
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "action") {
          const cmd = findCommandName(n.expression.expression);
          const fn = n.arguments[0];
          if (cmd && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
            const id = addNode({ id: `cli ${cmd}`, label: `cli ${cmd}`, kind: "cli", group: file, layer, file, line: lineOf(n.expression.name) });
            addRegion(id, fn);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(stmt);
    }

    // Remaining top-level code that makes calls belongs to "<file> (module)".
    if (moduleStmts.length) {
      const id = `${file} (module)`;
      for (const s of moduleStmts) regions.push({ id, node: s }); // not a region root: nested regions are skipped by them
      pendingModules.set(id, { label: id, kind: "module", group: file, layer, file, line: lineOf(moduleStmts[0]) });
    }
  }

  // ---------------------------------------------------------------- edges
  const edges = new Map<string, GraphEdge>();
  const addEdge = (from: string, to: string, line: number, dynamic = false) => {
    const key = `${from}->${to}`;
    const e = edges.get(key) ?? { from, to, count: 0, lines: [], ...(dynamic ? { dynamic } : {}) };
    e.count++;
    if (!e.lines.includes(line)) e.lines.push(line);
    edges.set(key, e);
  };

  const externalNode = (decl: ts.Declaration, ref: ts.Node): string | null => {
    const sf = decl.getSourceFile();
    if (program.isSourceFileDefaultLibrary(sf)) return null; // Array.map, JSON.parse, ...
    const f = sf.fileName.replace(/\\/g, "/");
    const builtin = f.match(/\/node_modules\/@types\/node\/(?:ts[\d.]+\/)?([^/.]+)/);
    if (builtin) {
      // `process.stdout.write` is declared on net.Socket; attribute it to the global it's reached through.
      const label = leftmostIdentifier(ref) === "process" ? "node:process" : `node:${builtin[1]}`;
      return addNode({ id: label, label, kind: "external", group: "node built-ins", layer: "External" });
    }
    const pkg = f.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (pkg) return addNode({ id: pkg[1], label: pkg[1], kind: "external", group: "libraries", layer: "External" });
    return null;
  };

  const resolveTargets = (ref: ts.Node, owner: ts.Node): { ids: string[]; dynamic: boolean } | null => {
    let sym = checker.getSymbolAtLocation(ref);
    if (!sym) return null;
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!decl) return null;

    const direct = declToId.get(decl);
    if (direct) return { ids: [direct], dynamic: false };

    const dsf = decl.getSourceFile();
    if (projectFiles.has(norm(dsf.fileName))) {
      // Nested helper inside the same node (folded into it) -> not an edge.
      if (dsf === owner.getSourceFile() && decl.pos >= owner.pos && decl.end <= owner.end) return null;
      const parent = decl.parent;
      const memberName = (decl as ts.NamedDeclaration).name;
      if ((ts.isInterfaceDeclaration(parent) || ts.isTypeLiteralNode(parent)) && memberName) {
        const ifaceName = ts.isInterfaceDeclaration(parent) ? parent.name.text : "(type literal)";
        const key = `${ifaceName}.${memberName.getText(dsf)}`;
        const pick = DYNAMIC_DISPATCH[key];
        if (pick) return { ids: [...nodes.values()].filter(pick).map((n) => n.id), dynamic: true };
        limitations.add(`Callback \`${key}\` is called through an interface and is not resolved to an implementation.`);
      }
      return null;
    }
    const ext = externalNode(decl, ref);
    return ext ? { ids: [ext], dynamic: false } : null;
  };

  for (const { id, node } of regions) {
    const sf = node.getSourceFile();
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const record = (ref: ts.Node, at: ts.Node) => {
      const t = resolveTargets(ref, node);
      if (!t) return;
      if (t.ids.length) ensureModule(id);
      for (const to of t.ids) if (to !== id) addEdge(id, to, lineOf(at), t.dynamic);
    };

    const visit = (n: ts.Node): void => {
      if (n !== node && regionRoots.has(n)) return; // owned by another node
      if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.expression.kind !== ts.SyntaxKind.SuperKeyword) {
        const callee = n.expression;
        const ref = ts.isPropertyAccessExpression(callee) ? callee.name : ts.isIdentifier(callee) ? callee : null;
        if (ref) record(ref, n);
        // Functions passed by reference: arr.map(embeddingText)
        for (const a of n.arguments ?? []) {
          const r = ts.isIdentifier(a) ? a : ts.isPropertyAccessExpression(a) ? a.name : null;
          if (r && isProjectFunctionRef(r)) record(r, a);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  }

  // Drop module nodes that never call anything.
  const nodeList = [...nodes.values()].filter((n) => n.kind !== "module" || [...edges.values()].some((e) => e.from === n.id));
  const sortedNodes = nodeList.sort(
    (a, b) => LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer) || a.group.localeCompare(b.group) || (a.line ?? 0) - (b.line ?? 0) || a.label.localeCompare(b.label),
  );
  const edgeList = [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  for (const e of edgeList) e.lines.sort((a, b) => a - b);

  return {
    generatedAt: new Date().toISOString(),
    layers: LAYERS.filter((l) => sortedNodes.some((n) => n.layer === l)),
    nodes: sortedNodes,
    edges: edgeList,
    limitations: [
      "Nested helper functions (e.g. `walk` inside `walkRepo`, `chunkClass` inside `chunkTypeScript`) are folded into their enclosing node.",
      "Calls into the JavaScript/DOM standard library (Array, JSON, Promise, console, …) are omitted.",
      "Calls into Node built-ins are grouped by module (e.g. `fs.readFile` → node:fs, `process.stdout.write` → node:process).",
      ...[...limitations].sort(),
    ],
  };

  function isProjectFunctionRef(r: ts.Node): boolean {
    let sym = checker.getSymbolAtLocation(r);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const decl = sym?.valueDeclaration;
    return !!decl && declToId.has(decl);
  }

  function ensureModule(id: string) {
    const pending = pendingModules.get(id);
    if (pending && !nodes.has(id)) nodes.set(id, { ...pending, id });
  }
}

/** For `a.b.c` given the `c` name node, returns "a". */
function leftmostIdentifier(ref: ts.Node): string | null {
  let cur: ts.Node = ts.isPropertyAccessExpression(ref.parent) && ref.parent.name === ref ? ref.parent : ref;
  while (ts.isPropertyAccessExpression(cur) || ts.isCallExpression(cur)) cur = cur.expression;
  return ts.isIdentifier(cur) ? cur.text : null;
}

/** Walks `a.command("x").description(...).option(...)` back to "x". */
function findCommandName(expr: ts.Expression): string | null {
  let cur: ts.Expression = expr;
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    if (cur.expression.name.text === "command" && cur.arguments[0] && ts.isStringLiteral(cur.arguments[0])) {
      return cur.arguments[0].text;
    }
    cur = cur.expression.expression;
  }
  return null;
}

// -------------------------------------------------------------------- outputs

export function toMarkdown(g: CallGraph): string {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out = (id: string) => g.edges.filter((e) => e.from === id);
  const inc = (id: string) => g.edges.filter((e) => e.to === id);
  const fmt = (ids: string[], dyn: Set<string>) =>
    ids.length ? ids.map((i) => `\`${byId.get(i)?.label ?? i}\`${dyn.has(i) ? "*" : ""}`).join(", ") : "—";

  const lines: string[] = [
    "# Call graph",
    "",
    `Generated by \`npm run callgraph\` on ${g.generatedAt}. ` +
      `${g.nodes.filter((n) => n.kind !== "external").length} project nodes, ` +
      `${g.nodes.filter((n) => n.kind === "external").length} external nodes, ${g.edges.length} edges.`,
    "",
    "`*` marks dynamic dispatch (resolved through an interface, e.g. the agent calling `tool.run`).",
    "Open `callgraph.html` for the interactive diagram.",
    "",
  ];

  for (const layer of g.layers) {
    lines.push(`## ${layer}`, "");
    const groups = [...new Set(g.nodes.filter((n) => n.layer === layer).map((n) => n.group))];
    for (const group of groups) {
      const members = g.nodes.filter((n) => n.layer === layer && n.group === group);
      const isClass = members.every((m) => m.kind === "method");
      lines.push(`### ${isClass ? `class \`${group}\`` : `\`${group}\``}`, "");
      if (layer === "External") {
        lines.push("| Node | Called by |", "|---|---|");
        for (const n of members) lines.push(`| \`${n.label}\` | ${fmt(inc(n.id).map((e) => e.from), new Set())} |`);
      } else {
        lines.push("| Node | Kind | Location | Calls | Called by |", "|---|---|---|---|---|");
        for (const n of members) {
          const o = out(n.id);
          const i = inc(n.id);
          lines.push(
            `| \`${n.label}\` | ${n.kind} | \`${n.file}:${n.line}\` | ` +
              `${fmt(o.map((e) => e.to), new Set(o.filter((e) => e.dynamic).map((e) => e.to)))} | ` +
              `${fmt(i.map((e) => e.from), new Set(i.filter((e) => e.dynamic).map((e) => e.from)))} |`,
          );
        }
      }
      lines.push("");
    }
  }
  lines.push("## Limitations", "", ...g.limitations.map((l) => `- ${l}`), "");
  return lines.join("\n");
}

/**
 * Embeds the graph into the page template. `standalone` wraps it in a full HTML
 * document for opening locally; without it you get the fragment that the
 * artifact publisher wraps itself.
 */
export function toHtml(g: CallGraph, template: string, standalone = true): string {
  const json = JSON.stringify(g).replace(/</g, "\\u003c");
  const page = template.replace("/*__GRAPH_DATA__*/ null", () => json);
  if (!standalone) return page;
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n' +
    page +
    "\n</body>\n</html>\n"
  );
}

// ------------------------------------------------------------------------ CLI

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..");
  const graph = extractCallGraph(path.join(root, "tsconfig.json"));
  const outDir = path.join(root, "docs");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "callgraph.json"), JSON.stringify(graph, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "callgraph.md"), toMarkdown(graph));
  const template = fs.readFileSync(path.join(here, "callgraph.template.html"), "utf8");
  fs.writeFileSync(path.join(outDir, "callgraph.html"), toHtml(graph, template));
  // Optional: `--fragment <file>` also writes the page without the document wrapper (for publishing).
  const fragIdx = process.argv.indexOf("--fragment");
  if (fragIdx > -1 && process.argv[fragIdx + 1]) fs.writeFileSync(process.argv[fragIdx + 1], toHtml(graph, template, false));
  const ext = graph.nodes.filter((n) => n.kind === "external").length;
  console.log(
    `Call graph: ${graph.nodes.length - ext} project nodes + ${ext} external, ${graph.edges.length} edges -> docs/callgraph.{json,md,html}`,
  );
}
