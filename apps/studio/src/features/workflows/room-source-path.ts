export function roomSourcePathIssue(path: string, platform?: string | null) {
  if (!path.trim()) return null;
  const value = path.trim();
  const windows = /win/i.test(platform ?? "");
  const unix = /(linux|darwin|mac|unix)/i.test(platform ?? "");
  const windowsAbsolute = /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(value);
  const unixAbsolute = value.startsWith("/");
  if (windows && !windowsAbsolute)
    return "Enter an absolute Windows path, such as C:\\Transfers\\file.bin.";
  if (unix && !unixAbsolute)
    return "Enter an absolute path, such as /srv/transfers/file.bin.";
  if (!windows && !unix && !windowsAbsolute && !unixAbsolute)
    return "Enter an absolute path for the selected agent.";
  return null;
}
