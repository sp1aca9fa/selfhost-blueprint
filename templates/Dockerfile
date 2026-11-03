# Optional container for people who prefer `docker compose up` to the setup guide
# (docs/containers.md in the blueprint). The owner's server runs without it.
# Keep the Node version equal to .nvmrc.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
# The private submodule is not part of the image; scripts that need it skip themselves.
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-slim
WORKDIR /app
RUN corepack enable && useradd --create-home --uid 10001 app
COPY --from=build --chown=app /app /app
USER app
ENV NODE_ENV=production \
    MYAPP_DATA_DIR=/data \
    MYAPP_STATE_DIR=/data/state \
    DATABASE_URL=file:/data/myapp.db
VOLUME /data
EXPOSE 3000
CMD ["sh", "-c", "pnpm db:migrate && pnpm --filter @myapp/web start -H 0.0.0.0 -p 3000"]
