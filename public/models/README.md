# Персонаж игрока / Player character

Игра работает без внешних файлов: по умолчанию используется встроенная
процедурная модель. Если положить сюда `character.glb`, движок подхватит её
автоматически при следующем запуске — код менять не нужно.

The game runs with no external assets: a procedural model is used by default.
Drop a `character.glb` in this folder and the engine picks it up on the next
launch. No code changes required.

## Быстрый старт / Quick start

1. Положите файл в `public/models/character.glb`.
2. Откройте `public/models/character.json` и поменяйте **`"enabled": false`** на
   **`"enabled": true`**. Это единственное обязательное изменение.
3. `npm run build` — файл попадёт в `dist/models/` и в нативную сборку.

> Почему нужен шаг 2: по умолчанию модели нет, и запрос к отсутствующему файлу
> писал бы ошибку 404 в консоль на каждом запуске. Флаг `enabled` избавляет
> чистую сборку от лишнего запроса.

Модель должна быть **скиннингованной (skinned) GLB** с анимациями. Формат GLB
(бинарный glTF 2.0) — единственный поддерживаемый: он в 3–5 раз меньше FBX и
загружается без конвертации. Поддерживается сжатие **Meshopt**
(`gltfpack`, `gltf-transform`). **Draco не поддерживается** — распакуйте такие
файлы перед использованием.

## character.json

Все поля необязательные.

```json
{
  "enabled": true,
  "url": "character.glb",
  "height": 1.8,
  "yawOffsetDeg": 180,
  "stripRootMotion": true,
  "animationUrls": ["walk.glb", "run.glb", "jump.glb"],
  "clips": {
    "idle": "Idle",
    "walk": "Walking",
    "run": "Running",
    "jump": "Jump",
    "fall": "Falling"
  },
  "walkClipSpeed": 4.2,
  "runClipSpeed": 7.6
}
```

| Поле | Что делает |
| --- | --- |
| `enabled` | Включает загрузку модели. По умолчанию `false`. |
| `url` | Имя файла модели внутри `models/`. По умолчанию `character.glb`. |
| `height` | Рост в метрах (от стоп до макушки). Модель масштабируется под него. По умолчанию `1.8`. |
| `yawOffsetDeg` | Разворот модели, чтобы она смотрела вперёд. Риги Mixamo смотрят в `+Z`, поэтому нужно `180`. Если персонаж бежит спиной вперёд — поставьте `0`. |
| `stripRootMotion` | Убирает горизонтальное смещение бёдер, чтобы модель не «уползала» от контроллера. По умолчанию `true`. |
| `animationUrls` | Отдельные файлы только с анимацией (так их отдаёт Mixamo). Имена костей должны совпадать. |
| `clips` | Явные имена клипов. Если не указать — движок ищет по ключевым словам (`idle`, `walk`, `run`, `jump`, `fall`). |
| `walkClipSpeed` / `runClipSpeed` | Скорость (м/с), под которую сделан клип. Нужна, чтобы шаг совпадал с реальной скоростью и ноги не «скользили». |

Если какого-то состояния нет, движок подставляет ближайшее: `run → walk → idle`,
`fall → jump → idle`. Если в файле всего один клип — он играет всегда.

## Где взять модель / Where to get a model

Всё ниже — бесплатно и пригодно для коммерческого использования. Проверяйте
лицензию на странице конкретной модели: она может отличаться от лицензии сайта.

| Источник | Что там | Лицензия |
| --- | --- | --- |
| [Mixamo](https://www.mixamo.com/) (Adobe) | Готовые персонажи + огромная библиотека анимаций, авторигging для своей модели | Бесплатно, требуется Adobe ID; можно использовать в проектах |
| [Quaternius](https://quaternius.com/) | Низкополигональные персонажи с анимациями, идеально под этот стиль | CC0 |
| [KayKit](https://kaylousberg.itch.io/) | Наборы «Adventurers», «Skeletons» — риг + анимации, GLB из коробки | CC0 |
| [Kenney](https://kenney.nl/assets?q=3d) | Мини-персонажи, очень лёгкие | CC0 |
| [Poly Pizza](https://poly.pizza/) | Каталог низкополи-моделей (наследник Google Poly) | CC0 / CC-BY, указано у каждой |
| [Sketchfab](https://sketchfab.com/search?features=downloadable&type=models) | Огромный выбор; фильтр «Downloadable» + «CC0» | зависит от модели |
| [itch.io 3D assets](https://itch.io/game-assets/free/tag-3d) | Много стилизованных наборов | зависит от автора |

### Рекомендация

Для этой игры (низкополигональный стилизованный вид) лучше всего подходят
**Quaternius** и **KayKit**: там уже GLB со скиннингом и анимациями `Idle`,
`Walk`, `Run`, `Jump` — файл кладётся сюда и работает без манифеста, кроме,
возможно, `yawOffsetDeg`.

### Путь через Mixamo

1. Выберите персонажа (или загрузите свой в T-Pose).
2. Скачайте: **Format = FBX Binary**, **Skin = With Skin**, кадры 30 fps.
3. Скачайте нужные анимации отдельно: **Without Skin**, галочка **In Place**
   (это убирает уползание) — `Idle`, `Walking`, `Running`, `Jump`.
4. Сконвертируйте FBX → GLB: Blender (`File → Import → FBX`, затем
   `File → Export → glTF 2.0`, включить `Animation`) — или любой онлайн-конвертер.
   Можно объединить всё в один GLB, или оставить анимации отдельными файлами и
   перечислить их в `animationUrls`.
5. Положите результат сюда и добавьте `character.json` с
   `"yawOffsetDeg": 180`.

### Оптимизация

```bash
npx gltf-transform optimize character.glb character.glb --compress meshopt --texture-compress webp
```

Обычно даёт 3–10× уменьшение размера и работает без дополнительных файлов
декодера.
