FROM node:22

WORKDIR /app

COPY package*.json ./

RUN npm ci --no-audit --no-fund
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 3001

CMD ["npm", "start"]
