# ProShop Inspection Builder

A browser-based, local-first engineering tool for processing inspection data from Ground Control and exporting ProShop-compatible CSV files.

## Quick Start

1. Open `index.html` in any modern browser
2. Drag & drop a Ground Control CSV (or click **Import CSV**)
3. Configure rows using the sidebar (click any row)
4. Export to ProShop CSV when ready

## Development with Claude Code

```bash
cd proshop-inspection-builder
claude
```

Claude Code will read `CLAUDE.md` for project context and rules. Build features incrementally — see CLAUDE.md for the full spec and module responsibilities.

## Running Tests

Open `test/index.html` in a browser. Tests cover:
- CSV parsing
- Dimension text parsing (spec units, tolerances, notes)
- Math engine (nominal centering, plating, unit conversion, pin gage)

## Architecture

- **No build step** — vanilla JS with ES6 modules
- **No backend** — runs entirely in the browser
- **Single source of truth** — every row: `{ raw, user, computed }`

See `CLAUDE.md` for full architecture documentation.
