# Repository Guidelines

## Project Structure & Module Organization

macii is a local AI agent hub using Node.js, SQLite, and WebSockets.

- `server/`: HTTP API, persistence, scheduling, task dispatch, and run management; CLI integrations live in `server/adapters/`, and the inbox MCP server in `server/mcp/`.
- `web/`: directly served HTML, JavaScript, CSS, and logo assets. Shared client state lives in `app.js`; appearance uses `theme.css` and `theme-boot.js`.
- `electron/main.js`: desktop shell and hub lifecycle.
- `test/`: automated tests; `mockups/`: original design explorations.
- `data/`: ignored runtime database, uploads, logs, and graphs. `tools/graphify/` holds the ignored optional Python environment.

## Build, Test, and Development Commands

Use Node.js 24+ for built-in `node:sqlite` support.

- `npm install`: install dependencies.
- `npm start`: serve the hub at `http://127.0.0.1:4747`.
- `npm run app`: launch Electron; `app.cmd` is the Windows shortcut.
- `npm test`: run all `test/*.test.js` files with Node's test runner.
- `node --test test/tasks.test.js`: run one test file.
- `npm run setup:graphify`: install the pinned optional Graphify dependency on Windows; requires `uv` and Git.

There is no compilation or bundling step.

## Coding Style & Naming Conventions

Match existing JavaScript ES modules: two-space indentation, single quotes, semicolons, and explicit `.js` extensions in relative imports. Use camelCase for functions and variables, PascalCase for classes, and descriptive lowercase filenames such as `runner-queue.test.js`. Preserve existing snake_case database fields. No formatter or linter is configured.

Use theme CSS variables for new UI colours, and load `theme-boot.js` on new pages. Verify appearance in both light and dark modes.

## Testing Guidelines

Use `node:test` and `node:assert/strict`. Name tests `test/<feature>.test.js` with descriptive behaviour-based cases. Isolate filesystem and SQLite fixtures in temporary directories, close databases, and clean up afterward. Stub external runners and services. Add regression tests for changed behaviour and run `npm test` before submitting. No coverage threshold is configured.

## Commit & Pull Request Guidelines

History uses short, descriptive subjects, sometimes prefixed by a feature area, such as `Chat: send images to agents`. Follow that style and keep commits focused. PRs should explain the problem, resulting behaviour, and validation; link relevant issues and include screenshots for UI changes.

## Security & Configuration

Use `AIOS_PORT` and `AIOS_DATA` to override local defaults. Keep runtime data and credentials out of commits. Preserve loopback binding, Host/Origin checks, JSON write validation, MCP token checks, and API-key removal from agent subprocess environments. Never run `graphify install` or its hooks here; they modify assistant configuration.
