FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code and generate Prisma Client
COPY . .
RUN npx prisma generate
RUN npm run build

# Production image
FROM node:22-alpine

WORKDIR /app

# Copy built artifacts and dependencies
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Start the application
CMD ["npm", "run", "start:prod"]
