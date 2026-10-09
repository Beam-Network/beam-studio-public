export type ParsedActionVersion = {
  major: number;
  minor: number;
  patch: number;
};

export function parseActionVersion(version: string): ParsedActionVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareActionVersions(left: string, right: string) {
  const parsedLeft = parseActionVersion(left);
  const parsedRight = parseActionVersion(right);
  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right);
  }

  return (
    parsedLeft.major - parsedRight.major ||
    parsedLeft.minor - parsedRight.minor ||
    parsedLeft.patch - parsedRight.patch
  );
}

export function latestActionPackagesByName<
  T extends { name: string; version: string },
>(actions: readonly T[]) {
  const latest = new Map<string, T>();
  for (const action of actions) {
    const current = latest.get(action.name);
    if (
      !current ||
      compareActionVersions(action.version, current.version) > 0
    ) {
      latest.set(action.name, action);
    }
  }
  return latest;
}
