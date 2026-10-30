FROM node:22-alpine
WORKDIR /app
# node-forge: abre o certificado .pfx enviado pela tela do sistema.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.mjs icp-brasil.pem ./
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
