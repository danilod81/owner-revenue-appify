# all Playwright browsers (Chromium, Chrome, Firefox, WebKit)
FROM apify/actor-node-playwright:latest
COPY package.json ./
RUN npm install --omit=dev
COPY . ./
CMD ["node", "main.js"]
