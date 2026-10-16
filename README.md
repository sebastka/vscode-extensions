# VS Code extensions

Monorepo for my VS Code extensions.

| Extension                                    | Description                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| [direnv-trusted](extensions/direnv-trusted/) | Loads the direnv environment, only for trusted workspaces and allowed `.envrc` files. |

## Requirements

- Node.js >= 26 (see [.nvmrc](.nvmrc)) and npm >= 11
- [direnv](https://direnv.net/) >= 2.33, for the direnv-trusted tests

## Development

```sh
npm ci
npm run build        # bundle every extension into its dist/
npm run lint         # ESLint (type-aware)
npm run typecheck    # tsc
npm test             # node --test
npm run format       # Prettier
npm run package      # build a .vsix per extension
```

To run an extension in a development window, open this folder in VS Code and press <kbd>F5</kbd>
(see [.vscode/launch.json](.vscode/launch.json)).

### Layout

- `extensions/<name>/`: one npm workspace per extension, self-contained (own `package.json`,
  `tsconfig.json`, `eslint.config.ts`, tests), so that it can be moved to its own repository.
- `tsconfig.base.json`: shared TypeScript settings.

## Contributing

`master` is protected: changes go through pull requests, which need the `ci` and `yamllint`
checks to pass. Merged branches are deleted automatically.

Dependencies are pinned to exact versions (npm lockfile integrity hashes, GitHub Actions by
commit SHA, pip requirements by hash) and kept up to date by Dependabot. Non-major updates are
merged automatically once the checks pass; majors wait for review.

## Releasing

Each extension is released on its own, from a tag named `<extension>-v<version>`:

1. In a pull request, bump `version` in `extensions/<extension>/package.json` and update its
   `CHANGELOG.md`.
2. Once merged, tag the merge commit and push the tag:

   ```sh
   git tag direnv-trusted-v0.1.0 && git push origin direnv-trusted-v0.1.0
   ```

The [release workflow](.github/workflows/release.yaml) runs the CI checks, verifies that the tag
matches the version in `package.json`, then publishes the `.vsix` to the
[VS Marketplace](https://marketplace.visualstudio.com/) and [Open VSX](https://open-vsx.org/),
and attaches it to a GitHub release. It runs in the `release` environment, which only release
tags can deploy to, using the `VSCE_PAT` and `OVSX_PAT` secrets of that environment.

### Publishing credentials

| Secret (`release` environment) | Registry       | Expires        | Renew at                                                                                    |
| ------------------------------ | -------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `VSCE_PAT`                     | VS Marketplace | **2027-10-15** | [Azure DevOps personal access tokens](https://dev.azure.com/sebastka/_usersSettings/tokens) |
| `OVSX_PAT`                     | Open VSX       | Never          | [Open VSX access tokens](https://open-vsx.org/user-settings/tokens)                         |

To renew `VSCE_PAT`, create a new token with organization **All accessible organizations** and
the single scope **Marketplace > Manage** (under "Show all scopes"), then replace the secret:

```sh
gh secret set VSCE_PAT --env release
```

Until it is renewed, the Marketplace publish step of the release workflow fails with an
authentication error. The [token expiry workflow](.github/workflows/token-expiry.yaml) opens an
issue 30 days before the expiry date; update the date there too when renewing.
