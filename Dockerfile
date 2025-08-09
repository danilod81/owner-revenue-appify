FROM apify/actor-node-playwright:24.0.1
COPY package.json ./
RUN npm install --omit=dev
COPY . ./
CMD ["node", "main.js"]
