# The indexer. One image, one process.
#
# `node:sqlite` is built in and type stripping is on by default from Node 23.6,
# so there is no native module, no build stage and no compiled output to keep in
# step with the source. What runs in the container is the same TypeScript that
# runs from the repo.
FROM node:24-alpine

WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY services ./services
# The verification and repair scripts travel with the image. They are what the
# README points at when a burn predates the indexer's first checkpoint, and the
# place to run them is where the data is.
COPY scripts ./scripts
# The documents are served by the API they describe, so the two cannot drift
# apart.
COPY docs ./docs
# The verified starting states: the Telos finality-tree frontier extracted from a
# public snapshot (four kilobytes that otherwise cost a 3.6 TB download) and the
# WAX and XPR blockroot seeds. Only used on a first run with no saved state.
COPY data ./data

ENV DATA_DIR=/data \
    PORT=8899 \
    HOST=0.0.0.0 \
    API_BASE_PATH=/api

VOLUME ["/data"]
EXPOSE 8899

# Fail the container when the stream stalls, rather than sitting there quietly
# serving a tree that stopped growing four hours ago. `degraded` counts as alive
# on purpose: a sync-committee alarm is for a human, not for a restart loop.
# The space after the colon is not optional: `/health` is pretty-printed, so a
# pattern written without it matches nothing and the container never turns
# healthy — a check that always fails is worth less than no check at all.
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}${API_BASE_PATH}/health \
      | grep -qE '"status": *"(following|catching-up|degraded)"' || exit 1

CMD ["node", "services/indexer/index.ts"]
