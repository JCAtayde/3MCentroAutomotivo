FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
