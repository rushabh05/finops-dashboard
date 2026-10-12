# FinOps Dashboard: zero npm dependencies, so there is nothing to install: the image is Node plus these files.
FROM node:22-slim

LABEL org.opencontainers.image.title="FinOps Dashboard" \
      org.opencontainers.image.description="Real-time dashboard for LLM + infrastructure cost per tenant, endpoint and call" \
      org.opencontainers.image.source="https://github.com/rushabh05/finops-dashboard" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY package.json LICENSE README.md SECURITY.md ./
COPY bin ./bin
COPY src ./src
COPY scripts ./scripts
COPY public ./public

# Databases live in /data (mount a volume there). Owned by the unprivileged user the container runs as.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data

# A container has to listen on 0.0.0.0 to be reachable through a published port, and the server REFUSES a non-loopback address without
# AUTH_TOKEN (>= 16 characters). So AUTH_TOKEN is required, deliberately: there is no insecure default to forget about.
# Publish the port to your own machine only:  -p 127.0.0.1:8787:8787
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `finops` is the entry point: the default command serves the dashboard; `docker run ... import claude-code` etc. work too.
ENTRYPOINT ["node", "bin/finops.js"]
CMD ["start"]
