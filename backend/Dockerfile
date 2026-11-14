FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    DJANGO_SETTINGS_MODULE=config.settings_cloud PORT=8080
WORKDIR /app
COPY requirements.txt requirements-cloud.txt ./
RUN pip install --no-cache-dir -r requirements-cloud.txt
COPY . .
# Static collection doesn't connect to the database or bucket. No runtime secrets enter the image.
RUN DJANGO_SECRET_KEY=build-only-placeholder-not-a-runtime-secret-1234567890 \
    DATABASE_NAME=build DATABASE_USER=build DATABASE_PASSWORD=build DATABASE_HOST=localhost \
    DJANGO_ALLOWED_HOSTS=localhost CORS_ALLOWED_ORIGINS=https://example.invalid \
    GS_BUCKET_NAME=build-only-placeholder \
    python manage.py collectstatic --noinput
RUN useradd --create-home --uid 10001 appuser
USER appuser
EXPOSE 8080
CMD ["sh", "-c", "exec gunicorn config.wsgi:application --bind 0.0.0.0:${PORT:-8080} --workers 1 --threads 8 --timeout 120 --access-logfile - --error-logfile -"]
