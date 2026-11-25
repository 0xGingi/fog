# syntax=docker/dockerfile:1
# One image: the Rust server, serving the web app it was built with.
# Build images are pinned to exact versions so anyone can rebuild the web app byte-for-byte and
# compare it with what getfog.org serves (web/verify.ts).

# ---- Rust: server binary + wasm crypto core ----
FROM rust:1.100.0-bookworm AS rust
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown && cargo install wasm-bindgen-cli --version 0.2.130 --locked
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY core core
COPY server server
RUN cargo build --release -p fog-server \
 && cargo build --release -p fog-core --target wasm32-unknown-unknown \
 && wasm-bindgen --target web --out-dir /core target/wasm32-unknown-unknown/release/fog_core.wasm

# ---- Web: bun + vite ----
FROM oven/bun:1.4.5 AS web
WORKDIR /web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web .
COPY --from=rust /core src/core
RUN bun run build

# ---- Runtime ----
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 fog && mkdir -p /data && chown fog /data
COPY --from=rust /src/target/release/fog-server /usr/local/bin/fog-server
COPY --from=web /web/dist /srv/web
ENV FOG_ADDR=0.0.0.0:8787 FOG_DB=/data/fog.db FOG_BLOBS=/data/blobs FOG_WEB=/srv/web FOG_STUN=off
USER fog
VOLUME /data
EXPOSE 8787
CMD ["fog-server"]
