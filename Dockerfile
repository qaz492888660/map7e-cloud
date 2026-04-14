FROM php:8.3-apache

WORKDIR /app

RUN a2enmod rewrite

COPY docker/apache-site.conf /etc/apache2/sites-available/000-default.conf
COPY . /app

RUN mkdir -p /app/storage \
    && chown -R www-data:www-data /app/storage \
    && chmod -R 775 /app/storage

EXPOSE 80
