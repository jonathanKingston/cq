# AGENTS.md

## Cursor Cloud specific instructions

### Overview

cq is a monorepo with multiple components. See `DEVELOPMENT.md` for prerequisites and standard commands.

| Component | Path | Stack | Dev command |
|-----------|------|-------|-------------|
| Team API | `team-api/` | Python / FastAPI | `make dev-api` |
| Team UI | `team-ui/` | TypeScript / React / Vite | `make dev-ui` |
| MCP Server | `plugins/cq/server/` | Python / FastMCP | stdio (no standalone server) |
| Python SDK | `sdk/python/` | Python | tests only |
| Go SDK | `sdk/go/` | Go | tests only |
| CLI | `cli/` | Go | `make build` (in `cli/`) |

### Running services (no Docker)

Start the team API natively (creates `./dev.db` automatically):

```
make dev-api          # runs on :8742, sets CQ_JWT_SECRET=dev-secret
```

In a separate terminal, start the review dashboard:

```
make dev-ui           # runs on :3000, proxies /api/* -> :8742
```

To seed a demo user and sample knowledge units (API must be running):

```
uv run --directory team-api python scripts/seed-users.py --username demo --password demo123 --db ./dev.db
uv run --directory team-api python scripts/seed/load.py --user demo --pass demo123 --url http://localhost:8742
```

### Gotchas

- The seed scripts in the Makefile (`make seed-users`, `make seed-kus`, `make seed-all`) use `docker compose exec` and only work with Docker. For native dev, invoke the Python scripts directly as shown above.
- `golangci-lint` must be built with Go >= 1.26 to match the module requirements. Install via `go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.1.6` rather than the shell install script (which ships a pre-built binary compiled with an older Go).
- `make lint` includes `lint-sdk-go`, `lint-sdk-python`, `lint-cli`, and `lint-server`. The `lint-server` target also lints `team-ui` (TypeScript + ESLint) via `scripts/lint-frontend.sh`.
- `make test` runs Go SDK tests, Python SDK tests, CLI tests, schema validation, type checks (ty), and pytest for both the MCP server and team-api.
- The team-ui Vite proxy rewrites `/api/*` to `/*` on port 8742, so the frontend expects the API on `localhost:8742`.
