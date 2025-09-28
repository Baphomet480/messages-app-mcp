import { execFile } from "node:child_process";
import pkg from "../../package.json";

export type VersionInfo = {
  name: string;
  version: string;
  git_commit: string | null;
  git_commit_short: string | null;
};

let cachedInfo: VersionInfo | null = null;

async function resolveGitRevision(): Promise<{ full: string | null; short: string | null }> {
  try {
    const full = await new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        ["rev-parse", "HEAD"],
        { timeout: 2000 },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr || err.message));
          resolve(stdout.toString().trim());
        }
      );
    });
    if (!full) return { full: null, short: null };
    return { full, short: full.slice(0, 7) };
  } catch {
    return { full: null, short: null };
  }
}

export async function getVersionInfo(): Promise<VersionInfo> {
  if (cachedInfo) return cachedInfo;
  const baseName = typeof pkg?.name === "string" && pkg.name.trim().length > 0 ? pkg.name : "messages.app-mcp";
  const baseVersion = typeof pkg?.version === "string" && pkg.version.trim().length > 0 ? pkg.version : "0.0.0";
  const { full, short } = await resolveGitRevision();
  cachedInfo = {
    name: baseName,
    version: baseVersion,
    git_commit: full,
    git_commit_short: short,
  };
  return cachedInfo;
}

export function getVersionInfoSync(): VersionInfo {
  if (cachedInfo) return cachedInfo;
  const baseName = typeof pkg?.name === "string" && pkg.name.trim().length > 0 ? pkg.name : "messages.app-mcp";
  const baseVersion = typeof pkg?.version === "string" && pkg.version.trim().length > 0 ? pkg.version : "0.0.0";
  cachedInfo = {
    name: baseName,
    version: baseVersion,
    git_commit: null,
    git_commit_short: null,
  };
  return cachedInfo;
}
