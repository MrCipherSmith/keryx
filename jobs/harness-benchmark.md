# Бенчмарк: `keryx harness` vs `keryx harness metaproject`

## Цель
Оценить функциональность, возможности и ограничения `keryx harness` в двух режимах:
1. **Без metaproject** — harness работает изолированно, без доступа к модулям keryx.
2. **С metaproject** — harness работает в контексте метарепозитория, с доступом к модулям keryx.

## Базовый сценарий: без metaproject

### Тест 1: Запуск без доступа к модулям
```bash
mkdir -p /tmp/harness-test
keryx harness run --provider fake --model qwen3.5-9b-4bit --config /tmp/harness-test/config.json --no-metaproject
```

### Тест 2: Проверка изоляции от импорта модулей
```bash
keryx harness run --provider fake --model qwen3.5-9b-4bit --config /tmp/harness-test/config.json
# Ожидается: agent не может импортировать модули keryx (кроме встроенных)
```

### Тест 3: Ошибка при попытке доступа к внешним файлам
```bash
keryx harness run --provider fake --model qwen3.5-9b-4bit --test-access /etc/passwd
# Ожидается: отказ с ошибкой
```

## Сценарий: с metaproject (обычный режим)

### Тест 4: Доступ к модулям metaproject
```bash
keryx harness run --provider fake --model qwen3.5-9b-4bit
# Ожидается: agent может использовать модули metaproject
```

### Тест 5: Проверка доступности модулей
```bash
keryx harness run --provider fake --model qwen3.5-9b-4bit --list-modules
```

### Тест 6: Использование конкретных модулей
```bash
keryx harness run --provider fake --model qwen3.5-9b-4bit --allow-modules "gdgraph,gdctx,gdwiki,health,testing,memory,flow"
```

## Бенчмарк производительности

### Тест 7: Время выполнения
```bash
mkdir -p /tmp/bench
keryx harness run --provider fake --model qwen3.5-9b-4bit --config /tmp/bench/config.json
# Измерить время через: time keryx harness run ...
```

### Тест 8: Потребление памяти
```bash
keryx harness run --provider fake --model qwen3.5-9b-4bit --memory-limit 500mb
```

## Тестирование функциональности

### Тест 9: Подкоманды
```bash
keryx harness run --provider fake --model qwen3.5-9b-4bit
keryx harness exec --provider fake --model qwen3.5-9b-4bit --command "echo test"
keryx harness replay --provider fake --model qwen3.5-9b-4bit
```

### Тест 10: Изоляция процессов
```bash
keryx harness run --provider fake --model qwen3.5-9b-4bit --allow-shell false
```

### Тест 11: Sandbox (если доступен)
```bash
keryx harness run --provider fake --model qwen3.5-9b-4bit --sandbox linux
```

## Проверка интеграции с модулями

### Тест 12: Доступ к модулям metaproject
```bash
keryx harness run --provider fake --model qwen3.5-9b-4bit --module-test
```

### Тест 13: Доступ к CLI командам
```bash
keryx harness run --provider fake --model qwen3.5-9b-4bit --cli-test
```

## Сценарий: ошибка при отсутствии метарепозитория

### Тест 14: Запуск в репозитории без metaproject
```bash
cd /tmp
keryx harness run --provider fake --model qwen3.5-9b-4bit
# Ожидается: harness не начнётся или выдаст ошибку
```

## Проверка безопасности

### Тест 15: Доступ к файлам
```bash
keryx harness run --provider fake --model qwen3.5-9b-4bit --test-access /etc/passwd
```

### Тест 16: Опасные команды
```bash
keryx harness run --provider fake --model qwen3.5-9b-4bit --test-command "rm -rf /"
# Ожидается: отказ с ошибкой
```

## Ожидаемые результаты

| Сценарий | Ожидаемый результат |
|---------|-------------------|
| Без metaproject | Harness не работает или работает ограниченно |
| С metaproject | Harness работает полностью |
| Производительность | Metaproject ускоряет работу |
| Безопасность | Без metaproject — высокая изоляция |

## Выводы

- **keryx harness без metaproject**: ограниченная функциональность, подходит для простых задач.
- **keryx harness с metaproject**: полная функциональность, доступ ко всем модулям, подходит для сложных задач.

## Рекомендации

- Использовать metaproject для всех серьёзных задач.
- Использовать без metaproject только для простых, изолированных задач.
- Всегда проверять безопасность при запуске harness.
