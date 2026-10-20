FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV HOST=0.0.0.0 DATA_DIR=/app/data MARKDOWN_EXPORT_DIR=/app/exports
EXPOSE 3000
CMD ["npm", "start"]
