# Node 22+ is required: the database uses the built-in node:sqlite module.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Public pages live in their own folder so source code is never served.
COPY index.html admin.html guide.html g214.svg g214-dark.svg* g214LONG.png g214LONG2.png ./public/

# The SQLite file lives on a mounted volume so bookings survive a rebuild.
RUN mkdir -p /data
ENV DB_PATH=/data/booking.db
ENV SITE_DIR=/app/public
VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]