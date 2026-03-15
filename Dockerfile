# Use official Puppeteer image — Chrome pre-installed
FROM ghcr.io/puppeteer/puppeteer:21.11.0

WORKDIR /app

USER root

# Increase shared memory — Chrome needs this for multiple instances
RUN echo "tmpfs /dev/shm tmpfs defaults,size=512m 0 0" >> /etc/fstab 2>/dev/null || true

COPY package.json ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p .wa-session && chmod -R 777 .wa-session && chmod -R 777 /app

# Stay as root — avoids permission issues when spawning multiple Chrome processes
USER root

EXPOSE 3000
CMD ["node", "--max-old-space-size=512", "app.js"]
