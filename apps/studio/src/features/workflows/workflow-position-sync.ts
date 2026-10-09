import type {
  WorkflowLayout,
  WorkflowLayoutPatch,
} from "@beam-studio/shared";

type Position = WorkflowLayoutPatch["positions"][number];
export type PositionSyncState = {
  pending: boolean;
  saving: boolean;
  error: string;
};
export type PositionSyncTransport = {
  read(revision: number | null): Promise<WorkflowLayout | null>;
  write(patch: WorkflowLayoutPatch): Promise<{ revision: number }>;
};
type Clock = {
  now(): number;
  set(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clear(timer: ReturnType<typeof setTimeout>): void;
};
const defaultClock: Clock = {
  now: Date.now,
  set: (callback, delay) => globalThis.setTimeout(callback, delay),
  clear: (timer) => globalThis.clearTimeout(timer),
};

/** One queue and timer per open editor. No drag-frame traffic or overlapping writes. */
export class WorkflowPositionSync {
  private revision: number | null = null;
  private known = new Set<string>();
  private baseline = new Map<string, { x: number | null; y: number | null }>();
  private pending = new Map<string, Position>();
  private timer?: ReturnType<typeof setTimeout>;
  private working?: Promise<void>;
  private active = false;
  private stopped = false;
  private failures = 0;
  private changedAt: number;
  private saveAt = Infinity;
  private readAt = 0;
  private error = "";

  constructor(
    private readonly transport: PositionSyncTransport,
    private readonly onRemote: (layout: WorkflowLayout) => void,
    private readonly onState: (state: PositionSyncState) => void,
    private readonly clock: Clock = defaultClock,
  ) {
    this.changedAt = clock.now();
  }

  setKnown(ids: Iterable<string>) {
    this.known = new Set(ids);
    for (const id of this.pending.keys())
      if (!this.known.has(id)) this.pending.delete(id);
  }

  setActive(active: boolean) {
    this.active = active;
    if (active) this.readAt = 0;
    this.schedule();
  }

  enqueue(positions: Position[]) {
    if (this.stopped) return;
    let changed = false;
    for (const position of positions) {
      if (!this.known.has(position.nodeId)) continue;
      const normalized = {
        ...position,
        x: Math.fround(position.x),
        y: Math.fround(position.y),
      };
      const saved = this.baseline.get(position.nodeId);
      if (!this.working && saved?.x === normalized.x && saved.y === normalized.y) {
        changed = this.pending.delete(position.nodeId) || changed;
        continue;
      }
      const previous =
        this.pending.get(position.nodeId) ?? this.baseline.get(position.nodeId);
      if (previous?.x === normalized.x && previous.y === normalized.y) continue;
      this.pending.set(position.nodeId, normalized);
      changed = true;
    }
    if (!changed) return;
    this.changedAt = this.clock.now();
    this.saveAt = this.clock.now() + 500;
    this.emit();
    this.schedule();
  }

  protects(id: string) {
    return this.pending.has(id);
  }
  get hasPending() {
    return this.pending.size > 0;
  }

  refresh() {
    this.readAt = 0;
    this.schedule();
  }

  async flush() {
    if (this.working) await this.working;
    if (!this.hasPending || this.stopped) return;
    for (let attempt = 0; attempt < 3 && this.hasPending; attempt++) {
      await this.work(true);
      if (this.failures) break;
    }
    if (this.hasPending)
      throw new Error(
        this.error || "Workflow positions are not saved yet. Please retry.",
      );
  }

  dispose() {
    this.stopped = true;
    if (this.timer) this.clock.clear(this.timer);
  }

  private emit(saving = false) {
    if (!this.stopped)
      this.onState({ pending: this.hasPending, saving, error: this.error });
  }

  private schedule() {
    if (this.timer) this.clock.clear(this.timer);
    if (this.stopped || this.working) return;
    const due = Math.min(
      this.hasPending ? this.saveAt : Infinity,
      this.active ? this.readAt : Infinity,
    );
    if (!Number.isFinite(due)) return;
    this.timer = this.clock.set(
      () => {
        void this.work(false);
      },
      Math.max(0, due - this.clock.now()),
    );
  }

  private accept(layout: WorkflowLayout) {
    if (this.revision !== null && layout.revision < this.revision) return;
    if (this.revision !== layout.revision) this.changedAt = this.clock.now();
    this.revision = layout.revision;
    this.baseline = new Map(
      layout.positions.map((p) => [
        p.nodeId,
        {
          x: p.x === null ? null : Math.fround(p.x),
          y: p.y === null ? null : Math.fround(p.y),
        },
      ]),
    );
    for (const id of this.known)
      if (!this.baseline.has(id)) this.known.delete(id);
    // Remote deletion must not be re-created by a delayed move.
    for (const id of this.pending.keys()) {
      if (!this.baseline.has(id)) {
        this.pending.delete(id);
        this.error =
          "A moved node was removed in another session. Refresh the workflow.";
      }
    }
    for (const [id, position] of this.pending) {
      const saved = this.baseline.get(id);
      if (saved?.x === position.x && saved.y === position.y) this.pending.delete(id);
    }
    this.onRemote(layout);
  }

  private work(force: boolean): Promise<void> {
    if (this.working) return this.working;
    const run = async () => {
      try {
        if (
          this.revision === null ||
          (!force && this.active && this.readAt <= this.clock.now())
        ) {
          const layout = await this.transport.read(this.revision);
          if (this.stopped) return;
          this.error = "";
          if (layout) this.accept(layout);
        }
        if (this.hasPending && (force || this.saveAt <= this.clock.now())) {
          this.emit(true);
          const sent = [...this.pending.values()];
          try {
            const result = await this.transport.write({
              revision: this.revision!,
              positions: sent,
            });
            if (this.stopped) return;
            this.revision = result.revision;
            for (const position of sent) {
              this.baseline.set(position.nodeId, position);
              if (this.pending.get(position.nodeId) === position)
                this.pending.delete(position.nodeId);
            }
            this.error = "";
          } catch (error) {
            if (
              (error as { code?: string }).code !== "workflow_layout_conflict"
            )
              throw error;
            // Rebase only the pending moves, never send the whole stale layout.
            const current = await this.transport.read(null);
            if (this.stopped) return;
            if (current) this.accept(current);
            this.saveAt = this.clock.now() + 500;
          }
        }
        this.failures = 0;
        this.readAt =
          this.clock.now() +
          (this.clock.now() - this.changedAt < 30_000 ? 5_000 : 30_000);
      } catch (error) {
        if (this.stopped) return;
        this.error = error instanceof Error ? error.message : String(error);
        const delay = Math.min(30_000, 1_000 * 2 ** this.failures++);
        this.saveAt = this.clock.now() + delay;
        this.readAt = this.saveAt;
      }
    };
    this.working = run().finally(() => {
      this.working = undefined;
      this.emit();
      this.schedule();
    });
    return this.working;
  }
}
