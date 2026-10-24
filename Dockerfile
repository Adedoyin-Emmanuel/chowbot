FROM oven/bun:1.3.13-slim AS build
WORKDIR /app

COPY package.json bun.lock ./
COPY mcp-server/package.json mcp-server/
COPY auth/package.json auth/
COPY web/package.json web/
RUN bun install --frozen-lockfile --filter '@chowbot/mcp-server' --filter '@chowbot/auth'
COPY mcp-server mcp-server
COPY auth auth
RUN cd mcp-server && bun run build && cd ../auth && bun run build


FROM oven/bun:1.3.13-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/mcp-server/dist ./dist
COPY --from=build /app/mcp-server/drizzle ./drizzle
COPY --from=build /app/auth/dist ./auth/dist
USER bun
EXPOSE 2800
CMD ["bun", "dist/http.js"]
