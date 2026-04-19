---
name: Caveat contribution (knowledge)
about: Propose a caveat for the shared knowledge DB manually (prefer `caveat push`)
title: 'caveat: '
labels: caveat-contribution
---

<!--
If you have `gh` CLI authenticated, the preferred path is:

    caveat push <entry-id>

That opens a PR with the md file correctly placed under `entries/<category>/`.
This issue template exists for the case where `caveat push` is unavailable (no
gh CLI, constrained env, etc.) — paste the md content below and a maintainer
will add it.
-->

## Proposed caveat

```markdown
---
id: <slug>
title: <one-line title>
visibility: public
confidence: <confirmed | reproduced | tentative>
outcome: <resolved | impossible>
tags: []
environment: {}
source_project: null
source_session: "YYYY-MM-DDTHH:MM:SSZ/000000000000"
created_at: YYYY-MM-DD
updated_at: YYYY-MM-DD
last_verified: YYYY-MM-DD
---

## Symptom
## Cause
## Resolution
## Evidence
```

## Category

<!-- e.g. gpu, claude-code, docker, nodejs. Used as the subdir under entries/. -->
