export const DEFAULT_TASK_SUBJECT_ROOT = "beam.workflow.tasks";
export const TASK_STREAM_WILDCARD = ">";

export type TaskSubjectInput = {
  root?: string;
  actionPackageName?: string;
  taskKind?: string;
  targetWorkerId?: string | null;
};

export function taskStreamSubject(root = DEFAULT_TASK_SUBJECT_ROOT) {
  return `${cleanRoot(root)}.${TASK_STREAM_WILDCARD}`;
}

export function generalTaskSubject(root = DEFAULT_TASK_SUBJECT_ROOT) {
  return `${cleanRoot(root)}.general`;
}

export function workerTaskSubject(
  workerId: string,
  root = DEFAULT_TASK_SUBJECT_ROOT,
) {
  return `${cleanRoot(root)}.worker.${subjectToken(workerId)}`;
}

export function interchangeableTaskSubject(root = DEFAULT_TASK_SUBJECT_ROOT) {
  return `${cleanRoot(root)}.*`;
}

export function taskSubjectFor(input: TaskSubjectInput) {
  if (input.targetWorkerId) {
    return workerTaskSubject(input.targetWorkerId, input.root);
  }
  const token = taskCapabilityToken(input.actionPackageName, input.taskKind);
  return `${cleanRoot(input.root ?? DEFAULT_TASK_SUBJECT_ROOT)}.${token}`;
}

export function taskCapabilityToken(
  actionPackageName?: string,
  taskKind?: string,
) {
  if (actionPackageName === "@beam/transfer") {
    return "transfer";
  }
  if (actionPackageName === "@beam/download" || taskKind === "download") {
    return "download";
  }
  if (actionPackageName === "@beam/upload" || taskKind === "upload") {
    return "upload";
  }
  return "general";
}

export function subjectToken(value: string) {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "unknown"
  );
}

function cleanRoot(root: string) {
  return root.replace(/[.>]+$/g, "") || DEFAULT_TASK_SUBJECT_ROOT;
}
