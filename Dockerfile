FROM mcr.microsoft.com/playwright:v1.56.1-noble

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/var/data
ENV TRACKER_MODE=scrape
ENV UPS_SCRAPER_ENGINE=browser
ENV CHROME_EXECUTABLE_PATH=

EXPOSE 3000

CMD ["npm", "start"]
