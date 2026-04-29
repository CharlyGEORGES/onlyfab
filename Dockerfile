FROM node:20-alpine

WORKDIR /app

# Install build deps for better-sqlite3 native addon
RUN apk add --no-cache python3 make g++

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm install --omit=dev

# Copy app files
COPY server.js bambu.js index.html ./

# Create uploads dir
RUN mkdir -p /data/uploads

EXPOSE 3000

CMD ["node", "server.js"]
