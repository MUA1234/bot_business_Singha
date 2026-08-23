/**
 * RSK-005 — Incidents and statutory obligations surface.
 *
 * Verifies the incident log and obligations register pages, actions and migration exist
 * and surface the right legal/compliance concepts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isOpenIncident, severityBadgeClass } from "@/modules/legal/incidents";

const MIGRATION = "src/db/migrations/0106_incidents_and_statutory_obligations.sql";
const INCIDENTS_PAGE = "src/app/app/legal/incidents/page.tsx";
const INCIDENTS_ACTIONS = "src/app/app/legal/incidents/actions.ts";
const OBLIGATIONS_PAGE = "src/app/app/legal/obligations/page.tsx";
const OBLIGATIONS_ACTIONS = "src/app/app/legal/obligations/actions.ts";
const LEGAL_HOME = "src/app/app/legal/page.tsx";
const MODULE = "src/modules/legal/incidents.ts";

describe("RSK-005 — incidents and statutory obligations surface", () => {
  const migration = readFileSync(MIGRATION, "utf8");
  const incidentsPage = readFileSync(INCIDENTS_PAGE, "utf8");
  const incidentsActions = readFileSync(INCIDENTS_ACTIONS, "utf8");
  const obligationsPage = readFileSync(OBLIGATIONS_PAGE, "utf8");
  const obligationsActions = readFileSync(OBLIGATIONS_ACTIONS, "utf8");
  const legalHome = readFileSync(LEGAL_HOME, "utf8");
  const mod = readFileSync(MODULE, "utf8");

  it("adds incidents table and extends obligations with evidence and statutory type", () => {
    expect(migration).toContain("create table if not exists incidents");
    expect(migration).toContain("company_id uuid not null references companies(id)");
    expect(migration).toContain("alter table obligations");
    expect(migration).toContain("add column if not exists evidence");
    expect(migration).toContain("add column if not exists obligation_type");
    expect(migration).toContain("'legal.compliance.manage'");
    expect(migration).toContain("incidents_cap_ins");
    expect(migration).toContain("obligations_cap_ins");
  });

  it("exports pure incident helpers", () => {
    expect(mod).toContain("export function isOpenIncident");
    expect(mod).toContain("export function severityBadgeClass");
    expect(mod).toContain("export function sortIncidentsBySeverity");
  });

  it("has real runtime entrypoints under /app/legal/incidents and /app/legal/obligations", () => {
    expect(incidentsPage).toContain("export default async function IncidentsPage");
    expect(incidentsPage).toContain('from("incidents")');
    expect(obligationsPage).toContain("export default async function ObligationsPage");
    expect(obligationsPage).toContain('from("obligations")');
  });

  it("provides gated server actions for incidents", () => {
    expect(incidentsActions).toContain('"use server"');
    expect(incidentsActions).toContain("export async function createIncident");
    expect(incidentsActions).toContain("export async function updateIncidentStatus");
    expect(incidentsActions).toContain("incident.created");
    expect(incidentsActions).toContain("incident.status_updated");
  });

  it("provides gated server actions for obligations", () => {
    expect(obligationsActions).toContain('"use server"');
    expect(obligationsActions).toContain("export async function createObligation");
    expect(obligationsActions).toContain("export async function updateObligationStatus");
    expect(obligationsActions).toContain("obligation.created");
    expect(obligationsActions).toContain("obligation.status_updated");
  });

  it("surfaces incident severity, status and evidence on the page", () => {
    expect(incidentsPage).toContain("severityBadgeClass");
    expect(incidentsPage).toContain("root_cause");
    expect(incidentsPage).toContain("corrective_action");
    expect(incidentsPage).toContain("evidence");
  });

  it("surfaces obligation type, due date and evidence on the page", () => {
    expect(obligationsPage).toContain("obligation_type");
    expect(obligationsPage).toContain("statutory");
    expect(obligationsPage).toContain("evidence");
    expect(obligationsPage).toContain("renewalStatus");
  });

  it("links incidents and obligations from the legal home", () => {
    expect(legalHome).toContain('/app/legal/incidents');
    expect(legalHome).toContain('/app/legal/obligations');
    expect(legalHome).toContain('Open incidents');
    expect(legalHome).toContain('Open obligations');
  });

  it("classifies incidents as capability in the RLS matrix", () => {
    const rls = readFileSync("security/rls-classification.json", "utf8");
    expect(rls).toContain('"incidents": "capability"');
  });

  it("computes open-incident and severity-badge helpers", () => {
    expect(isOpenIncident("investigating")).toBe(true);
    expect(severityBadgeClass("high")).toBe("warn");
  });
});
