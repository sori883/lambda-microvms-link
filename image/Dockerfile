FROM public.ecr.aws/docker/library/node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server rsync git ca-certificates util-linux curl \
        tigervnc-standalone-server tigervnc-tools xfce4 xfce4-terminal chromium chromium-sandbox \
        dbus-x11 xauth x11-utils fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/ssh/ssh_host_* \
    && usermod --password '*' node \
    && install -d -o node -g node -m 0755 /workspace

WORKDIR /app
COPY --chown=node:node server.mjs ./
COPY --chown=node:node desktop.mjs ./
COPY --chmod=0755 mvm-sshd /usr/local/bin/mvm-sshd
COPY --chmod=0755 mvm-desktop /usr/local/bin/mvm-desktop
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
