FROM nginx:1.25-alpine@sha256:516475cc129da42866742567714ddc681e5eed7b9ee0b9e9c015e464b4221a00
COPY infra/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY index.html 404.html app.js styles.css wbs.json /usr/share/nginx/html/
COPY docs/user-guide.md /usr/share/nginx/html/docs/
EXPOSE 80
USER nginx
CMD ["nginx", "-g", "daemon off;"]
