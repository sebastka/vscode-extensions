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
tags can deploy to. Both registries use trusted publishing (OIDC) unless a `VSCE_PAT` or
`OVSX_PAT` secret is set on that environment.
