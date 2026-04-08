FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

COPY vkt-playwright/package.json ./
RUN npm install
RUN npx playwright install chromium

COPY vkt-playwright/scraper.js ./
COPY vkt-playwright/seeder.js ./
COPY vkt-playwright/index.js ./

CMD ["node", "index.js"]
