import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AllowStatus, decodeWatches, Direnv, stripAnsi } from '../src/direnv.ts';

describe('Direnv', () => {
  let root: string;
  let project: string;
  let rcPath: string;
  let direnv: Direnv;

  before(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'direnv-trusted-')));
    project = path.join(root, 'project');
    rcPath = path.join(project, '.envrc');
    await mkdir(project);
    await writeFile(rcPath, 'export DIRENV_TRUSTED_TEST=hello\nunset DIRENV_TRUSTED_UNSET\n');

    // Isolate direnv's allow list and config from the user's.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: root,
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
      DIRENV_TRUSTED_UNSET: 'bye',
    };
    direnv = new Direnv('direnv', env);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports no .envrc outside of the project', async () => {
    assert.equal(await direnv.status(root), undefined);
  });

  it('reports a new .envrc as not allowed, and watches its allow marker', async () => {
    assert.deepEqual(await direnv.status(project), { path: rcPath, allowed: AllowStatus.NotAllowed });
    const watches = await direnv.blockedWatches(project);
    assert.ok(watches.includes(rcPath));
    assert.ok(watches.some((watch) => watch.includes(`${path.sep}allow${path.sep}`)));
  });

  it('exports the environment once allowed', async () => {
    await direnv.allow(rcPath);
    assert.equal(statusSync(direnv, project), AllowStatus.Allowed);
    const { diff } = await direnv.export(project);
    assert.equal(diff.DIRENV_TRUSTED_TEST, 'hello');
    assert.equal(diff.DIRENV_TRUSTED_UNSET, null);
    assert.ok(decodeWatches(diff.DIRENV_WATCHES).includes(rcPath));
  });

  it('reports a denied .envrc', async () => {
    await direnv.deny(rcPath);
    assert.equal((await direnv.status(project))?.allowed, AllowStatus.Denied);
  });

  it('reports an edited .envrc as not allowed anymore', async () => {
    await direnv.allow(rcPath);
    await writeFile(rcPath, 'export DIRENV_TRUSTED_TEST=changed\n');
    assert.equal((await direnv.status(project))?.allowed, AllowStatus.NotAllowed);
  });
});

function statusSync(direnv: Direnv, cwd: string): AllowStatus | undefined {
  return direnv.statusSync(cwd)?.allowed;
}

describe('helpers', () => {
  it('strips ANSI colors', () => {
    assert.equal(stripAnsi('\u001b[31mdirenv: error\u001b[0m'), 'direnv: error');
  });

  it('ignores invalid DIRENV_WATCHES', () => {
    assert.deepEqual(decodeWatches('not-zlib'), []);
    assert.deepEqual(decodeWatches(null), []);
  });
});
