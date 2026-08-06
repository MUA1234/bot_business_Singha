import { describe, it, expect } from "vitest";
import { InternalTemplates, approvedTemplateNames } from "@/lib/whatsapp-templates";

const task = { title: "Fix pump", taskUrl: "https://x/app/operations/tasks/1", dueDate: "2026-08-20" };

describe("internal WhatsApp templates", () => {
  it("all six required templates render and are sendable outside a session", () => {
    const msgs = [
      InternalTemplates.taskAssignment("Sam", task),
      InternalTemplates.estimateRequest("Sam", task),
      InternalTemplates.overdueReminder("Sam", task),
      InternalTemplates.clarification("Sam", task, "which site?"),
      InternalTemplates.verificationRequest("Mgr", task),
      InternalTemplates.escalation("Mgr", task, "blocked 3 days"),
    ];
    for (const m of msgs) {
      expect(m.kind).toBe("template"); // deliverable outside the 24h window
      expect(m.templateName).toMatch(/^singha_/);
      expect(m.body.length).toBeGreaterThan(0);
    }
    expect(new Set(msgs.map((m) => m.id)).size).toBe(6); // all distinct
  });

  it("renders the recipient name, task title and details into the body", () => {
    const m = InternalTemplates.taskAssignment("Sam", task);
    expect(m.body).toContain("Sam");
    expect(m.body).toContain("Fix pump");
    expect(m.body).toContain("2026-08-20");
    expect(m.body).toContain(task.taskUrl);
  });

  it("clarification and escalation include their variable text", () => {
    expect(InternalTemplates.clarification("Sam", task, "which site?").body).toContain("which site?");
    expect(InternalTemplates.escalation("Mgr", task, "blocked 3 days").body).toContain("blocked 3 days");
  });

  it("exposes the approved template names for registration", () => {
    const names = approvedTemplateNames();
    expect(names).toHaveLength(6);
    expect(names).toContain("singha_task_assignment");
  });
});
