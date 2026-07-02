# Agent Instructions

## Git commits

When creating commits in this repository, **always commit as the user — never as Cursor or a Cursor agent.**

- Use the repository's configured git identity
- Do **not** set author or committer to names like "Cursor Agent", "cursor-agent", "Cursor", or any other automation identity
- Do **not** pass `--author` or `--committer` flags that override the user's identity
- Do **not** change `user.name` or `user.email` in git config to make commits appear as the agent
- Do **not** add `Co-authored-by` trailers to commit messages (e.g. `Co-authored-by: Cursor <cursoragent@cursor.com>`). GitHub treats these as co-authors even when the git author is correct.

If git identity is missing or wrong, ask the user to fix their local git config — do not substitute an agent identity.
