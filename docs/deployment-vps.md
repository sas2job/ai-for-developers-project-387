# Доступ агента к VPS

Для этого VPS нет доступного MCP-сервера управления. Деплой проекта выполняется через SSH. Не добавляйте приватный ключ, пароль или файл `.env.vps` в репозиторий.

Добавьте на своей машине в `~/.ssh/config` локальный псевдоним, указав путь к своему приватному ключу:

```sshconfig
Host ai-hexlet-vps
  HostName 149.154.69.240
  Port 50022
  User root
  IdentityFile ~/.ssh/REPLACE_WITH_YOUR_PRIVATE_KEY
  IdentitiesOnly yes
  StrictHostKeyChecking yes
```

Проверьте SSH fingerprint сервера у провайдера и сохраните проверенный ключ хоста в `~/.ssh/known_hosts`. После этого агент может подключаться командой `ssh ai-hexlet-vps`. SSH-конфигурация и ключ остаются вне проекта.

На сервере хранится файл `/opt/ai-hexlet-calendar/.env.vps` с `PORT`, параметрами отдельной базы приложения, `APP_HOST` и `SECRET_KEY_BASE`. Ограничьте доступ к файлу владельцем сервиса. Для пересборки из каталога приложения выполните:

```bash
docker compose --env-file .env.vps -f compose.vps.yaml up -d --build
```

Существующий Caddy подключён к той же Docker-сети и направляет `ai-hexlet.duckdns.org` на `ai-hexlet-calendar:3000`; HTTPS-сертификат выпускается автоматически. Перезапуск контейнера приложения не удаляет записи: они лежат в отдельной базе PostgreSQL на существующем VPS и сохраняются в volume `leave-desk_postgres_data`. Удаление базы или её volume удалит данные; резервные копии нужно настраивать отдельно.
