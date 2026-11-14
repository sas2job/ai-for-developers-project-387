# Рабочие правила

- Запуск: `bundle install`, `npm ci`, `bin/rails db:prepare`, затем `bin/dev`.
- Все проверки: `bin/check`. Отдельно: `bin/rails test`, `bin/rubocop`, `npm run lint`, `npm run format:check`, `npm run build`.
- API: контракт в `api/main.tsp`. `api/generated/openapi.yaml` и `app/javascript/generated/src/` генерируются через `npm run api:generate`; редактируйте контракт и не правьте эти артефакты вручную.
- Устройство: Rails-контроллеры и представления в `app/`, JavaScript-контроллеры Stimulus в `app/javascript/controllers/`, тесты Minitest в `test/`.
- Git-хук вызывает `bin/check`; включить его можно командой `git config core.hooksPath .githooks`.
- Коммиты оформляйте по Conventional Commits: `feat:`, `fix:`, `test:`, `docs:`, `chore:` и другие стандартные типы.
- Каждый коммит реализации ссылается на свой GitHub Issue, например `feat: запись на свободный слот (#12)`.

## Agent skills

### Issue tracker

При работе со спецификациями и тикетами используйте GitHub Issues этого репозитория. См. `docs/agents/issue-tracker.md`.

### GitHub automation

Для команд `/agent`, согласования плана, передачи результатов локального агента, ревью PR и регулярного аудита читайте `docs/agents/github-automation.md`. Утверждение плана и решение о мерже принимает человек. Скиллы для этих стадий и их зафиксированный источник находятся в `docs/agents/skills/`.

### Triage labels

При разборе задач используйте стандартные метки triage. См. `docs/agents/triage-labels.md`.

### Domain docs

Для предметной области используйте один `GLOSSARY.md` и решения в `docs/adr/`. См. `docs/agents/domain.md`.
