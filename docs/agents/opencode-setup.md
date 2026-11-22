# Подключение OpenCode к GitHub

Workflow [OpenCode](../../.github/workflows/opencode.yml) вызывает модель по новому
комментарию `/oc ЗАПРОС` или `/opencode ЗАПРОС` в issue, PR или строке diff.
Ответ появляется в том же обсуждении; при реализации OpenCode создаёт ветку и PR,
при доработке PR обновляет его ветку. Согласование плана и решение о мерже остаются
за человеком. Инструкции модели: [opencode.md](opencode.md).

Основная модель — `opencode/glm-5.3-flash-free`. Резервная —
`opencode/deepseek-v4.1-flash-free`. У обеих сейчас нулевая цена токенов и поддержка
инструментов. Бесплатные предложения временные, с ограничениями провайдера:
[актуальные условия OpenCode](https://opencode.ai/docs/zen/).

## Настройка владельцем

1. В [OpenCode Console](https://opencode.ai/console) откройте **Settings → Service
   accounts**. Для аккаунта проекта выберите вход **GitHub Actions**, репозиторий
   `sas2job/ai-for-developers-project-387`, **Runs from → Environment → opencode**.
   Права аккаунта: **Models · Request**. Выбранные бесплатные модели должны быть
   включены в workspace.
2. Создайте GitHub environment и сохраните выданный Console `client_id` в
   repository variable `OPENCODE_CLIENT_ID`:

   ```bash
   gh api --method PUT repos/sas2job/ai-for-developers-project-387/environments/opencode
   gh variable set OPENCODE_CLIENT_ID --body ВАШ_CLIENT_ID --repo sas2job/ai-for-developers-project-387
   ```

   `client_id` — публичный идентификатор аккаунта, а не секрет. Привязка Console
   проверяет GitHub repository и environment из подписанного OIDC-токена.
   Environment позволяет использовать и обсуждения issue/PR, и комментарии к
   строкам PR, у которых GitHub ref отличается от `main`.
3. Проверьте и смержите инфраструктурный PR. Обработчики комментариев GitHub берёт
   из default branch; обновлённая авторизация активируется после мержа.
4. В открытом issue напишите `/oc Прочитай AGENTS.md и объясни, как запустить проверки.
   Исходники менять не требуется.` Дождитесь ответа и завершения workflow
   [OpenCode](https://github.com/sas2job/ai-for-developers-project-387/actions/workflows/opencode.yml).
5. Для проверки записи кода согласуйте небольшую задачу, затем запросите её
   реализацию. Оставьте `/oc` с запросом доработки в созданном PR или на строке diff.
   Сохраните ссылки на ответ, PR и оба запуска Actions как подтверждение интеграции.

Для резерва владелец переключает repository variable:

```bash
gh variable set OPENCODE_MODEL --body opencode/deepseek-v4.1-flash-free --repo sas2job/ai-for-developers-project-387
```

Основная модель возвращается значением `opencode/glm-5.3-flash-free`.
Workflow допускает только эти два идентификатора. Переключение выполняют вручную:
повторный запуск после частично выполненных правок требует проверки ветки.

## Авторизация и ограничения

Для операций с репозиторием CLI `opencode github run` использует
`USE_GITHUB_TOKEN=true` и repository `GITHUB_TOKEN`. Установка GitHub App и PAT
не требуются. Для обращения к моделям отдельный шаг получает GitHub OIDC JWT с
audience `https://opencode.ai/console` и обменивает его в Console на временный
access token. Этот токен передаётся CLI как `OPENCODE_API_KEY` через `GITHUB_ENV`;
постоянный repository secret не нужен. Оба токена маскируются в логах; ошибки
не включают ответы сервера и значения credentials. Запросы ограничены таймаутом,
размером ответа и доверенными HTTPS endpoints; redirects запрещены.

В настройках Actions должно быть разрешено создание pull requests.
Версия CLI `1.19.5` и SHA-256 архива закреплены в
[локальном action установки](../../.github/actions/install-opencode/action.yml).
Каталог проектных скиллов задан в `opencode.json`. Старый composite action удалён из основной ветки OpenCode;
его плавающий тег здесь не используется.

Проверка до получения токена модели требует нового комментария, разрешённого
человека с правом `write`, неизменённого текста команды и открытого issue/PR.
PR из fork и повторный запуск через Re-run запрещены. Для нового запроса нужен
новый комментарий. Общие настройки инициаторов, выключателя и лимитов описаны
в [github-automation.md](github-automation.md).

Для OpenCode лимиты действуют за сутки UTC: по умолчанию 10 разрешённых попыток
на репозиторий и 6 на issue/PR. Разрешение резервируется артефактом до вызова
модели; отклонённые и обычные комментарии бюджет не расходуют. Проверки бюджета
сериализованы на репозиторий; работа модели — по номеру issue/PR. GitHub может
заменить ожидающий запрос в одной concurrency group более новым; такой запрос
повторяют после завершения текущего. Таймаут проверки — 5 минут, модели — 20 минут.

Проверяющая job имеет только чтение. Job модели получает `contents: write`,
`issues: write`, `pull-requests: write` и `id-token: write`. Только она входит в
environment `opencode` и обменивает OIDC-токен на доступ к моделям. Ruby, JavaScript
и отдельная тестовая PostgreSQL подготовлены для выполнения `bin/check`.
Публикация сессий отключена; вспомогательные запросы также используют бесплатную
модель. Другие секреты приложения workflow не передаёт.

Оба checkout используют `persist-credentials: false`. Для push Git получает
токен через credential helper, ограниченный `https://github.com` и окружением
шага `Run OpenCode`. Значение токена не записывается в Git-конфигурацию;
установка зависимостей выполняется без этой авторизации.

Push с `GITHUB_TOKEN` не запускает следующий workflow автоматически. После
создания или изменения PR человек запускает Check вручную для его ветки и
проверяет результат перед мержем:

```bash
gh workflow run check.yml --repo sas2job/ai-for-developers-project-387 --ref ИМЯ_ВЕТКИ_PR
```

Процесс `/agent` с точным SHA-256 согласованного плана, локальным выполнением
и проверенным publisher продолжает работать по
[своей инструкции](github-automation.md). `/oc` добавляет реальный модельный вызов;
его наличие само по себе не подтверждает завершение всех учебных сценариев.
