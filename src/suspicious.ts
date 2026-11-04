import { canonicalJson } from "./canonical.js";
import { describeViolation, MAX_DEPTH, nestedDeeperThan, type ToolDefinition, type Violation } from "./manifest.js";

/*
 * Explains why a tool definition looks dangerous, with fixed rules: no model, no network, no
 * dependencies, so the same definition always gets the same explanation. A finding is a sign for
 * the person reviewing a change, not a verdict: the block itself comes from pinning. The rules
 * that make sense on free text also read the results of tool calls, which nothing blocks.
 */

export type Severity = "high" | "medium" | "low";

export interface Finding {
  /** Kebab-case id of the rule that matched. */
  rule: string;
  severity: Severity;
  /** JSON path inside the tool definition: "description", "inputSchema.properties.path.description"... */
  field: string;
  /** The fragment in quotes with invisible characters spelled out as [U+XXXX], or a short account of it. */
  snippet: string;
  /** What the sign means, in one sentence for someone who is not a security expert. */
  message: string;
}

/**
 * A rule matches with a regex (each match becomes a quoted snippet) or computes its snippets itself,
 * one at a time, so a scan that has seen enough can stop (see scanWindows).
 */
type Rule = { id: string; severity: Severity; message: string } & ({ pattern: RegExp } | { test: (text: string) => Iterable<string> });

/** Joins alternatives into one case-insensitive global regex, so each rule stays one entry of the table. */
function anyOf(...patterns: Array<RegExp | string>): RegExp {
  return new RegExp(patterns.map((pattern) => `(?:${typeof pattern === "string" ? pattern : pattern.source})`).join("|"), "gi");
}

// Tag names that models are trained or told to treat as privileged.
const TAG = /<\/?(important|system|instructions?|hidden|secret|admin|override|assistant|model|ai|rules|critical|note_to_model|prompt)(?:\s[^<>]{0,200})?\/?>/gi;

// "Do not tell the user", "without asking the user". The words in between may not turn the phrase
// around ("don't hesitate to tell the user") or start another clause ("do not show hidden files
// unless the user asks"), and a possessive is about the user's data ("never reveal the user's password").
const gap = (stop: string) => String.raw`(?:(?!\b(?:${stop})\b)[^.;:!?\n]){0,30}?`;
const HIDE_FROM_USER =
  String.raw`\b(?:do\s+not|don['’]?t|never|without|avoid|no\s+need\s+to)\b` +
  gap("forget|fail|hesitate|neglect") +
  String.raw`\b(?:tell|telling|mention|mentioning|inform|informing|notify|notifying|reveal|revealing|show|showing|disclose|disclosing|alert|alerting|ask|asking|warn|warning)\b` +
  gap("unless|if|when|until|because|before|after|while") +
  String.raw`\busers?\b(?!['’])`;

// Where credentials live: the files that MCP exfiltration attacks ask the model to read.
const SECRET = new RegExp(
  [
    String.raw`\.ssh\b`,
    String.raw`(?<![a-z0-9])id_(?:rsa|ed25519|ecdsa|dsa)(?![a-z0-9])`,
    String.raw`\b(?:authorized_keys|known_hosts)\b`,
    String.raw`\.aws\/(?:credentials|config)\b`,
    String.raw`\.(?:gnupg|netrc|npmrc|pypirc|git-credentials|bash_history|zsh_history)\b`,
    String.raw`\.docker\/config\.json\b`,
    String.raw`\.kube\/config\b`,
    String.raw`\/etc\/(?:passwd|shadow)\b`,
    String.raw`\/proc\/self\/environ\b`,
    String.raw`\bkeychains?\b`,
    String.raw`\bwallet\.dat\b`,
    String.raw`\b(?:seed|recovery)\s+phrases?\b`,
    String.raw`\bmnemonic\b`,
    String.raw`\bprivate\s+keys?\b`,
    String.raw`(?<![a-z0-9])(?:credentials|secrets)\.json\b`,
  ].join("|"),
  "gi",
);

// A .env file by name (.env, .env.local, .env.production), not process.env or "environment".
const ENV_FILE = /(?<![\w$.-])\.env(?:\.[\w-]+)*(?![\w-])/gi;

// Trailing punctuation belongs to the sentence, not to the address.
const LINK = /\bhttps?:\/\/[^\s'"`<>]+(?<![.,;:!?)\]}])/gi;
// Media type and parameters cannot contain ":", so one attempt never runs into the next "data:":
// with [^\s,;]* there, a megabyte of "data:a;" took minutes to scan.
const DATA_URI = /\bdata:[\w.+\/-]{0,100}(?:;[\w.+=-]{0,100}){0,10};base64,[A-Za-z0-9+/=]*/gi;
const EMAIL = /(?<![\w.%+-])[\w.%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi;
const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
// A dotted quad on its own, not the middle of a version number like 1.2.3.4.5.
const IPV4 = new RegExp(String.raw`(?<![\w.])${OCTET}(?:\.${OCTET}){3}(?![\w.]*\w)`, "g");

// U+200D also joins emoji (woman, U+200D, laptop is one emoji): a joiner between two emoji hides nothing.
const INVISIBLE =
  /(?:[\u{200B}\u{200C}\u{2060}-\u{2064}\u{FEFF}\u{180E}\xAD]|(?<!\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]?)\u{200D}|\u{200D}(?!\p{Extended_Pictographic}))+/gu;
const TAGS = /[\u{E0000}-\u{E007F}]+/gu;
// A direction control, with the text it reorders when the closing control follows soon after.
const BIDI =
  /[\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200E}\u{200F}\u{061C}](?:[^\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200E}\u{200F}\u{061C}\n]{0,40}[\u{202C}\u{2069}])?/gu;
// One U+FE0F after an emoji is normal; three or more selectors in a row can encode bytes.
const SELECTORS = /[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]{3,}/gu;

// Another tool or server by name; "this", "the", "a"... mean the tool is talking about itself.
const OTHER = String.raw`(?:the\s+)?(?!(?:this|that|the|a|an|any|another|other|each|every|your)\b)[\w.-]+`;

const RULES: Rule[] = [
  { id: "hidden-tag", severity: "high", test: hiddenTags, message: "a tag that hides instructions for the model" },
  { id: "html-comment", severity: "medium", pattern: /<!--[\s\S]*?(?:-->|$)/g, message: "a comment: hidden when the text is rendered, read by the model" },
  {
    id: "override-instruction",
    severity: "high",
    pattern: anyOf(
      /\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the|your|of)\s+){0,3}(?:previous|prior|above|earlier|other|system)\s+(?:instructions?|rules?|messages?|prompts?|guidelines?|context)\b/,
      /\byou\s+are\s+now\b/,
      /\bnew\s+instructions?\s*:/,
      /\bsystem\s+prompt\s*:/,
    ),
    message: "tries to replace the instructions the model already has",
  },
  {
    id: "conceal-from-user",
    severity: "high",
    pattern: anyOf(
      HIDE_FROM_USER,
      /\bthe\s+user\s+(?:(?:must|should|does|will|needs?)\s+not|mustn['’]t|shouldn['’]t|doesn['’]t|won['’]t|needn['’]t)\s+(?:(?:need|have)\s+to\s+)?(?:know|see|be\s+told|notice|be\s+informed)\b/,
      /\bkeep\s+(?:this|it|that)\s+(?:a\s+)?(?:secret|hidden|private|confidential)\b/,
      /\b(?:hide|conceal)\s+(?:this|it|that)\s+from\s+the\s+users?\b/,
    ),
    message: "asks the model to hide something from you",
  },
  {
    id: "before-using",
    severity: "medium",
    pattern: anyOf(
      /\b(?:before|prior\s+to|when|whenever|each\s+time|every\s+time|after|while)\s+(?:using|calling|invoking|running|executing)\s+(?:this|the|any|a)\s+tool\b/,
      /\b(?:before|whenever|each\s+time|every\s+time)\s+(?:you\s+)?(?:call|use|invoke|run)\s+(?:this|the|any)\s+tool\b/,
      /\bas\s+a\s+(?:prerequisite|precondition)\b/,
    ),
    message: "adds an action to every call of this tool",
  },
  { id: "sensitive-path", severity: "high", test: pathsAround(SECRET), message: "points at a secret file" },
  { id: "env-file", severity: "medium", test: pathsAround(ENV_FILE), message: "points at a file that usually holds passwords and keys" },
  { id: "url", severity: "low", pattern: LINK, message: "a web address the model could be sent to" },
  { id: "ip-address", severity: "medium", pattern: IPV4, message: "a raw IP address, a common destination for stolen data" },
  { id: "data-uri", severity: "medium", pattern: DATA_URI, message: "encoded content that you cannot read but the model can" },
  { id: "base64-blob", severity: "medium", test: base64Blobs, message: "a long encoded string that can hide text from you" },
  { id: "email-address", severity: "low", pattern: EMAIL, message: "an email address that mail could be redirected to" },
  { id: "invisible-chars", severity: "high", pattern: INVISIBLE, message: "invisible characters that can hide text from you" },
  { id: "unicode-tags", severity: "high", test: tagText, message: "invisible characters that spell out hidden text for the model" },
  { id: "bidi-control", severity: "high", pattern: BIDI, message: "characters that reorder text, so you may read something other than the model" },
  { id: "variation-selectors", severity: "high", pattern: SELECTORS, message: "a run of invisible characters that can smuggle hidden data" },
  {
    id: "cross-tool-order",
    severity: "medium",
    pattern: anyOf(
      String.raw`\b(?:use|call|invoke|run|prefer|chain)\s+${OTHER}\s+(?:tool|server|mcp\s+server)\b`,
      String.raw`\binstead\s+of\s+${OTHER}\s+(?:tool|server)\b`,
      String.raw`\b(?:when|whenever|if|after|before)\s+${OTHER}\s+(?:tool|server)\s+is\s+(?:called|used|invoked)\b`,
      /\b(?:do\s+not|don['’]?t|never)\s+use\s+(?:the\s+)?other\s+(?:tools|servers)\b/,
    ),
    message: "tells the model what to do with other tools or servers",
  },
  { id: "padding", severity: "low", test: blankRuns, message: "a long blank stretch that can push text out of view" },
];

/** Each tag name once per text: <IMPORTANT>...</IMPORTANT> is one hidden block, not two signs. */
function hiddenTags(text: string): string[] {
  const byName = new Map<string, string>();
  for (const match of text.matchAll(TAG)) {
    const name = match[1]!.toLowerCase();
    if (!byName.has(name)) byName.set(name, quote(match[0]));
  }
  return [...byName.values()];
}

const PATH_CHAR = /[^\s'"`<>()[\]{}|,;]/;

/** Widens each match to the path around it, so "~/.ssh/id_rsa" is reported once and in full. */
function pathsAround(marker: RegExp): (text: string) => Iterable<string> {
  return function* (text) {
    for (const match of text.matchAll(marker)) {
      let start = match.index;
      let end = start + match[0].length;
      // Bounded, so a megabyte without spaces cannot make the scan quadratic.
      while (start > 0 && match.index - start < 60 && PATH_CHAR.test(text[start - 1]!)) start--;
      while (end < text.length && end - match.index < 120 && PATH_CHAR.test(text[end]!)) end++;
      yield quote(text.slice(start, end).replace(/[.:!?]+$/, ""));
    }
  };
}

/** Base64 outside links and data URIs: long, with digits and both cases, which prose and paths rarely have. */
function* base64Blobs(text: string): Generator<string> {
  const outsideLinks = text.replace(LINK, " ").replace(DATA_URI, " ");
  for (const [run] of outsideLinks.matchAll(/[A-Za-z0-9+/]{40,}={0,2}/g)) {
    if (/\d\D*\d/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run)) yield quote(run);
  }
}

/** Tag characters mirror ASCII (U+E0041 is an invisible "A"), so the hidden text can be shown. */
function* tagText(text: string): Generator<string> {
  for (const match of text.matchAll(TAGS)) {
    let decoded = "";
    for (const char of match[0]) {
      const code = char.codePointAt(0)! - 0xe0000;
      // U+E0001 starts a language tag and U+E007F cancels one: markers, not text.
      if (code !== 0x01 && code !== 0x7f) decoded += String.fromCharCode(code);
    }
    yield decoded ? `hidden text: ${quote(decoded)}` : quote(match[0]);
  }
}

/** Blank runs are described rather than quoted: forty quoted spaces show nothing. */
function* blankRuns(text: string): Generator<string> {
  for (const [run] of text.matchAll(/\s{40,}|(?:[^\S\n]*\n){8,}/g)) {
    let breaks = 0;
    for (const char of run) if (char === "\n") breaks++;
    yield breaks >= 8 ? `${breaks} line breaks in a row` : `${run.length} blank characters in a row`;
  }
}

/** Runs every rule on one string. */
export function scanText(text: string, field = "text"): Finding[] {
  return scanWindows(text, field, RULES);
}

// A tool description or a tool result can be a line of 16 MiB, and on that much hostile text the
// rules overflow the regular expression stack (from about 5 million characters in one run), take
// seconds (a match at every character) or run out of memory (millions of snippets). So a text is
// read a window at a time, with an overlap that keeps a sign on a boundary whole, and each rule stops
// after enough matches in a window: the matches it skips are more of a sign it already reported. A
// text of up to WINDOW + OVERLAP characters is one window, read whole.
const WINDOW = 1024 * 1024;
const OVERLAP = 1024;
const MATCHES_PER_WINDOW = 100;

/** Runs `rules` on one string, a window at a time. */
function scanWindows(text: string, field: string, rules: Rule[]): Finding[] {
  const findings: Finding[] = [];
  for (let start = 0; start < text.length; start += WINDOW) {
    const end = start + WINDOW + OVERLAP;
    findings.push(...scan(text.slice(start, end), field, rules, MATCHES_PER_WINDOW));
    if (end >= text.length) break;
  }
  return tidy(findings);
}

/** Runs `rules` on one window, each rule stopping after `limit` matches. */
function scan(text: string, field: string, rules: Rule[], limit: number): Finding[] {
  const findings: Finding[] = [];
  for (const rule of rules) {
    let matches = 0;
    for (const snippet of snippets(rule, text)) {
      if (++matches > limit) break;
      findings.push({ rule: rule.id, severity: rule.severity, field, snippet, message: rule.message });
    }
  }
  return tidy(findings);
}

/** What one rule finds, one snippet at a time, so a scan can stop early. */
function* snippets(rule: Rule, text: string): Generator<string> {
  if ("test" in rule) yield* rule.test(text);
  else for (const match of text.matchAll(rule.pattern)) yield quote(match[0]);
}

// A definition or a result can also hold a great many short strings: an enum of 3 million one-letter
// values is a line of 12 MiB, and at a few microseconds a string, reading it took 15 seconds. The
// scan stops at these limits, and one finding takes the place of what it did not read.
/** The most strings the scan reads in one definition or one result. */
const MAX_STRINGS = 20_000;
/** The most characters the scan reads in one definition or one result, all its strings together. */
const MAX_CHARS = 32 * 1024 * 1024;

const OVER_BUDGET = `more than ${MAX_STRINGS.toLocaleString("en-US")} strings or ${MAX_CHARS / 1024 / 1024} Mi characters: too much to read`;
const DEFINITION_OVER_BUDGET: Omit<Finding, "snippet"> = { rule: "scan-budget", severity: "high", field: "definition", message: `${OVER_BUDGET}, treat it as hidden` };
const RESULT_OVER_BUDGET: Omit<Finding, "snippet"> = { rule: "scan-budget", severity: "medium", field: "result", message: `${OVER_BUDGET}, so the rest was not checked` };

/**
 * Scans the texts in turn while they fit in MAX_STRINGS and MAX_CHARS. The first one that does not is
 * not read, nor anything after it: `overflow` takes their place and says where reading stopped.
 */
function scanWithinBudget(texts: Iterable<[string, string]>, scan: (text: string, field: string) => Finding[], overflow: Omit<Finding, "snippet">): Finding[] {
  const findings: Finding[] = [];
  let count = 0;
  let chars = 0;
  for (const [field, text] of texts) {
    count += 1;
    chars += text.length;
    if (count > MAX_STRINGS || chars > MAX_CHARS) {
      findings.push({ ...overflow, snippet: `stopped before ${quote(field)}` });
      break;
    }
    for (const finding of scan(text, field)) findings.push(finding);
  }
  return findings;
}

/** Runs every rule on every string of a definition (names, descriptions, schemas, annotations), within the budget. */
export function scanTool(tool: ToolDefinition): Finding[] {
  return tidy(scanWithinBudget(strings(tool), scanText, DEFINITION_OVER_BUDGET));
}

/** What a changed definition carries, plus how much it grew since it was approved. */
export function scanChange(before: ToolDefinition | undefined, after: ToolDefinition): Finding[] {
  return tidy([...scanTool(after), ...(before ? lengthGrowth(before, after) : [])]);
}

/**
 * A tool's result is data: a file, a page, a mailbox, a log. These rules match what such data is
 * normally made of, so on results they would mark almost every call and bury the real signs: web
 * and email addresses, IP addresses, data URIs and base64 blobs, HTML comments, .env files (most
 * projects keep one, and listings, .gitignore files and READMEs name it) and long blank stretches.
 * They are signs in a definition because a description has no reason to carry them. length-growth
 * is not used either: it measures a definition against the approved one, and a result has no
 * earlier version.
 */
const DATA_RULES = new Set(["html-comment", "env-file", "url", "ip-address", "data-uri", "base64-blob", "email-address", "padding"]);
const RESULT_RULES = RULES.filter((rule) => !DATA_RULES.has(rule.id));

/** Runs the rules that make sense on free text on one text of a tool's result. */
export function scanResultText(text: string, field = "text"): Finding[] {
  // A byte order mark opens many files and hides nothing.
  return scanWindows(text.startsWith("\uFEFF") ? text.slice(1) : text, field, RESULT_RULES);
}

/**
 * The texts of an answer to tools/call that reach the model, by JSON path: the text items of the
 * content (an isError result carries its error message there), the text of embedded resources,
 * structuredContent serialized, and the message of a JSON-RPC error. An empty text is left out:
 * there is nothing to scan.
 */
export function resultTexts(response: { result?: unknown; error?: unknown }): Array<[string, string]> {
  const result = (response.result ?? {}) as { content?: unknown; structuredContent?: unknown };
  const error = (response.error ?? {}) as { message?: unknown };
  const texts: Array<[string, string]> = [];
  for (const [index, item] of (Array.isArray(result.content) ? result.content : []).entries()) {
    const { type, text, resource } = (item ?? {}) as { type?: unknown; text?: unknown; resource?: { text?: unknown } };
    if (type === "text" && typeof text === "string") texts.push([`content[${index}].text`, text]);
    else if (type === "resource" && typeof resource?.text === "string") texts.push([`content[${index}].resource.text`, resource.text]);
  }
  // Serialized only when it is shallow enough: JSON.stringify recurses (see scanResult).
  if (result.structuredContent !== undefined && !nestedDeeperThan(result.structuredContent, MAX_DEPTH)) {
    texts.push(["structuredContent", JSON.stringify(result.structuredContent)]);
  }
  if (typeof error.message === "string") texts.push(["error.message", error.message]);
  return texts.filter(([, text]) => text !== "");
}

/**
 * The signs of hidden instructions in an answer to tools/call. structuredContent usually comes back
 * as text too, so a sign found in both is one sign.
 */
export function scanResult(response: { result?: unknown; error?: unknown }): Finding[] {
  const findings = scanWithinBudget(resultTexts(response), scanResultText, RESULT_OVER_BUDGET);
  // structuredContent nested too deep is not serialized to be read, and a sign says so.
  if (nestedDeeperThan((response.result as { structuredContent?: unknown } | null | undefined)?.structuredContent, MAX_DEPTH)) {
    findings.push({ ...RESULT_OVER_BUDGET, field: "structuredContent", snippet: `nested more than ${MAX_DEPTH} levels deep`, message: "too deep to read, so it was not checked" });
  }
  const unique = new Map<string, Finding>();
  for (const finding of tidy(findings)) {
    const key = JSON.stringify([finding.rule, finding.snippet]);
    if (!unique.has(key)) unique.set(key, finding);
  }
  return [...unique.values()];
}

/**
 * One line about the high-severity signs in a tool's result, naming at most three the way the block
 * message names them; undefined when there is none.
 */
export function describeResultSigns(tool: string, findings: Finding[]): string | undefined {
  const high = findings.filter((finding) => finding.severity === "high");
  if (high.length === 0) return undefined;
  const named = high.slice(0, 3).map((finding) => `${finding.rule}: ${finding.snippet}`);
  return `the result of ${quote(tool)} carries ${highSeveritySigns(high.length)} (${named.join(", ")})`;
}

export function highestSeverity(findings: Finding[]): Severity | undefined {
  return SEVERITIES.find((severity) => findings.some((finding) => finding.severity === severity));
}

/** One aligned line per finding, indented to sit under the violation it explains. */
export function describeFindings(findings: Finding[]): string[] {
  const places = findings.map((finding) => {
    const { shown, clipped } = printable(finding.field, 60);
    return `${shown}${clipped ? "..." : ""}: ${finding.snippet}`;
  });
  const ruleWidth = findings.reduce((width, finding) => Math.max(width, finding.rule.length), 0);
  // Align the messages, without letting one long path push all of them off the screen.
  const placeWidth = Math.min(60, places.reduce((width, place) => Math.max(width, place.length), 0));
  return findings.map(
    (finding, index) =>
      `    ! ${finding.severity.toUpperCase().padEnd(6)}  ${finding.rule.padEnd(ruleWidth)}  ${places[index]!.padEnd(placeWidth)}   ${finding.message}`,
  );
}

/** `describeViolations`, with the signs found in each tool listed under it. */
export function describeViolationsWithFindings(violations: Violation[]): string {
  return violations
    .flatMap((violation) => {
      const findings = scanViolation(violation);
      const high = findings.filter((finding) => finding.severity === "high").length;
      const summary = high > 0 ? [`    ${highSeveritySigns(high)} in ${quote(violation.name)}`] : [];
      return [...describeViolation(violation), ...describeFindings(findings), ...summary];
    })
    .join("\n");
}

/** Counts per severity over a blocked listing, for the audit log and the approval warning. */
export function countSuspicious(violations: Violation[]): Record<Severity, number> {
  return countFindings(violations.flatMap((violation) => scanViolation(violation)));
}

/** Counts per severity, for the audit log. */
export function countFindings(findings: Finding[]): Record<Severity, number> {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return counts;
}

/** "3 high-severity signs of hidden instructions": the same words in the log, the error and approve. */
export function highSeveritySigns(count: number): string {
  return `${count} high-severity sign${count === 1 ? "" : "s"} of hidden instructions`;
}

function scanViolation(violation: Violation): Finding[] {
  return scanChange(violation.kind === "changed-tool" ? violation.before : undefined, violation.after);
}

const SEVERITIES: Severity[] = ["high", "medium", "low"];

/** Drops repeats of the same rule, field and snippet, then orders by severity, field and rule. */
function tidy(findings: Finding[]): Finding[] {
  const unique = new Map<string, Finding>();
  for (const finding of findings) unique.set(JSON.stringify([finding.rule, finding.field, finding.snippet]), finding);
  const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  return [...unique.values()].sort(
    (left, right) =>
      SEVERITIES.indexOf(left.severity) - SEVERITIES.indexOf(right.severity) ||
      compare(left.field, right.field) ||
      compare(left.rule, right.rule),
  );
}

// $schema, $id and $ref legitimately hold URLs; reporting them would bury the real signs.
const SCHEMA_KEYS = new Set(["$schema", "$id", "$ref"]);

/**
 * Every string of a definition with its JSON path, without `_meta`, which the model never sees. One
 * at a time and with a stack instead of recursion, so a scan can stop early and no depth exhausts it.
 */
function* strings(value: unknown): Generator<[string, string]> {
  const stack: Array<Iterator<[string, unknown]>> = [[["", value] as [string, unknown]].values()];
  while (stack.length > 0) {
    const next = stack[stack.length - 1]!.next();
    if (next.done) {
      stack.pop();
      continue;
    }
    const [path, inner] = next.value;
    if (typeof inner === "string") yield [path, inner];
    else if (inner !== null && typeof inner === "object") stack.push(children(path, inner));
  }
}

/** The values inside an array or an object with their paths, leaving out `_meta` at the top and the schema keys. */
function* children(path: string, value: object): Generator<[string, unknown]> {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield [`${path}[${index}]`, item];
    return;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (!((path === "" && key === "_meta") || SCHEMA_KEYS.has(key))) yield [path ? `${path}.${key}` : key, inner];
  }
}

/** The first `count` items, without walking the rest. */
function* first<T>(items: Iterable<T>, count: number): Generator<T> {
  if (count <= 0) return;
  let left = count;
  for (const item of items) {
    yield item;
    if (--left === 0) return;
  }
}

/**
 * A rug pull usually adds text. A string that at least doubled and gained 100 characters is a sign,
 * and so is a whole definition that doubled and gained 500 when no single string explains it.
 */
function lengthGrowth(before: ToolDefinition, after: ToolDefinition): Finding[] {
  // Within the scan's budget: past it, scanTool has already said the definition is too much to read.
  const previous = new Map(first(strings(before), MAX_STRINGS));
  const findings: Finding[] = [];
  for (const [field, text] of first(strings(after), MAX_STRINGS)) {
    const old = previous.get(field);
    if (old !== undefined && grew(old.length, text.length, 100)) findings.push(growth(field, old.length, text.length));
  }
  if (findings.length > 0) return findings;
  const from = visibleJson(before).length;
  const to = visibleJson(after).length;
  return grew(from, to, 500) ? [growth("definition", from, to)] : [];
}

function grew(from: number, to: number, by: number): boolean {
  return to >= from * 2 && to - from >= by;
}

function growth(field: string, from: number, to: number): Finding {
  const message = "grew a lot since it was approved, which leaves room for new instructions";
  return { rule: "length-growth", severity: "medium", field, snippet: `${from} -> ${to} chars`, message };
}

function visibleJson(tool: ToolDefinition): string {
  const { _meta: _ignored, ...visible } = tool;
  return canonicalJson(visible);
}

// What a terminal shows as nothing, or not at all: controls, format and unassigned characters,
// line separators and variation selectors.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Cn}\p{Zl}\p{Zp}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;

/** Text as a terminal should show it: invisible characters spelled out, clipped after `max` characters. */
function printable(text: string, max: number): { shown: string; clipped: boolean } {
  let shown = "";
  for (const char of text) {
    const next = spell(char);
    if (shown.length + next.length > max) return { shown, clipped: true };
    shown += next;
  }
  return { shown, clipped: false };
}

function spell(char: string): string {
  if (char === "\n") return "\\n";
  if (char === "\r") return "\\r";
  if (char === "\t") return "\\t";
  if (!UNPRINTABLE.test(char)) return char;
  return `[U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`;
}

/** A fragment as a finding shows it: quoted, printable, with its full length when clipped. */
function quote(text: string): string {
  const { shown, clipped } = printable(text, 80);
  return clipped ? `"${shown}..." (${text.length} chars)` : `"${shown}"`;
}
