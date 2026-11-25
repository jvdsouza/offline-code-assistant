import ts from "typescript";
import { config } from "../config.js";

export interface Chunk {
  path: string;
  language: string;
  /** e.g. function, class, method, interface, type, enum, variable, module, text */
  kind: string;
  /** Symbol name, possibly qualified (`MyClass.method`). Empty for anonymous/module chunks. */
  symbol: string;
  startLine: number; // 1-based, inclusive
  endLine: number;
  text: string;
}

const TS_LIKE = /\.(c|m)?(t|j)sx?$/;

export function languageFor(path: string): string {
  if (/\.(c|m)?tsx?$/.test(path)) return "typescript";
  if (/\.(c|m)?jsx?$/.test(path)) return "javascript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  return "text";
}

export function chunkFile(path: string, text: string, maxChars = config.ingest.maxChunkChars): Chunk[] {
  if (TS_LIKE.test(path)) {
    try {
      return chunkTypeScript(path, text, maxChars);
    } catch {
      /* fall through to line chunking on parser failure */
    }
  }
  return chunkByLines(path, text, maxChars, "text", "", 1);
}

/**
 * AST-aware chunking: one chunk per top-level declaration. Large classes are
 * split per member; consecutive small statements (imports, tiny consts) are
 * grouped into "module" chunks. Leading JSDoc/comments stay with their node.
 */
export function chunkTypeScript(path: string, text: string, maxChars: number): Chunk[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const language = languageFor(path);
  const chunks: Chunk[] = [];
  let pending: ts.Statement[] = [];

  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  // getFullStart includes leading trivia (comments); trim leading blank lines.
  const startOf = (n: ts.Node) => {
    const full = n.getFullStart();
    const lead = text.slice(full, n.getStart(sf));
    const firstNonWs = lead.search(/\S/);
    return firstNonWs === -1 ? n.getStart(sf) : full + firstNonWs;
  };

  const make = (kind: string, symbol: string, from: number, to: number): Chunk => ({
    path,
    language,
    kind,
    symbol,
    startLine: lineOf(from),
    endLine: lineOf(to),
    text: text.slice(from, to),
  });

  const flushPending = () => {
    if (!pending.length) return;
    const from = startOf(pending[0]);
    const to = pending[pending.length - 1].getEnd();
    const c = make("module", "", from, to);
    chunks.push(...splitIfLarge(c, maxChars));
    pending = [];
  };

  for (const stmt of sf.statements) {
    const info = describe(stmt);
    if (!info) {
      pending.push(stmt);
      const size = pending[pending.length - 1].getEnd() - startOf(pending[0]);
      if (size > maxChars) flushPending();
      continue;
    }
    flushPending();

    const from = startOf(stmt);
    const to = stmt.getEnd();

    if (ts.isClassDeclaration(stmt) && to - from > maxChars) {
      chunks.push(...chunkClass(stmt, info.symbol));
    } else {
      chunks.push(...splitIfLarge(make(info.kind, info.symbol, from, to), maxChars));
    }
  }
  flushPending();
  return chunks;

  function chunkClass(cls: ts.ClassDeclaration, className: string): Chunk[] {
    // Header = everything up to the opening brace, so each member chunk knows its class.
    const header = text.slice(startOf(cls), cls.members.pos).trimEnd();
    const out: Chunk[] = [];
    for (const m of cls.members) {
      const name = m.name && ts.isIdentifier(m.name) ? m.name.text : m.name?.getText(sf) ?? "constructor";
      const kind = ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) ? "method" : "member";
      const c = make(kind, `${className}.${name}`, startOf(m), m.getEnd());
      c.text = `${header}\n  // ...\n  ${c.text}\n}`;
      out.push(...splitIfLarge(c, maxChars));
    }
    return out.length ? out : [make("class", className, startOf(cls), cls.getEnd())];
  }
}

function describe(stmt: ts.Statement): { kind: string; symbol: string } | null {
  if (ts.isFunctionDeclaration(stmt)) return { kind: "function", symbol: stmt.name?.text ?? "default" };
  if (ts.isClassDeclaration(stmt)) return { kind: "class", symbol: stmt.name?.text ?? "default" };
  if (ts.isInterfaceDeclaration(stmt)) return { kind: "interface", symbol: stmt.name.text };
  if (ts.isTypeAliasDeclaration(stmt)) return { kind: "type", symbol: stmt.name.text };
  if (ts.isEnumDeclaration(stmt)) return { kind: "enum", symbol: stmt.name.text };
  if (ts.isModuleDeclaration(stmt)) return { kind: "namespace", symbol: stmt.name.getText() };
  if (ts.isVariableStatement(stmt)) {
    const decls = stmt.declarationList.declarations;
    // Only treat as its own chunk if it's "substantial" (functions, objects, etc.).
    const substantial = decls.some(
      (d) =>
        d.initializer &&
        (ts.isArrowFunction(d.initializer) ||
          ts.isFunctionExpression(d.initializer) ||
          ts.isObjectLiteralExpression(d.initializer) ||
          ts.isCallExpression(d.initializer) ||
          ts.isClassExpression(d.initializer)),
    );
    if (!substantial) return null;
    const fn = decls.some((d) => d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)));
    return { kind: fn ? "function" : "variable", symbol: decls.map((d) => d.name.getText()).join(", ") };
  }
  if (ts.isExportAssignment(stmt)) return { kind: "export", symbol: "default" };
  return null;
}

function splitIfLarge(c: Chunk, maxChars: number): Chunk[] {
  if (c.text.length <= maxChars) return [c];
  return chunkByLines(c.path, c.text, maxChars, c.kind, c.symbol, c.startLine, c.language);
}

/** Fallback: fixed windows of lines with a small overlap. */
export function chunkByLines(
  path: string,
  text: string,
  maxChars: number,
  kind = "text",
  symbol = "",
  firstLine = 1,
  language = languageFor(path),
): Chunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: Chunk[] = [];
  const overlap = 3;
  let i = 0;
  while (i < lines.length) {
    let size = 0;
    let j = i;
    while (j < lines.length && (size + lines[j].length + 1 <= maxChars || j === i)) {
      size += lines[j].length + 1;
      j++;
    }
    const body = lines.slice(i, j).join("\n");
    if (body.trim()) {
      chunks.push({ path, language, kind, symbol, startLine: firstLine + i, endLine: firstLine + j - 1, text: body });
    }
    if (j >= lines.length) break;
    i = Math.max(j - overlap, i + 1);
  }
  return chunks;
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(c|m)?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** The text that actually gets embedded: a small header gives the model location context. */
export function embeddingText(c: Chunk): string {
  const head = `File: ${c.path}${c.symbol ? `\nSymbol: ${c.kind} ${c.symbol}` : ""}\n`;
  return head + c.text;
}
