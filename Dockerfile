FROM node:20-alpine

# Install git and openssh (required for simple-git and WP Engine GitPush)
RUN apk add --no-cache git openssh-client

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 8080

CMD ["node", "src/webhook.js"]
