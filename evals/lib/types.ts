/** A chunk counts as relevant if it matches ANY expectation in a case's `expect` list. */
export interface ChunkExpectation {
  /** Repo-relative path, e.g. "src/auth/password.ts". */
  path: string;
  /**
   * Symbol as the chunker names it ("hashPassword", "TokenBucket.take").
   * "Cls.method" also matches a whole-class chunk "Cls" and vice versa,
   * so cases survive changes to how large classes are split.
   */
  symbol?: string;
  /** Substring the chunk text must contain. */
  contains?: string;
}

export type RetrievalCategory = "semantic" | "identifier" | "docs" | "cross-file";

export interface RetrievalCase {
  id: string;
  category: RetrievalCategory;
  query: string;
  expect: ChunkExpectation[];
}

/** Rule checks for a final answer. Patterns are case-insensitive regular expressions. */
export interface AnswerRules {
  /** Every pattern must match. */
  mustInclude?: string[];
  /** No pattern may match. */
  mustNotInclude?: string[];
  /** At least one of these paths (or its file name) must be mentioned. */
  citeAnyOf?: string[];
}

export interface AnswerCase {
  id: string;
  question: string;
  rules: AnswerRules;
  /** Ground truth for the optional LLM judge. */
  reference: string;
}

export interface EditCheck {
  /** File the edit should change, repo-relative. */
  path: string;
  /** Case-sensitive patterns the edited file must match. */
  mustMatch: string[];
  /** Case-sensitive patterns the edited file must NOT match. */
  mustNotMatch?: string[];
}

export interface AgentCase {
  id: string;
  task: string;
  /** Tools that must be called at least once. */
  mustCall?: string[];
  /** Tools that must not be called. */
  mustNotCall?: string[];
  /** Upper bound on total tool calls (efficiency). */
  maxToolCalls?: number;
  answer?: AnswerRules;
  /** Runs in a throwaway copy of the fixture with edits auto-approved, then checks the file. */
  edit?: EditCheck;
}

export interface AgentRun {
  toolCalls: string[];
  answer: string;
  /** True if the agent hit the step limit. */
  stopped: boolean;
  /** Content of `edit.path` after the run (edit cases only); null if the file is missing. */
  editedFile?: string | null;
  originalFile?: string | null;
}

export interface Check {
  pass: boolean;
  failures: string[];
}
