# Security Policy

## Supported versions

Only the latest minor release of `caveat-cli` on npm is supported. Report issues against that version; older releases are not patched.

## Reporting a vulnerability

Please open a **private security advisory** on GitHub: https://github.com/kitepon-rgb/Caveat/security/advisories/new

Do **not** open a public issue for vulnerabilities.

Classes of issue we treat as security-sensitive:

- A path allowing a `visibility: private` entry to escape the pre-commit gate and reach a git commit (the gate is the user's last line of defense before any push to a shared repo).
- `caveat_update` permitting mutation of an immutable frontmatter key (`id`, `created_at`, `source_session`, `source_project`).
- `caveat community add` accepting a URL that bypasses the GitHub-only allowlist in `validateCommunityUrl`.
- The MCP server writing non-JSON-RPC content to stdout (breaks clients, potential injection vector).
- `parseMarkdown` accepting YAML tags outside `JSON_SCHEMA` (e.g. `!!js/function`).
- Any path where a user's `~/.claude/settings.json` backup is skipped when the installer mutates the file.

## Trust model (v0.7+)

Caveat does not validate or moderate content from arbitrary third parties. The tool was previously designed around a central shared community DB with `caveat push` (fork + PR), but that model was retired in v0.7 because no automated gate (regex, schema, or LLM oracle) can reliably distinguish well-crafted malicious entries from genuine ones — adversarial-gradient attacks against any such gate are tractable. Trust is therefore defined **socially**: you decide whose repos to subscribe to via `caveat community add`. Each subscriber should treat a community repo as exactly trustworthy as the people with write access to it.

## Response

I aim to acknowledge reports within 72 hours and ship a patched release within two weeks when the report is reproducible. Coordinated disclosure is welcome.
