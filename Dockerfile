FROM oven/bun:1.3.13-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# dist/ is a self-contained bundle (dependencies and assets included), so the
# runtime image needs no node_modules. Migrations are read from ./drizzle.
FROM oven/bun:1.3.13-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
USER bun
EXPOSE 2800
CMD ["bun", "dist/http.js"]
