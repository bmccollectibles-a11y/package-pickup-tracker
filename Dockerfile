FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/var/data
ENV SHIPPO_CARRIER=ups
ENV SHIPPO_TIMEOUT_MS=20000

EXPOSE 3000

CMD ["npm", "start"]
