FROM node:22-slim AS builder

WORKDIR /app

# Prisma needs openssl
RUN apt-get update -y && apt-get install -y openssl

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code and generate Prisma Client
COPY . .
RUN npx prisma generate
RUN npm run build

# Production image
FROM node:22-slim

WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl

# Copy built artifacts and dependencies
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Start the application
CMD ["npm", "run", "start:prod"]
