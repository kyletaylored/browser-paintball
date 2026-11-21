# Splat Arena: project instructions

Original browser paintball game: Vite + TypeScript + three.js client, Node WebSocket server, shared sim code in `shared/`.
See README.md for layout and run steps.

## Hard rules

### Never push anything sensitive

This repository is **public**. Before every commit and push, check `git diff --cached` for:

- secrets: API keys, tokens, passwords, private keys, `.env` files, connection strings, session cookies
- personal data: names, email addresses, phone numbers, home addresses, account IDs of real people
- machine-specific paths (e.g. `C:\Users\...`, home directories) and local tool config with absolute paths
- logs, dumps, or captured network traffic

Config that needs secrets reads them from environment variables; commit only a `.env.example` with placeholder values.
If something sensitive is ever committed, stop and tell the user before pushing. Do not try to quietly rewrite public history.

### Never use real paintball names

For IP reasons, do not use the name, logo or look of any real paintball company, brand, product or product line
(markers, hoppers, tanks, masks, paint, bunkers), league, team, event, field or venue, or player. This applies to the
game itself (in-game text, models, textures, sounds) and to everything else in the repo and its GitHub activity: code,
comments, docs, asset and file names, commit messages, branch names, issues, PRs and review comments. Do not name or
imitate the game this project was inspired by either.

- Use generic terms instead: marker, hopper, tank, bunker, field, team, league, tournament.
- Invented names for in-game things are fine as long as they are original and do not imitate a real brand.
- This rule is about paintball IP only. Infrastructure vendors and tools (hosting providers, CDNs, libraries, services
  the project deploys to) may be named in docs, config and code.

## Workflow

- Backlog lives in GitHub issues. Work one issue per branch (`feat/...`, `fix/...`), open a PR that says `Closes #N`.
- Before opening a PR: `npm run typecheck`, `npm run build` and `npm test` (codec round-trips + server smoke test, which starts its own servers).
- Keep `shared/` free of DOM and Node-only APIs: both the browser and the server import it.
- The server is the authority on hits and eliminations. Never let a client message decide a hit.
