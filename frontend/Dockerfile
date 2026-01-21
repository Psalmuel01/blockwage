# Stage 1: build the Next.js app
FROM node:18-alpine AS builder

# Install deps required for building
RUN apk add --no-cache libc6-compat git

WORKDIR /usr/src/app

# Copy package manifests first to leverage layer caching
COPY package.json package-lock.json* ./

# Install all dependencies (including devDependencies) to build the app
RUN npm ci

# Copy the rest of the source
COPY . .

# Build the Next.js app
RUN npm run build

# Stage 2: production image
FROM node:18-alpine AS runner

# Create a non-root user to run the app
RUN addgroup -S nextgroup && adduser -S nextuser -G nextgroup

WORKDIR /usr/src/app

ENV NODE_ENV=production
ENV PORT=3000

# Copy only the necessary build artifacts and production dependencies
# - package.json is copied so `npm ci --production` could be used alternatively
# - .next and public are required to run the Next.js server
COPY --from=builder /usr/src/app/.next ./.next
COPY --from=builder /usr/src/app/public ./public
COPY --from=builder /usr/src/app/package.json ./package.json
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/next.config.js ./next.config.js

# Optional: if you want to prune dev deps and install only production deps instead of copying node_modules,
# replace the node_modules COPY above with:
# RUN npm ci --only=production

# Make sure permissions are correct for the non-root user
RUN chown -R nextuser:nextgroup /usr/src/app

# Switch to the non-root user
USER nextuser

EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- --timeout=2 http://localhost:${PORT}/health || exit 1

# Start the Next.js production server
CMD ["npm", "run", "start"]
