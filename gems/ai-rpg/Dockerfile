# Dockerfile — multi-stage build for the ai-rpg gem.
# Mirrors templates/Dockerfile.gem.tmpl, with the runtime CMD pointed at
# `dist/src/server.js` because the tsconfig's `rootDir: "."` plus
# `include: ["src/**/*", ...]` causes tsc to emit at `dist/src/server.js`
# (matching the `start` script in package.json).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --no-audit --no-fund && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Drop the __tests__ folder and dev deps for a smaller runtime image.
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
EXPOSE 8080
USER node
CMD ["node", "dist/src/server.js"]
