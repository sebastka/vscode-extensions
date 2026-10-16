import { execFile, execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';

/** Mirrors direnv's internal `AllowStatus` enum, as reported by `direnv status --json`. */
export const AllowStatus = {
  Allowed: 0,
  NotAllowed: 1,
  Denied: 2,
} as const;
export type AllowStatus = (typeof AllowStatus)[keyof typeof AllowStatus];

export interface RcStatus {
  path: string;
  allowed: AllowStatus;
}

/** Variables to set (string) or unset (null), as printed by `direnv export json`. */
export type EnvDiff = Record<string, string | null>;

export class DirenvError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr = '') {
    super(message);
    this.name = 'DirenvError';
    this.stderr = stderr;
  }
}

interface StatusJson {
  state?: { foundRC?: { path: string; allowed: number } | null };
}

const MAX_BUFFER = 64 * 1024 * 1024;

// eslint-disable-next-line no-control-regex -- matching ANSI escape sequences
const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

function parseStatus(stdout: string): RcStatus | undefined {
  let json: StatusJson;
  try {
    json = JSON.parse(stdout) as StatusJson;
  } catch {
    throw new DirenvError('Could not parse `direnv status --json` output (direnv >= 2.33 is required)');
  }
  const rc = json.state?.foundRC;
  if (!rc) {
    return undefined;
  }
  return { path: rc.path, allowed: rc.allowed as AllowStatus };
}

/**
 * Thin wrapper around the direnv CLI.
 *
 * Every invocation runs against `baseEnv`, a snapshot of the environment taken before
 * any changes were applied, so `export` always returns the full diff rather than the
 * delta against a previously loaded environment.
 */
export class Direnv {
  readonly binary: string;
  readonly baseEnv: NodeJS.ProcessEnv;

  constructor(binary: string, baseEnv: NodeJS.ProcessEnv) {
    this.binary = binary;
    this.baseEnv = baseEnv;
  }

  /** Synchronous variant of {@link status}, used at activation to apply the cached environment early. */
  statusSync(cwd: string): RcStatus | undefined {
    const stdout = execFileSync(this.binary, ['status', '--json'], {
      cwd,
      env: this.baseEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    return parseStatus(stdout);
  }

  async status(cwd: string, signal?: AbortSignal): Promise<RcStatus | undefined> {
    const { stdout } = await this.run(['status', '--json'], cwd, signal);
    return parseStatus(stdout);
  }

  async export(cwd: string, signal?: AbortSignal): Promise<{ diff: EnvDiff; stderr: string }> {
    const { stdout, stderr } = await this.run(['export', 'json'], cwd, signal);
    const diff = stdout.trim() ? (JSON.parse(stdout) as EnvDiff) : {};
    return { diff, stderr };
  }

  /**
   * Returns the paths direnv watches for a blocked .envrc (the file itself and its allow/deny
   * markers), so that a `direnv allow` run from a terminal can be picked up.
   *
   * Only call this when the .envrc is NOT allowed: it runs `direnv export`, which would
   * evaluate an allowed file. For allowed files, decode `DIRENV_WATCHES` from the export instead.
   */
  async blockedWatches(cwd: string, signal?: AbortSignal): Promise<string[]> {
    const { stdout } = await this.run(['export', 'json'], cwd, signal, true);
    if (!stdout.trim()) {
      return [];
    }
    return decodeWatches((JSON.parse(stdout) as EnvDiff).DIRENV_WATCHES);
  }

  async allow(rcPath: string): Promise<void> {
    await this.run(['allow', rcPath], undefined);
  }

  async deny(rcPath: string): Promise<void> {
    await this.run(['deny', rcPath], undefined);
  }

  private run(
    args: string[],
    cwd: string | undefined,
    signal?: AbortSignal,
    ignoreExitCode = false,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        this.binary,
        args,
        { cwd, env: this.baseEnv, encoding: 'utf8', maxBuffer: MAX_BUFFER, signal },
        (error, stdout, stderr) => {
          stderr = stripAnsi(stderr);
          if (signal?.aborted) {
            reject(new DOMException(`direnv ${args.join(' ')} was cancelled`, 'AbortError'));
          } else if (error && !(ignoreExitCode && typeof error.code === 'number')) {
            const detail = stderr.trim() || error.message;
            reject(new DirenvError(`direnv ${args.join(' ')} failed: ${detail}`, stderr));
          } else {
            resolve({ stdout, stderr });
          }
        },
      );
    });
  }
}

/** Decodes direnv's `DIRENV_WATCHES` value (zlib-compressed, base64url-encoded JSON). */
export function decodeWatches(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  try {
    const entries = JSON.parse(inflateSync(Buffer.from(value, 'base64url')).toString('utf8')) as {
      path: string;
    }[];
    return entries.map((entry) => entry.path);
  } catch {
    return [];
  }
}
