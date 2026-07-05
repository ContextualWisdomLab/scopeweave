FROM nginx:1.25-alpine
COPY infra/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY index.html 404.html app.js styles.css wbs.json /usr/share/nginx/html/
COPY docs/user-guide.md /usr/share/nginx/html/docs/

# Strix security scan recommendation: switch to non-root user
# For nginx to work as non-root, it needs access to run/cache directories
RUN touch /var/run/nginx.pid && \
  chown -R nginx:nginx /var/run/nginx.pid /var/cache/nginx

USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]
