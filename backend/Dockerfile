FROM node:22-alpine

WORKDIR /app

# better-sqlite3 has no musl prebuilt binary — compile it, then drop the toolchain.
# su-exec lets the entrypoint start as root (to own the Railway volume) and run the app as `node`.
RUN apk add --no-cache python3 make g++ su-exec

COPY package*.json ./
RUN npm ci && apk del python3 make g++

COPY . .

RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production
ENV AEGIS_DB_PATH=/app/data/aegis.db

EXPOSE 8080

COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
