FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

# Copy source
COPY src/ ./src/
COPY public/ ./public/

# Data directory (mounted volume in production)
RUN mkdir -p /app/data

EXPOSE 3000

ENV NODE_ENV=production

CMD ["bun", "run", "src/index.ts"]
