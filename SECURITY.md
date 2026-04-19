# Security Policy

## Supported versions

Only the latest minor release of `caveat-cli` on npm is supported. Report issues against that version; older releases are not patched.

## Reporting a vulnerability

Please open a **private security advisory** on GitHub: https://github.com/kitepon-rgb/Caveat/security/advisories/new

Do **not** open a public issue for vulnerabilities.

Classes of issue we treat as security-sensitive:

- A path allowing a `visibility: private` entry to escape the pre-commit gate and reach a public git commit.
- `caveat_update` permitting mutation of an immutable frontmatter key (`id`, `created_at`, `source_session`, `source_project`).
- `caveat push` or `caveat community add` accepting a URL that bypasses the GitHub-only allowlist in `validateCommunityUrl`.
- The MCP server writing non-JSON-RPC content to stdout (breaks clients, potential injection vector).
- `parseMarkdown` accepting YAML tags outside `JSON_SCHEMA` (e.g. `!!js/function`).
- Any path where a user's `~/.claude/settings.json` backup is skipped when the installer mutates the file.

## Response

I aim to acknowledge reports within 72 hours and ship a patched release within two weeks when the report is reproducible. Coordinated disclosure is welcome.
