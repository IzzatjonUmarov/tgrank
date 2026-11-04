FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production DB_PATH=/app/data/tgrank.db
VOLUME /app/data
EXPOSE 3000
CMD ["sh", "-c", "node --no-warnings src/seed.js && node --no-warnings server.js"]
