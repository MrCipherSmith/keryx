# Бенчмарк: `keryx harness` — сравнение с metaproject

## 1. Базовый сценарий: без metaproject
Проверить, что harness работает изолированно, без доступа к внешним модулям keryx.

```bash
# Создать тестовый harness-конфиг без метарепозитория
keryx harness run --provider fake --model qwen3.5-9b-4bit --config /tmp/harness-test/config.json

# Проверить, что нет доступа к модулям keryx (кроме встроенных)
keryx harness run --provider fake --model qwen3.5-9b-4bit --no-metaproject

# Проверить, что agent не может импортировать модули keryx
# (тест: попытка импорта должна быть заблокирована или не работать)
```

## 2. Сценарий: с metaproject (обычный режим)
Проверить, что harness корректно работает в контексте metaproject.

```bash
# Запуск с доступом к модулям metaproject
keryx harness run --provider fake --model qwen3.5-9b-4bit

# Проверить доступ к модулям
keryx harness run --provider fake --model qwen3.5-9b-4bit --list-modules

# Проверить, что agent может использовать модули metaproject
keryx harness run --provider fake --model qwen3.5-9b-4bit --allow-modules "*"
```

## 3. Бенчмарк производительности
```bash
# Измерить время выполнения
time keryx harness run --provider fake --model qwen3.5-9b-4bit --config /tmp/harness-test/config.json

# Измерить потребление памяти
keryx harness run --provider fake --model qwen3.5-9b-4bit --memory-limit 500mb
```

## 4. Тестирование функциональности
```bash
# Тестирование всех подкоманд
keryx harness run --provider fake --model qwen3.5-9b-4bit
keryx harness exec --provider fake --model qwen3.5-9b-4bit --command "echo test"
keryx harness replay --provider fake --model qwen3.5-9b-4bit

# Тестирование изоляции
keryx harness run --provider fake --model qwen3.5-9b-4bit --allow-shell false

# Тестирование sandbox (если доступен)
keryx harness run --provider fake --model qwen3.5-9b-4bit --sandbox linux
```

## 5. Проверка интеграции с модулями
```bash
# Проверить, что harness корректно использует модули metaproject
keryx harness run --provider fake --model qwen3.5-9b-4bit --module-test

# Проверить доступ к CLI командам
keryx harness run --provider fake --model qwen3.5-9b-4bit --cli-test
```

## 6. Сценарий: ошибка при отсутствии метарепозитория
```bash
# Запуск в репозитории без metaproject
cd /tmp
keryx harness run --provider fake --model qwen3.5-9b-4bit

# Ожидается: harness не начнётся или выдаст ошибку
```

## 7. Сравнение с внешним harness
```bash
# Запуск через keryx
keryx harness run --provider fake --model qwen3.5-9b-4bit

# Запуск через внешний harness (если доступен)
external-harness run --provider fake --model qwen3.5-9b-4bit

# Сравнить результаты
diff <(keryx harness run ...) <(external-harness run ...)
```

## 8. Проверка безопасности
```bash
# Проверить, что harness не может получить доступ к файлам, которые не должны видеть
keryx harness run --provider fake --model qwen3.5-9b-4bit --test-access /etc/passwd

# Проверить, что harness не может выполнить опасные команды
keryx harness run --provider fake --model qwen3.5-9b-4bit --test-command "rm -rf /"
```
