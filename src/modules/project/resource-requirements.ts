/**
 * PRJ-003 — Resource requirements for a project.
 *
 * Pure deterministic helper that turns project tasks, assignments and people into
 * a resource summary: who is assigned, planned/actual/remaining hours, blocked and
 * overdue task counts, and a utilization status per person. Reuses the capacity
 * detail logic from WRK-002.
 */
import {
  computeCapacityDetail,
  type CapacityDetail,
  type CapacityStatus,
} from "@/modules/work/capacity-detail";
import type { TaskState } from "@/modules/work/task-lifecycle";

const TERMINAL: ReadonlySet<TaskState> = new Set<TaskState>(["completed", "cancelled"]);
const BLOCKED: ReadonlySet<TaskState> = new Set<TaskState>(["blocked", "escalated"]);

const r2 = (n: number) => Math.round(n * 100) / 100;
const pos = (n: number | null | undefined) => (Number.isFinite(n as number) && (n as number) > 0 ? (n as number) : 0);

export interface ResourceTaskInput {
  id: string;
  project_id: string | null;
  status: TaskState;
  title: string;
  estimate_hours: number | null;
  actual_hours: number | null;
  remaining_hours: number | null;
  due_date: string | null; // ISO date
}

export interface ResourceAssignmentInput {
  id: string;
  task_id: string;
  membership_id: string | null;
  estimate_hours: number | null;
}

export interface ResourceMembershipInput {
  id: string;
  user_id: string | null;
}

export interface ResourceEmployeeInput {
  id: string;
  full_name: string | null;
  username: string | null;
  contracted_weekly_hours?: number | null;
  reserved_weekly_hours?: number | null;
}

export interface ResourcePersonSummary {
  membershipId: string;
  personId: string | null;
  name: string;
  plannedHours: number;
  actualHours: number;
  remainingHours: number;
  openTasks: number;
  blockedTasks: number;
  overdueTasks: number;
  capacity: CapacityDetail;
  status: CapacityStatus;
}

export interface ResourceUnassignedSummary {
  taskCount: number;
  plannedHours: number;
  actualHours: number;
  remainingHours: number;
  blockedTasks: number;
  overdueTasks: number;
}

export interface ResourceRequirementsResult {
  projectId: string;
  totals: {
    assignedPeople: number;
    plannedHours: number;
    actualHours: number;
    remainingHours: number;
    openTasks: number;
    blockedTasks: number;
    overdueTasks: number;
    utilizationStatus: CapacityStatus;
  };
  people: ResourcePersonSummary[];
  unassigned: ResourceUnassignedSummary;
}

function remainingHours(task: ResourceTaskInput): number {
  if (task.remaining_hours != null && Number.isFinite(task.remaining_hours)) return pos(task.remaining_hours);
  return pos(pos(task.estimate_hours) - pos(task.actual_hours));
}

function isOverdue(task: ResourceTaskInput, today: string): boolean {
  if (task.status === "overdue") return true;
  if (TERMINAL.has(task.status)) return false;
  return task.due_date != null && task.due_date < today;
}

function personName(
  membership: ResourceMembershipInput | undefined,
  employee: ResourceEmployeeInput | undefined,
): string {
  if (employee?.full_name) return employee.full_name;
  if (employee?.username) return employee.username;
  if (membership?.user_id) return membership.user_id;
  return "Unknown";
}

function overallStatus(people: ResourcePersonSummary[]): CapacityStatus {
  if (people.length === 0) return "healthy";
  if (people.some((p) => p.status === "overloaded")) return "overloaded";
  if (people.every((p) => p.status === "underallocated")) return "underallocated";
  return "healthy";
}

/**
 * Compute resource requirements for a single project.
 *
 * - Totals are aggregated across project tasks (actual/remaining are taken from the
 *   task level, while planned hours come from assignment estimates where available).
 * - Per-person summaries include the capacity detail for that person's assigned
 *   open tasks and a utilization status (overloaded / healthy / underallocated).
 * - Tasks with no assignment are reported under `unassigned`.
 */
export function computeResourceRequirements(
  input: ResourceRequirementsInput,
): ResourceRequirementsResult {
  const { projectId, tasks, assignments, memberships, employees, today } = input;
  const todayIso = today ?? new Date().toISOString().slice(0, 10);

  const projectTasks = tasks.filter((t) => t.project_id === projectId);

  const employeeById = new Map(employees.map((e) => [e.id, e]));
  const membershipById = new Map(memberships.map((m) => [m.id, m]));

  // Membership -> tasks, with the assignment-level estimate used when present.
  const assignmentMap = new Map<string, { task: ResourceTaskInput; assignmentEstimate: number | null }[]>();
  const assignedTaskIds = new Set<string>();

  for (const assignment of assignments) {
    if (!assignment.membership_id) continue;
    const task = projectTasks.find((t) => t.id === assignment.task_id);
    if (!task) continue;
    assignedTaskIds.add(task.id);
    const list = assignmentMap.get(assignment.membership_id) ?? [];
    list.push({ task, assignmentEstimate: assignment.estimate_hours });
    assignmentMap.set(assignment.membership_id, list);
  }

  const people: ResourcePersonSummary[] = [];

  for (const [membershipId, assigned] of assignmentMap.entries()) {
    const membership = membershipById.get(membershipId);
    const employee = membership?.user_id ? employeeById.get(membership.user_id) : undefined;

    let planned = 0;
    let actual = 0;
    let remaining = 0;
    let openTasks = 0;
    let blocked = 0;
    let overdue = 0;

    const capacityTasks = assigned.map(({ task, assignmentEstimate }) => {
      const taskPlanned = pos(assignmentEstimate ?? task.estimate_hours);
      const taskRemaining = remainingHours(task);
      const taskActual = pos(task.actual_hours);

      planned += taskPlanned;
      actual += taskActual;
      remaining += taskRemaining;
      if (!TERMINAL.has(task.status)) openTasks++;
      if (BLOCKED.has(task.status)) blocked++;
      if (isOverdue(task, todayIso)) overdue++;

      return {
        status: task.status,
        estimateHours: taskPlanned,
        actualHours: taskActual,
        remainingHours: taskRemaining,
        dueDate: task.due_date,
      };
    });

    const capacity = computeCapacityDetail({
      contractedWeeklyHours: employee?.contracted_weekly_hours ?? 0,
      approvedLeaveHours: 0,
      holidayHours: 0,
      reservedHours: employee?.reserved_weekly_hours ?? 0,
      tasks: capacityTasks,
      today: todayIso,
    });

    people.push({
      membershipId,
      personId: membership?.user_id ?? null,
      name: personName(membership, employee),
      plannedHours: r2(planned),
      actualHours: r2(actual),
      remainingHours: r2(remaining),
      openTasks,
      blockedTasks: blocked,
      overdueTasks: overdue,
      capacity,
      status: capacity.status,
    });
  }

  // Unassigned tasks (null membership or no assignment row).
  const unassignedTasks = projectTasks.filter((t) => !assignedTaskIds.has(t.id));
  let unassignedPlanned = 0;
  let unassignedActual = 0;
  let unassignedRemaining = 0;
  let unassignedBlocked = 0;
  let unassignedOverdue = 0;
  for (const task of unassignedTasks) {
    unassignedPlanned += pos(task.estimate_hours);
    unassignedActual += pos(task.actual_hours);
    unassignedRemaining += remainingHours(task);
    if (BLOCKED.has(task.status)) unassignedBlocked++;
    if (isOverdue(task, todayIso)) unassignedOverdue++;
  }

  // Project totals from tasks so actual/remaining are not inflated by multiple assignees.
  let totalPlanned = 0;
  let totalActual = 0;
  let totalRemaining = 0;
  let totalOpen = 0;
  let totalBlocked = 0;
  let totalOverdue = 0;
  for (const task of projectTasks) {
    if (!TERMINAL.has(task.status)) totalOpen++;
    if (BLOCKED.has(task.status)) totalBlocked++;
    if (isOverdue(task, todayIso)) totalOverdue++;
    totalPlanned += pos(task.estimate_hours);
    totalActual += pos(task.actual_hours);
    totalRemaining += remainingHours(task);
  }

  return {
    projectId,
    totals: {
      assignedPeople: people.length,
      plannedHours: r2(totalPlanned),
      actualHours: r2(totalActual),
      remainingHours: r2(totalRemaining),
      openTasks: totalOpen,
      blockedTasks: totalBlocked,
      overdueTasks: totalOverdue,
      utilizationStatus: overallStatus(people),
    },
    people: people.sort((a, b) => a.name.localeCompare(b.name)),
    unassigned: {
      taskCount: unassignedTasks.length,
      plannedHours: r2(unassignedPlanned),
      actualHours: r2(unassignedActual),
      remainingHours: r2(unassignedRemaining),
      blockedTasks: unassignedBlocked,
      overdueTasks: unassignedOverdue,
    },
  };
}

export interface ResourceRequirementsInput {
  projectId: string;
  tasks: ResourceTaskInput[];
  assignments: ResourceAssignmentInput[];
  memberships: ResourceMembershipInput[];
  employees: ResourceEmployeeInput[];
  today?: string;
}
