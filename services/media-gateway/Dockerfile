FROM node:22-alpine

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node lib ./lib
COPY --chown=node:node services/media-gateway/package.json ./services/media-gateway/package.json
COPY --chown=node:node services/media-gateway/src ./services/media-gateway/src

WORKDIR /app/services/media-gateway
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
