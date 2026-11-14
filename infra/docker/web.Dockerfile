# Builds the Next.js product app as a standalone server.
#   docker build -f infra/docker/web.Dockerfile -t openline-web .
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@openline/web...

FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
