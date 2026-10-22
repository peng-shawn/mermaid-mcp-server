# No browser needed: Mermaid runs on a geometry-faithful DOM in Node, and PNGs
# come from resvg. Fonts are bundled (DejaVu), so the image needs none; install
# fonts-noto-cjk or fonts-noto-color-emoji if your diagrams use CJK or emoji.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Native modules ship prebuilt binaries; skipping install scripts also stops
# the Puppeteer dev dependency (accuracy tests only) from downloading Chrome
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p .

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
 # The server loads Mermaid's core ESM build only; drop the other bundles,
 # source maps, and the musl binaries this glibc image can't use (~230 MB)
 && cd node_modules/mermaid/dist \
 && rm -rf chunks/mermaid.esm chunks/mermaid.esm.min mermaid.js mermaid.min.js mermaid.esm*.mjs \
 && find /app/node_modules -name "*.map" -delete \
 && rm -rf /app/node_modules/@napi-rs/*-musl /app/node_modules/@resvg/*-musl
COPY --from=build /app/dist ./dist
COPY assets ./assets
USER node
ENTRYPOINT ["node", "dist/index.js"]
