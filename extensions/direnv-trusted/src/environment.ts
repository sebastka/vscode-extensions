import type * as vscode from 'vscode';
import type { EnvDiff } from './direnv.ts';

/**
 * Applies a direnv diff to:
 * - `process.env` of the extension host, so processes spawned afterwards by any extension
 *   (language servers, linters, debuggers, tasks…) inherit it;
 * - the extension's `EnvironmentVariableCollection`, so new integrated terminals get it.
 *
 * Keeps track of the original values so that a later diff fully replaces the previous one.
 */
export class EnvironmentApplier {
  private readonly originals = new Map<string, string | undefined>();
  private current: EnvDiff = {};
  private readonly collection: vscode.EnvironmentVariableCollection;

  constructor(collection: vscode.EnvironmentVariableCollection) {
    this.collection = collection;
  }

  get applied(): Readonly<EnvDiff> {
    return this.current;
  }

  apply(diff: EnvDiff): void {
    this.restore();
    for (const [name, value] of Object.entries(diff)) {
      this.originals.set(name, process.env[name]);
      if (value === null) {
        Reflect.deleteProperty(process.env, name);
        // The collection cannot unset a variable; an empty value is the closest we can get.
        this.collection.replace(name, '');
      } else {
        process.env[name] = value;
        this.collection.replace(name, value);
      }
    }
    this.current = { ...diff };
  }

  restore(): void {
    for (const [name, value] of this.originals) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
    this.originals.clear();
    this.collection.clear();
    this.current = {};
  }
}

/**
 * Whether two diffs set the same user-visible variables. direnv's own `DIRENV_*` bookkeeping is
 * ignored, as it changes whenever a watched file is touched even if the environment does not.
 */
export function sameDiff(a: Readonly<EnvDiff>, b: Readonly<EnvDiff>): boolean {
  const keys = userVariables(a);
  const otherKeys = userVariables(b);
  return keys.length === otherKeys.length && keys.every((key, i) => key === otherKeys[i] && a[key] === b[key]);
}

/** Names of the variables a diff changes, excluding direnv's own bookkeeping. */
export function userVariables(diff: Readonly<EnvDiff>): string[] {
  return Object.keys(diff)
    .filter((name) => !name.startsWith('DIRENV_'))
    .sort();
}
