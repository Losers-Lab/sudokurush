FROM node:22-slim
WORKDIR /app

# workerd needs a CA trust store for outbound HTTPS; slim images ship without
# one and every outbound call fails certificate verification.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY client/package*.json client/
COPY worker/package*.json worker/

RUN npm --prefix client install --no-audit --no-fund \
 && npm --prefix worker install --no-audit --no-fund

EXPOSE 8787

CMD ["sh", "-c", "npm --prefix client run watch & exec npm --prefix worker run dev"]
