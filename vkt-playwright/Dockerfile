FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

COPY vkt-playwright/package.json ./
RUN npm install
RUN npx playwright install chromium

COPY vkt-playwright/scraper.js ./

CMD ["node", "scraper.js"]
