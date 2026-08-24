/**
 * Spatial window state model. This file is pure TypeScript — no runtime logic —
 * so it can be imported by both server and client components without pulling in
 * React context.
 */

/** Severity / priority of an arriving window. */
export type SpatialPriority = "critical" | "high" | "normal" | "low";

/** Urgency is used to decide whether a window should request focus or stay quiet. */
export type SpatialUrgency = "interrupt" | "visible" | "queued" | "background";

/** Dock position. */
export type DockPosition = "left" | "right" | "bottom" | null;

/** Window lifecycle state. */
export interface SpatialWindowState {
  /** Stable window identity. */
  id: string;
  /** Registered window type. */
  type: string;
  /** Optional record identity inside the window. */
  recordId?: string;
  /** Human-readable title (also used for aria-label). */
  title: string;
  /** Position in workspace coordinates (px). */
  x: number;
  y: number;
  /** Size (px). */
  width: number;
  height: number;
  /** Rendering order. */
  z: number;
  /** True when the user has explicitly pinned the window. */
  pinned: boolean;
  /** True when minimised to the dock. */
  minimised: boolean;
  /** True when maximised to fill the stage. */
  maximised: boolean;
  /** Dock slot when docked. */
  docked: DockPosition;
  /** Arrival priority. */
  priority: SpatialPriority;
  /** Arrival urgency. */
  urgency: SpatialUrgency;
  /** True while the record content is loading. */
  loading: boolean;
  /** True when the underlying record may be stale. */
  stale: boolean;
  /** True when the caller lacks permission for this record. */
  permissionDenied: boolean;
  /** Optional error message. */
  error: string | null;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  /** Optional pre-rendered content. Only used for initial windows; never persisted. */
  content?: import("react").ReactNode;
}

/** Serialized layout snapshot persisted to localStorage. */
export interface SpatialLayoutSnapshot {
  version: 2;
  windows: SpatialWindowState[];
  nextZ: number;
  focusedId: string | null;
  reducedMotion: boolean;
  flatMode: boolean;
  generatedAt: string;
}

/** Actions supported by the workspace reducer. */
export type WorkspaceAction =
  | { kind: "open"; window: SpatialWindowState }
  | { kind: "close"; id: string }
  | { kind: "focus"; id: string }
  | { kind: "move"; id: string; x: number; y: number }
  | { kind: "resize"; id: string; width: number; height: number }
  | { kind: "minimise"; id: string }
  | { kind: "maximise"; id: string }
  | { kind: "restore"; id: string }
  | { kind: "pin"; id: string; pinned: boolean }
  | { kind: "dock"; id: string; position: DockPosition }
  | { kind: "undock"; id: string }
  | { kind: "setPriority"; id: string; priority: SpatialPriority; urgency: SpatialUrgency }
  | { kind: "setLoading"; id: string; loading: boolean }
  | { kind: "setStale"; id: string; stale: boolean }
  | { kind: "setPermissionDenied"; id: string; permissionDenied: boolean }
  | { kind: "setError"; id: string; error: string | null }
  | { kind: "setReducedMotion"; reducedMotion: boolean }
  | { kind: "setFlatMode"; flatMode: boolean }
  | { kind: "snapshot"; windows: SpatialWindowState[]; nextZ: number; focusedId?: string | null }
  | { kind: "batchArrive"; arrivals: SpatialWindowState[] }
  | { kind: "reorder"; ids: string[] }
  | { kind: "blur" };

/** Registry entry describing how to render a window type. */
export interface WindowTypeSpec {
  /** Unique type key. */
  type: string;
  /** Display label used in the command palette and dock tooltips. */
  label: string;
  /** Icon name from the lucide map. */
  icon: string;
  /** Capabilities required to open this window type (empty = unrestricted). */
  requiredCapabilities?: string[];
  /** Whether the type can be opened multiple times. */
  singleton?: boolean;
  /** Default dimensions. */
  defaultWidth: number;
  defaultHeight: number;
  /** Default priority for new windows of this type. */
  defaultPriority: SpatialPriority;
}

/** Props passed by the registry to every window content renderer. */
export interface WindowContentProps {
  windowId: string;
  type: string;
  recordId?: string;
  title: string;
  companyId: string;
  userId: string;
  isMinimised: boolean;
  isMaximised: boolean;
  isFocused: boolean;
}

/** A record that can be opened as a window from the command palette. */
export interface SearchableRecord {
  id: string;
  type: string;
  title: string;
  subtitle?: string;
  priority?: SpatialPriority;
}

/** Shared fields for every real production item surfaced in the rail. */
export interface SpatialArrivalBase {
  id: string;
  title: string;
  priority: SpatialPriority;
  /** ISO timestamp used for stable ordering. */
  timestamp: string;
  /** Registered window type the arrival opens when acted on. */
  moduleType: string;
  /** Optional record identity inside the target module. */
  recordId?: string;
}

/** A task that has arrived in the rail. */
export interface TaskArrival extends SpatialArrivalBase {
  kind: "task";
  due?: string | null;
}

/** An alert / notification that has arrived in the rail. */
export interface AlertArrival extends SpatialArrivalBase {
  kind: "alert";
  message: string;
}

export type SpatialArrival = TaskArrival | AlertArrival;

