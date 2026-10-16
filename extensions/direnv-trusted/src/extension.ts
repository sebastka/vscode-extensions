import * as path from 'node:path';
import * as vscode from 'vscode';
import { AllowStatus, decodeWatches, Direnv, DirenvError, type EnvDiff, type RcStatus } from './direnv.ts';
import { EnvironmentApplier, sameDiff, userVariables } from './environment.ts';

const SECTION = 'direnv-trusted';
const CACHE_KEY = `${SECTION}.cache`;
const LAST_RESTART_KEY = `${SECTION}.lastRestart`;
const RESTART_COOLDOWN_MS = 60_000;
const RELOAD_DEBOUNCE_MS = 300;

type State = 'none' | 'loading' | 'loaded' | 'blocked' | 'denied' | 'error';

interface Cache {
  rcPath: string;
  diff: EnvDiff;
}

interface Config {
  path: string;
  promptToAllow: boolean;
  restartExtensions: 'prompt' | 'always' | 'never';
  cacheEnvironment: boolean;
}

function readConfig(): Config {
  const config = vscode.workspace.getConfiguration(SECTION);
  return {
    path: config.get<string>('path') || 'direnv',
    promptToAllow: config.get<boolean>('promptToAllow', true),
    restartExtensions: config.get<Config['restartExtensions']>('restartExtensions', 'prompt'),
    cacheEnvironment: config.get<boolean>('cacheEnvironment', true),
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

class Controller implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly log = vscode.window.createOutputChannel('direnv', { log: true });
  private readonly statusItem = vscode.window.createStatusBarItem(`${SECTION}.status`, vscode.StatusBarAlignment.Left);
  private readonly applier: EnvironmentApplier;
  /** Environment of the extension host before we touched it; direnv always diffs against it. */
  private readonly baseEnv: NodeJS.ProcessEnv = { ...process.env };
  private readonly disposables: vscode.Disposable[] = [];

  private config = readConfig();
  private direnv = new Direnv(this.config.path, this.baseEnv);
  private state: State = 'none';
  private rc: RcStatus | undefined;
  private watchers: vscode.Disposable[] = [];
  private watchedPaths = '';
  private inflight: AbortController | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;
  private prompting = false;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.applier = new EnvironmentApplier(context.environmentVariableCollection);
    this.statusItem.name = 'direnv';

    this.disposables.push(
      this.log,
      this.statusItem,
      vscode.commands.registerCommand(`${SECTION}.reload`, () => this.reload()),
      vscode.commands.registerCommand(`${SECTION}.allow`, () => this.allow()),
      vscode.commands.registerCommand(`${SECTION}.deny`, () => this.deny()),
      vscode.commands.registerCommand(`${SECTION}.openEnvrc`, () => this.openEnvrc()),
      vscode.commands.registerCommand(`${SECTION}.showOutput`, () => {
        this.log.show();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.start();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.reload();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(SECTION)) {
          return;
        }
        this.config = readConfig();
        this.direnv = new Direnv(this.config.path, this.baseEnv);
        if (!this.config.cacheEnvironment) {
          void this.context.workspaceState.update(CACHE_KEY, undefined);
        }
        void this.reload();
      }),
    );
  }

  start(): void {
    // The manifest declares no support for untrusted workspaces, so VS Code should not even
    // activate us before trust is granted. Double-check anyway: loading runs arbitrary code.
    if (!vscode.workspace.isTrusted) {
      this.log.info('Workspace is not trusted, not loading direnv');
      return;
    }
    const initial = this.applyCached();
    void this.reload({ initial });
  }

  dispose(): void {
    this.inflight?.abort();
    clearTimeout(this.reloadTimer);
    this.unwatch();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private get cwd(): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file');
    return folder?.uri.fsPath;
  }

  /**
   * Synchronously applies the environment cached by the previous session, so that it is in
   * place before other extensions activate and spawn their processes. Only done when direnv
   * still reports the very same .envrc as allowed; the real reload follows right after.
   */
  private applyCached(): EnvDiff {
    const cache = this.context.workspaceState.get<Cache>(CACHE_KEY);
    const cwd = this.cwd;
    if (!cache || !cwd || !this.config.cacheEnvironment) {
      return {};
    }
    try {
      const status = this.direnv.statusSync(cwd);
      if (status?.allowed === AllowStatus.Allowed && status.path === cache.rcPath) {
        this.applier.apply(cache.diff);
        this.log.info(`Applied cached environment from ${cache.rcPath}`);
        return cache.diff;
      }
    } catch (error) {
      this.log.warn(`Could not check direnv status for the cached environment: ${String(error)}`);
    }
    void this.context.workspaceState.update(CACHE_KEY, undefined);
    return {};
  }

  private scheduleReload(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload(), RELOAD_DEBOUNCE_MS);
  }

  private async reload(options: { initial?: EnvDiff } = {}): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      return;
    }
    this.inflight?.abort();
    const abort = new AbortController();
    this.inflight = abort;
    const { signal } = abort;

    const cwd = this.cwd;
    const before = options.initial ?? this.applier.applied;
    try {
      if (!cwd) {
        this.unload();
        this.setState('none');
        return;
      }
      this.setState('loading');
      const rc = await this.direnv.status(cwd, signal);
      signal.throwIfAborted();
      this.rc = rc;

      if (!rc) {
        this.log.info(`No .envrc found for ${cwd}`);
        this.unload();
        this.watch([]);
        this.setState('none');
      } else if (rc.allowed !== AllowStatus.Allowed) {
        const denied = rc.allowed === AllowStatus.Denied;
        this.log.warn(`${rc.path} is ${denied ? 'denied' : 'not allowed'}`);
        this.unload();
        this.setState(denied ? 'denied' : 'blocked');
        const watches = await this.direnv.blockedWatches(cwd, signal).catch(() => []);
        signal.throwIfAborted();
        this.watch([rc.path, ...watches]);
        if (!denied && this.config.promptToAllow) {
          void this.promptToAllow(rc);
        }
      } else {
        this.log.info(`Loading ${rc.path}`);
        const { diff, stderr } = await this.direnv.export(cwd, signal);
        signal.throwIfAborted();
        for (const line of stderr.split('\n').filter(Boolean)) {
          this.log.info(line);
        }
        this.applier.apply(diff);
        this.context.environmentVariableCollection.description = `Environment from ${this.displayPath(rc.path)}`;
        if (this.config.cacheEnvironment) {
          await this.context.workspaceState.update(CACHE_KEY, { rcPath: rc.path, diff } satisfies Cache);
        }
        this.watch([rc.path, ...decodeWatches(diff.DIRENV_WATCHES)]);
        this.setState('loaded');
      }
    } catch (error) {
      if (isAbort(error)) {
        return;
      }
      this.setState('error');
      const message = error instanceof DirenvError || error instanceof Error ? error.message : String(error);
      this.log.error(message);
      void vscode.window.showErrorMessage(message, 'Show Output').then((choice) => {
        if (choice) {
          this.log.show();
        }
      });
      return;
    } finally {
      if (this.inflight === abort) {
        this.inflight = undefined;
      }
    }

    // Without a cache, an extension host restart would load the environment asynchronously
    // again and we would offer to restart forever: only offer it for later changes.
    const offerRestart = options.initial === undefined || this.config.cacheEnvironment;
    if (offerRestart && !sameDiff(before, this.applier.applied)) {
      await this.environmentChanged();
    }
  }

  private unload(): void {
    this.applier.restore();
    void this.context.workspaceState.update(CACHE_KEY, undefined);
  }

  private async environmentChanged(): Promise<void> {
    const mode = this.config.restartExtensions;
    if (mode === 'never') {
      return;
    }
    const lastRestart = this.context.workspaceState.get<number>(LAST_RESTART_KEY, 0);
    const recentlyRestarted = Date.now() - lastRestart < RESTART_COOLDOWN_MS;
    if (mode === 'prompt' || recentlyRestarted) {
      const choice = await vscode.window.showInformationMessage(
        'direnv environment changed. Restart extensions so that they pick it up?',
        'Restart Extensions',
      );
      if (!choice) {
        return;
      }
    }
    await this.context.workspaceState.update(LAST_RESTART_KEY, Date.now());
    await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
  }

  private async promptToAllow(rc: RcStatus): Promise<void> {
    if (this.prompting) {
      return;
    }
    this.prompting = true;
    try {
      for (;;) {
        const choice = await vscode.window.showWarningMessage(
          `direnv: ${this.displayPath(rc.path)} is not allowed. Review it and allow it to load its environment.`,
          'Allow',
          'Open',
          'Deny',
        );
        // The file may have been allowed or changed while the notification was up.
        if (this.rc?.path !== rc.path || this.state !== 'blocked') {
          return;
        }
        if (choice === 'Open') {
          await this.openEnvrc();
          continue;
        }
        if (choice === 'Allow') {
          await this.allow();
        } else if (choice === 'Deny') {
          await this.deny();
        }
        return;
      }
    } finally {
      this.prompting = false;
    }
  }

  private async allow(): Promise<void> {
    const rc = await this.currentRc();
    if (!rc) {
      return;
    }
    try {
      await this.direnv.allow(rc.path);
      this.log.info(`Allowed ${rc.path}`);
    } catch (error) {
      void vscode.window.showErrorMessage(String(error instanceof Error ? error.message : error));
    }
    await this.reload();
  }

  private async deny(): Promise<void> {
    const rc = await this.currentRc();
    if (!rc) {
      return;
    }
    try {
      await this.direnv.deny(rc.path);
      this.log.info(`Denied ${rc.path}`);
    } catch (error) {
      void vscode.window.showErrorMessage(String(error instanceof Error ? error.message : error));
    }
    await this.reload();
  }

  private async openEnvrc(): Promise<void> {
    const rc = await this.currentRc();
    if (rc) {
      await vscode.window.showTextDocument(vscode.Uri.file(rc.path), { preview: false });
    }
  }

  private async currentRc(): Promise<RcStatus | undefined> {
    const cwd = this.cwd;
    if (!cwd) {
      void vscode.window.showInformationMessage('direnv: no local workspace folder is open.');
      return undefined;
    }
    try {
      this.rc = await this.direnv.status(cwd);
    } catch (error) {
      void vscode.window.showErrorMessage(String(error instanceof Error ? error.message : error));
      return undefined;
    }
    if (!this.rc) {
      void vscode.window.showInformationMessage(`direnv: no .envrc found for ${cwd}.`);
    }
    return this.rc;
  }

  private watch(paths: string[]): void {
    const unique = [...new Set(paths)].sort();
    const key = unique.join('\n');
    if (key === this.watchedPaths) {
      return;
    }
    this.unwatch();
    this.watchedPaths = key;
    for (const file of unique) {
      const pattern = new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file));
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const reload = () => {
        this.scheduleReload();
      };
      this.watchers.push(
        watcher,
        watcher.onDidCreate(reload),
        watcher.onDidChange(reload),
        watcher.onDidDelete(reload),
      );
    }
  }

  private unwatch(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
    this.watchedPaths = '';
  }

  private displayPath(file: string): string {
    return vscode.workspace.asRelativePath(file, false);
  }

  private setState(state: State): void {
    this.state = state;
    const item = this.statusItem;
    const rcPath = this.rc ? this.displayPath(this.rc.path) : '';
    item.backgroundColor = undefined;
    switch (state) {
      case 'none':
        item.hide();
        return;
      case 'loading':
        item.text = '$(sync~spin) direnv';
        item.tooltip = 'direnv: loading…';
        item.command = `${SECTION}.showOutput`;
        break;
      case 'loaded': {
        const variables = userVariables(this.applier.applied);
        const tooltip = new vscode.MarkdownString(`**direnv**: loaded \`${rcPath}\`\n\n`);
        if (variables.length) {
          tooltip.appendMarkdown(variables.map((name) => `- \`${name}\``).join('\n'));
        } else {
          tooltip.appendMarkdown('No variables changed.');
        }
        tooltip.appendMarkdown('\n\nClick to reload.');
        item.text = '$(folder-active) direnv';
        item.tooltip = tooltip;
        item.command = `${SECTION}.reload`;
        break;
      }
      case 'blocked':
        item.text = '$(shield) direnv';
        item.tooltip = `direnv: ${rcPath} is not allowed. Click to allow.`;
        item.command = `${SECTION}.allow`;
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'denied':
        item.text = '$(circle-slash) direnv';
        item.tooltip = `direnv: ${rcPath} is denied. Click to allow.`;
        item.command = `${SECTION}.allow`;
        break;
      case 'error':
        item.text = '$(error) direnv';
        item.tooltip = 'direnv: failed to load. Click to show the output.';
        item.command = `${SECTION}.showOutput`;
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
    }
    item.show();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new Controller(context);
  context.subscriptions.push(controller);
  controller.start();
}
