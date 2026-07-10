FROM nginx:1.25-alpine@sha256:516475cc129da42866742567714ddc681e5eed7b9ee0b9e9c015e464b4221a00
COPY infra/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY index.html 404.html app.js styles.css wbs.json /usr/share/nginx/html/
COPY docs/user-guide.md /usr/share/nginx/html/docs/

# Strix security scan recommendation: switch to non-root user
# For nginx to work as non-root, it needs access to run/cache directories
RUN touch /var/run/nginx.pid && \
  chown -R nginx:nginx /var/run/nginx.pid /var/cache/nginx

USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
CMD ["nginx", "-g", "daemon off;"]
