# Календарь звонков (продолжение)


[![Check](https://github.com/sas2job/ai-for-developers-project-387/actions/workflows/check.yml/badge.svg)](https://github.com/sas2job/ai-for-developers-project-387/actions/workflows/check.yml)
[![hexlet-check](https://github.com/sas2job/ai-for-developers-project-387/actions/workflows/hexlet-check.yml/badge.svg)](https://github.com/sas2job/ai-for-developers-project-387/actions/workflows/hexlet-check.yml)

Сервис бронирования звонков, перенесённый из проекта «Календарь звонков». Текущие задачи ведутся в [GitHub Issues этого репозитория](https://github.com/sas2job/ai-for-developers-project-387/issues).

Учебный проект Хекслета: https://ru.hexlet.io/programs/ai-for-developers
Как это должно работать: https://files.hexlet.app/a/2ipc5m

## Разработка через GitHub

Процесс: обращение → предложение спецификации и тикетов → подтверждение человеком → реализация → PR → независимое ревью → исправления в той же ветке → решение человека о мерже.

Actions готовит задания по командам `/agent plan`, `/agent approve SHA256`, `/agent implement`, `/agent review` и `/agent fix`. Агент выполняет задание локально; проверенный результат переносится в GitHub отдельным publisher. Регулярный аудит health endpoint работает по расписанию и создаёт issues только по новым находкам. Права, инициаторы, число запусков и таймауты ограничены.

Команды, ручные согласования, формат артефактов, ограничения выбранного режима и порядок активации описаны в [инструкции процесса](docs/agents/github-automation.md). Зафиксированные версии скиллов находятся в [docs/agents/skills](docs/agents/skills/source.json). Проверки обработчиков запускаются через `npm run test:agents` и включены в `bin/check`.

Демонстрационная доработка: [обращение #4](https://github.com/sas2job/ai-for-developers-project-387/issues/4) → [спецификация #5](https://github.com/sas2job/ai-for-developers-project-387/issues/5) → [тикет #6](https://github.com/sas2job/ai-for-developers-project-387/issues/6). Человек согласовал план и HTTP-/браузерные проверки; ссылки на PR и результаты ревью будут добавлены после проверки.

## Как открыть приложение

Адрес предыдущего проекта: https://ai-hexlet.duckdns.org. При проверке 13 ноября 2026 года HTTPS-соединение завершилось ошибкой TLS. Для проверки приложения наставником запустите локальную копию; нужны Git, Docker с Compose и OpenSSL:

```bash
git clone https://github.com/sas2job/ai-for-developers-project-387.git
cd ai-for-developers-project-387
export SECRET_KEY_BASE="$(openssl rand -hex 64)"
docker compose up --build
```

Откройте [главную страницу](http://localhost:3000), [управление календарём](http://localhost:3000/admin) или [запись на звонок](http://localhost:3000/book). Сначала создайте тип встречи в управлении календарём, затем пройдите гостевой сценарий. База и таблицы создаются при старте контейнера. Остановка: `docker compose down`; для повторного запуска в том же терминале — `docker compose up`.

## Спецификация и решения первого проекта

- [Исходный репозиторий](https://github.com/sas2job/ai-for-developers-project-386).
- [Спецификация MVP и план реализации, issue #9](https://github.com/sas2job/ai-for-developers-project-386/issues/9).
- [Карта решений, issue #1](https://github.com/sas2job/ai-for-developers-project-386/issues/1), и согласования: [сущности](https://github.com/sas2job/ai-for-developers-project-386/issues/2), [календарное окно](https://github.com/sas2job/ai-for-developers-project-386/issues/3), [слоты](https://github.com/sas2job/ai-for-developers-project-386/issues/4), [хранение и пересечения](https://github.com/sas2job/ai-for-developers-project-386/issues/5), [пользовательские сценарии](https://github.com/sas2job/ai-for-developers-project-386/issues/6), [API](https://github.com/sas2job/ai-for-developers-project-386/issues/7), [тестирование](https://github.com/sas2job/ai-for-developers-project-386/issues/8).
- Сохранены [словарь](GLOSSARY.md) и ADR: [один владелец](docs/adr/0001-one-owner-without-authentication.md), [вход в запись](docs/adr/0002-stable-booking-entry.md), [приватность email](docs/adr/0003-hide-guest-email-in-public-list.md), [защита от пересечений](docs/adr/0004-postgresql-booking-overlap-constraint.md).
- Инструкции агента: [AGENTS.md](AGENTS.md); настройки скиллов: [трекер](docs/agents/issue-tracker.md), [метки](docs/agents/triage-labels.md), [документы предметной области](docs/agents/domain.md).

## Сценарий записи

1. Владелец календаря открывает раздел управления и создаёт тип встречи: указывает название, описание и длительность.
2. Гость без регистрации открывает каталог типов встреч и выбирает подходящий тип.
3. Гость видит календарь на ближайшие 14 календарных дней, выбирает день и свободное время. Длительность слота равна длительности выбранного типа встречи.
4. Гость подтверждает запись. Занятый интервал больше не предлагается для других встреч, в том числе встреч другого типа.
5. Владелец видит новую запись в общем списке предстоящих встреч всех типов.

Приложение рассчитано на одного заранее заданного владельца. Авторизация, личные кабинеты, внешние календари и уведомления не входят в сценарий. Пересечение встреч, включая частичное, запрещено и при одновременных запросах; следующая встреча может начаться в момент окончания предыдущей. Точные часы работы, часовой пояс и шаг начала слотов будут зафиксированы в спецификации.


## Стек

- Ruby on Rails 8.1, Hotwire (Turbo и Stimulus), PostgreSQL
- JavaScript и esbuild для интерфейса
- TypeSpec → OpenAPI → JavaScript SDK для API
- Minitest, RuboCop, Oxlint и oxfmt для проверок

## Установка

Нужны PostgreSQL 18, Ruby 4.0.2 и Node.js 24.19.0. Версии Ruby и Node.js зафиксированы в `.ruby-version` и `.node-version`. Для локальной базы нужна роль PostgreSQL с правом создавать базы; подключение настраивается переменными `DB_HOST`, `DB_PORT`, `DB_USER` и `DB_PASSWORD`.

```bash
git clone https://github.com/sas2job/ai-for-developers-project-387.git
cd ai-for-developers-project-387
bundle install
npm ci
bin/rails db:prepare
git config core.hooksPath .githooks
```

## Использование

```bash
bin/dev       # сервер на http://localhost:3000 и сборка JavaScript с отслеживанием изменений
bin/check     # RuboCop, Oxlint, oxfmt, проверка генерации API, сборка JavaScript, Rails- и браузерные тесты
```

Для `bin/check` дополнительно нужны Java 17+ для генератора SDK и Google Chrome для системных тестов. В GitHub Actions проверки запускаются workflow [Check](.github/workflows/check.yml) с отдельной базой PostgreSQL.

После изменения `api/main.tsp` запустите `npm run api:generate` и сохраните обновлённые OpenAPI и SDK. API поддерживает проверку состояния, типы встреч, поиск слотов, создание записи и список предстоящих встреч. Гость записывается через `/book`, владелец управляет типами и видит встречи на `/admin`.

Docker-образ можно собрать и запустить так:

```bash
SECRET_KEY_BASE="$(openssl rand -hex 64)" docker compose up --build
```

Контейнер приложения подключается к PostgreSQL из `compose.yaml`. Данные базы хранятся в Docker volume `postgres_data`; удалите его командой `docker compose down --volumes`.

## Публикация на VPS

Production Docker-образ запускает Puma на порту из `PORT` (по умолчанию `3000`). Для своего VPS используйте `compose.vps.yaml`: он подключает приложение к внешней Docker-сети `leave-desk_default`, поэтому PostgreSQL и Caddy могут оставаться отдельными сервисами. Файл `.env.vps` содержит параметры подключения и секреты; храните его только на сервере и не добавляйте в Git. Образ можно собрать и запустить командами `docker compose --env-file .env.vps -f compose.vps.yaml up -d --build`.

Адрес VPS предыдущего проекта: https://ai-hexlet.duckdns.org; результат проверки и локальный запуск описаны в разделе «Как открыть приложение». Данные встреч хранятся в PostgreSQL на существующем VPS и переживают перезапуск контейнера приложения. Они пропадут при удалении базы или её Docker volume; резервное копирование на VPS нужно настраивать отдельно.

Для этого VPS нет доступного MCP-сервера управления, поэтому деплой выполняется по SSH. Безопасный шаблон подключения и команды деплоя приведены в [инструкции для агента](docs/deployment-vps.md); ключи и `.env.vps` остаются вне репозитория.

---

<details>
<summary>Автоматические тесты Хекслета</summary>

Тесты запускаются на каждый коммит. За запуск отвечает файл `.github/workflows/hexlet-check.yml` — не удаляйте и не переименовывайте ни его, ни репозиторий.

</details>

## О Хекслете

[Хекслет](https://ru.hexlet.io/) — школа программирования: авторские программы обучения с практикой, поддержкой наставников и реальными проектами, которые остаются в резюме. Этот репозиторий — один из таких проектов.
