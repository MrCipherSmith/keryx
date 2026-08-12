## Benchmark: keryx harness vs metaproject

### 1. Базовый сценарий: без metaproject
Проверить, что harness работает изолированно, без доступа к внешним модулям keryx.

```bash
# Создать тестовый harness-конфиг без метарепозитория
keryx harness run --provider fake --model qwen3.5-9b-4bit --config /tmp/harness-test/config.json

# Проверить, что нет доступа к модулям keryx (кроме встроенных)
keryx harness run --provider fake --model qwen3.5-9b-4bit --no-metaproject

# Проверить, что agent не может импортировать модули keryx
# (тест: попытка импорта должна быть заблокирована или не работать)
```
