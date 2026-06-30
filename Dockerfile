# ==========================================
# STAGE 1: THE KITCHEN (Builder)
# ==========================================
FROM node:22-alpine AS builder

WORKDIR /app

RUN npm install --global pnpm@11.8.0

# 1. Install ALL dependencies (including heavy dev tools)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# 2. Copy the TypeScript source code
COPY . .

# 3. Compile the code to pure JavaScript (creates the /dist folder)
RUN pnpm run build
# ==========================================
# STAGE 2: THE DINING ROOM (Production)
# ==========================================
FROM node:22-alpine

WORKDIR /app

RUN npm install --global pnpm@11.8.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/dist ./dist

# 1. The Speed Boost
ENV NODE_ENV=production

# 2. The Documentation
EXPOSE 3000

# 3. The Security Lockdown (Strip Admin rights)
USER node

# 4. Turn the key
CMD ["node", "dist/main.js"]
