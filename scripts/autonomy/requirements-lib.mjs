/**
 * Minimal YAML reader for the requirement register.
 *
 * Deliberately NOT a YAML dependency: the COST RULE in CLAUDE.md forbids adding packages without a
 * recorded justification, and the register uses a tiny, fixed subset (a list of flat maps of scalars,
 * plus one list of strings). Parsing that subset is a few lines; taking a dependency for it is not
 * worth the supply-chain surface on a public repository.
 *
 * Supported shape only:
 *   requirements:
 *     - key: value
 *       list_key: [a, b]
 *   _pending_population:
 *     - text
 */
import { readFileSync } from "node:fs";

export const REGISTER_PATH = "docs/autonomy/ORIGINAL_VISION_REQUIREMENTS.yaml";

/** Statuses that assert the requirement is DONE at some verification level. */
export const COMPLETE_STATUSES = new Set([
  "locally_verified",
  "preview_verified",
  "staging_verified",
  "production_verified",
]);

export const VALID_STATUSES = new Set([
  "absent",
  "specified",
  "foundation_only",
  "implementation_in_progress",
  "implemented_unverified",
  ...COMPLETE_STATUSES,
  "blocked_owner",
  "blocked_external",
  "deliberately_deferred",
]);

/** Fields that must be present and non-empty before a completion status is believable. */
export const REQUIRED_EVIDENCE_FOR_COMPLETE = [
  "runtime_entrypoint",
  "test_evidence",
  "last_verified_sha",
];

/** Values that mean "nothing here" regardless of which field they appear in. */
const EMPTY = new Set(["", "none", "n/a", "na", "nil", "null", "-", "tbd", "todo"]);

export function isEmptyValue(v) {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  return EMPTY.has(String(v).trim().toLowerCase());
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((x) => x.trim().replace(/^["']|["']$/g, ""));
  }
  return s.replace(/^["']|["']$/g, "");
}

export function loadRegister(path = REGISTER_PATH) {
  const lines = readFileSync(path, "utf8").split("\n");
  const requirements = [];
  const pending = [];
  let section = null;
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    if (/^requirements:\s*$/.test(line)) {
      section = "requirements";
      continue;
    }
    if (/^_pending_population:\s*$/.test(line)) {
      if (current) requirements.push(current);
      current = null;
      section = "pending";
      continue;
    }

    if (section === "pending") {
      const m = /^\s*-\s+(.*)$/.exec(line);
      if (m) pending.push(m[1].trim());
      continue;
    }

    if (section !== "requirements") continue;

    const item = /^\s{2}-\s+([a-z_]+):\s*(.*)$/.exec(line);
    if (item) {
      if (current) requirements.push(current);
      current = { [item[1]]: parseScalar(item[2]) };
      continue;
    }
    const field = /^\s{4}([a-z_]+):\s*(.*)$/.exec(line);
    if (field && current) current[field[1]] = parseScalar(field[2]);
  }
  if (current) requirements.push(current);

  return { requirements, pending };
}

/** Group prefix, e.g. FOUND-001 → FOUND. */
export const groupOf = (id) => String(id ?? "").split("-")[0] ?? "?";

/**
 * A completion status must name a REAL tested commit.
 *
 * "pending", "latest" or a branch name would let a completion claim carry no verifiable evidence
 * while still passing the emptiness check — the exact gap this audit exists to close. The value must
 * look like an abbreviated or full Git object name; `audit-requirements.mjs` additionally proves the
 * commit exists in this repository.
 */
export const SHA_RE = /^[0-9a-f]{7,40}$/;

/** Validate one requirement. Returns an array of problem strings (empty = fine). */
export function validateRequirement(r) {
  const problems = [];
  const id = r.id ?? "(missing id)";

  if (!r.id) problems.push("missing id");
  if (!r.title) problems.push(`${id}: missing title`);
  if (!r.status) problems.push(`${id}: missing status`);
  else if (!VALID_STATUSES.has(r.status)) problems.push(`${id}: invalid status "${r.status}"`);

  // The register is read by a deliberately minimal parser (see the file header). A YAML BLOCK
  // SCALAR (`>-`, `|`, …) parses as the marker itself and its indented text is silently dropped —
  // the field looks present and says nothing. Caught here rather than discovered later as a
  // requirement whose residual risks read ">-".
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === "string" && [">", ">-", "|", "|-", ">+", "|+"].includes(v.trim())) {
      problems.push(`${id}: ${k} is a YAML block scalar, which this register's parser drops — write it on one line`);
    }
  }

  if (r.status && COMPLETE_STATUSES.has(r.status)) {
    for (const field of REQUIRED_EVIDENCE_FOR_COMPLETE) {
      if (isEmptyValue(r[field])) {
        problems.push(`${id}: status "${r.status}" but ${field} is empty — a completion status requires evidence`);
      }
    }
    if (!isEmptyValue(r.last_verified_sha) && !SHA_RE.test(String(r.last_verified_sha).trim())) {
      problems.push(
        `${id}: last_verified_sha "${r.last_verified_sha}" is not a commit id — a completion status may not cite a placeholder`,
      );
    }
  }
  return problems;
}
