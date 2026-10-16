# direnv (trusted)

Loads your [direnv](https://direnv.net/) environment into VS Code — but only when VS Code
trusts the workspace **and** direnv has allowed the `.envrc`.

## How it works

- **Untrusted workspace**: the extension is not activated at all (it declares no support for
  restricted mode). Once you trust the workspace, it activates and continues below.
- **`.envrc` not allowed**: you get a notification to _Allow_, _Open_ (review it first) or
  _Deny_ it. The status bar item stays highlighted until you decide. Running `direnv allow`
  from a terminal is picked up automatically too.
- **`.envrc` allowed**: `direnv export json` is run and its result is applied to:
  - the extension host's environment, so processes spawned by extensions afterwards
    (language servers, linters, debuggers, tasks…) inherit it;
  - new integrated terminals.
- **Changes**: the `.envrc` and every file direnv watches (`watch_file`, `use flake`…) are
  watched; the environment is reloaded when they change. An edited `.envrc` must be allowed
  again, exactly like in your shell, and its environment is unloaded until then.

### Extensions that start before the environment is loaded

VS Code cannot delay other extensions until direnv is done, and processes they already
started keep their old environment. To mitigate this:

- the last loaded environment is cached (`direnv-trusted.cacheEnvironment`) and applied
  _synchronously_ at activation — after checking that direnv still allows the same `.envrc` —
  so it is in place before most extensions start their processes;
- when the environment changes, you are offered to restart the extension host
  (`direnv-trusted.restartExtensions`).

## Settings

| Setting                            | Default  | Description                                                                    |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------ |
| `direnv-trusted.path`              | `direnv` | direnv executable (>= 2.33). Machine-scoped: a workspace cannot override it.   |
| `direnv-trusted.promptToAllow`     | `true`   | Offer to allow an `.envrc` that is not allowed yet.                            |
| `direnv-trusted.restartExtensions` | `prompt` | `prompt`, `always` or `never` restart extensions when the environment changes. |
| `direnv-trusted.cacheEnvironment`  | `true`   | Cache the environment in the workspace storage to apply it early on startup.   |

> **Note**: with `cacheEnvironment`, the environment values — including secrets loaded from
> `.env` files — are stored in VS Code's workspace storage.

## Commands

- `direnv: Reload Environment`
- `direnv: Allow .envrc` / `direnv: Deny .envrc`
- `direnv: Open .envrc`
- `direnv: Show Output`

## Limitations

- Multi-root workspaces: the environment of the first local folder is used.
- Terminals cannot have variables unset, so variables direnv unsets are set to an empty value
  there.
