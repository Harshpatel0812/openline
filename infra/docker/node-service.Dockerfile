# Builds the api or worker image. Usage (from repo root):
#   docker build -f infra/docker/node-service.Dockerfile --build-arg APP=api -t openline-api .
#   docker build -f infra/docker/node-service.Dockerfile --build-arg APP=worker -t openline-worker .
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS build
ARG APP
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@openline/${APP}...
RUN pnpm --filter=@openline/${APP} deploy --prod --legacy /out

FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Run as the unprivileged "node" user, never root.
COPY --from=build --chown=node:node /out ./
USER node
# Starts whatever the package declares as "main" (api: dist/main.js, worker: dist/index.js).
CMD ["sh", "-c", "node \"$(node -p 'require(\"./package.json\").main')\""]
