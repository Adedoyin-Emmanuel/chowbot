# Chowbot

Order food from Chowdeck using AI assistants through MCP.

## Layout

A Bun workspace with three apps:

| Folder        | What it is                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `mcp-server/` | The MCP server: Chowdeck tools, OAuth (register, authorize, token), PostgreSQL storage.       |
| `auth/`       | The sign-in pages behind `/authorize`: React, TanStack Router, Tailwind CSS and shadcn/ui.   |
| `web/`        | The website: Next.js, Tailwind CSS and shadcn/ui.                                             |

The sign-in app is built to static files (`auth/dist`) that the MCP server serves on its own origin at `/authorize`. The server embeds the step and CSRF token in the page, and the app posts JSON to `/authorize/phone`, `/authorize/resend` and `/authorize/verify`. OAuth parameters and the full phone number never reach the browser.

## Development

```sh
bun install
docker compose up -d db                  # PostgreSQL for the MCP server

bun run --cwd mcp-server dev             # MCP server on :2800 (needs mcp-server/.env)
bun run --cwd auth dev                   # sign-in preview on :2801, fake Chowdeck, code 123456
bun run --cwd web dev                    # website on :3000
```

The sign-in preview runs the server's real authorize router with in-memory stores and a fake Chowdeck, so the pages can be worked on without sending real codes.

```sh
bun run --cwd mcp-server test            # server tests (PostgreSQL-backed suites need TEST_DATABASE_URL)
bun run build                            # build every app
docker build -t chowbot .                # MCP server + sign-in app image
```

## Find Me

<https://x.com/Emmysoft_Tm>
<https://adedoyin.dev>
