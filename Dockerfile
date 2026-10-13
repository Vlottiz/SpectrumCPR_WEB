# Node 22+ is required: the database uses the built-in node:sqlite module.
# Alpine keeps the image small, and nothing here needs a compiler.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first so edits to source don't bust the layer cache.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY index.html admin.html ./
COPY g214.svg g214-dark.svg* ./

# The SQLite file lives on a mounted volume so bookings survive a rebuild.
RUN mkdir -p /data && chown -R node:node /data /app
ENV DB_PATH=/data/booking.db
VOLUME ["/data"]

USER node
EXPOSE 3000

# Fails the container if the API stops answering, so the NAS can restart it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
