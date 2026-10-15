FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Aucune dépendance npm n'est nécessaire à l'exécution (node:sqlite intégré à Node 22).
COPY package.json server.js schema.sql ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "--no-warnings=ExperimentalWarning", "server.js"]
