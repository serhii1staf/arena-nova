/**
 * Minimal localisation layer.
 *
 * Strings are keyed and looked up at render time; every element that needs
 * translating carries a `data-i18n` attribute, so switching language re-walks the
 * DOM instead of requiring a reload. The choice is persisted.
 */

export type Lang = 'en' | 'ru';

const STORAGE_KEY = 'arena-nova.lang';

const STRINGS = {
  en: {
    'start.loading': 'Loading…',
    'start.play': 'Play',
    'start.name': 'Your name',
    'start.pass': 'Admin password (optional)',
    'admin.snowHeavy': 'Heavy snow',
    'admin.snowLight': 'Light snow',
    'admin.rainHeavy': 'Heavy rain',
    'admin.weatherAuto': 'Weather: auto',
    'coords.goto': 'Go to: x z',
    'coords.arrived': 'arrived',
    'squad.invites': 'invites you to a squad',
    'squad.accept': 'Accept',
    'squad.decline': 'Decline',
    'squad.invite': '+ squad',
    'squad.keys': 'Y to accept, N to decline',

    'build.wall': 'Wall',
    'build.floor': 'Floor',
    'build.ramp': 'Ramp',
    'build.roof': 'Roof',
    'build.pillar': 'Pillar',
    'build.foundation': 'Base',
    'build.cat.walls': 'Walls',
    'build.cat.frame': 'Frame',
    'build.cat.roof': 'Roof',
    'build.cat.props': 'Fittings',
    'build.bed': 'Bed',
    'build.table': 'Table',
    'build.stool': 'Stool',
    'build.cabinet': 'Cabinet',
    'build.barrel': 'Barrel',
    'build.shelf': 'Shelf',
    'build.torch': 'Torch',
    'build.campfire': 'Campfire',
    'build.brazier': 'Brazier',
    'build.lantern': 'Lantern',
    'build.openDoor': 'E — open',
    'build.shutDoor': 'E — shut',
    'build.wallHalf': 'Half wall',
    'build.gable': 'Gable',
    'build.doorway': 'Doorway',
    'build.doorArch': 'Arch',
    'build.doorLeaf': 'Door',
    'build.windowOpen': 'Opening',
    'build.windowGlass': 'Window',
    'build.windowVent': 'Vent',
    'build.beam': 'Beam',
    'build.roofGable': 'Gable roof',
    'build.roofHip': 'Hip roof',
    'build.roofShed': 'Shed roof',
    'build.roofFlat': 'Roof deck',
    'build.window': 'Window',
    'build.stairs': 'Stairs',
    'build.railing': 'Railing',
    'build.remove': 'X removes:',
    'build.hint': 'Click place · wheel switch · [ ] group · R turn · X remove · B exit ·',

    'players.title': 'Players',
    'players.admin': 'ADMIN',
    'players.offline': 'offline',

    'admin.title': 'Admin panel',
    'admin.fly': 'Flight',
    'admin.noclip': 'Walk through walls',
    'admin.speed1': 'Speed ×1',
    'admin.speed2': 'Speed ×2',
    'admin.speed4': 'Speed ×4',
    'admin.speed8': 'Speed ×8',
    'admin.grow': 'Grow',
    'admin.shrink': 'Shrink',
    'admin.sizeReset': 'Normal size',
    'admin.dawn': 'Time: dawn',
    'admin.noon': 'Time: noon',
    'admin.dusk': 'Time: dusk',
    'admin.night': 'Time: night',
    'admin.timeFwd': 'Time forward',
    'admin.zoomOut': 'Camera back',
    'admin.firstPerson': 'First person',
    'admin.toLobby': 'Go to the lobby',
    'admin.toWorld': 'Go to the open world',
    'admin.nextSkin': 'Next character',
    'admin.stats': 'Diagnostics overlay',
    'start.ready': 'Press Play to enter the sanctuary',
    'start.preparing': 'Preparing the ruins…',
    'start.growing': 'Growing the moss…',
    'start.unavailable': 'Unavailable',

    'hud.hintDesktop':
      'WASD · Shift sprint · Space jump · Scroll: 3rd person · Hold Tab: cursor · F11 fullscreen · Esc menu',
    'hud.hintTouch': 'Left: move · Right: look · Tap: jump · enter the portal to travel',

    'pause.title': 'Paused',
    'pause.resume': 'Resume',
    'pause.settings': 'Settings',
    'pause.fullscreen': 'Fullscreen',

    'set.character': 'Character',
    'skin.applied': 'Character changed',
    'set.language': 'Language',
    'set.fps': 'Frame rate',
    'fps.vsync': 'Match display (smoothest)',
    'fps.unlimited': 'Unlimited (may tear)',
    'fps.restart': 'Restart the game to apply',
    'set.quality': 'Quality',
    'set.music': 'Music',
    'set.sfx': 'Effects',
    'set.sensitivity': 'Sensitivity',
    'set.fov': 'Field of view',
    'quality.low': 'Low',
    'quality.medium': 'Medium',
    'quality.high': 'High',
    'quality.ultra': 'Ultra',

    'upd.notChecked': 'Updates: not checked',
    'upd.check': 'Check for updates',
    'upd.checking': 'Checking…',
    'upd.upToDate': 'Updates: you are up to date',
    'upd.available': 'Update available: v{version}',
    'upd.install': 'Install & restart',
    'upd.downloading': 'Downloading update…',
    'upd.downloadingPct': 'Downloading update… {pct}%',
    'upd.failed': 'Update failed: {error}',
    'upd.checkFailed': 'Check failed: {error}',
    'upd.webBuild': 'Updates: web build is always current',

    'err.noWebgl': 'WebGL is not available on this system.',
    'err.renderer': 'Renderer init failed: {error}',
    'err.world': 'Failed to build the world: {error}',
    'err.container': 'Missing #app container.',

    'win.minimise': 'Minimise',
    'win.maximise': 'Maximise',
    'win.quit': 'Quit',
  },

  ru: {
    'start.loading': 'Загрузка…',
    'start.play': 'Играть',
    'start.name': 'Ваше имя',
    'start.pass': 'Пароль администратора (необязательно)',
    'admin.snowHeavy': 'Сильный снег',
    'admin.snowLight': 'Слабый снег',
    'admin.rainHeavy': 'Сильный дождь',
    'admin.weatherAuto': 'Погода: авто',
    'coords.goto': 'Идти к: x z',
    'coords.arrived': 'на месте',
    'squad.invites': 'приглашает в отряд',
    'squad.accept': 'Принять',
    'squad.decline': 'Отклонить',
    'squad.invite': '+ отряд',
    'squad.keys': 'Y — принять, N — отклонить',

    'build.wall': 'Стена',
    'build.floor': 'Пол',
    'build.ramp': 'Пандус',
    'build.roof': 'Крыша',
    'build.pillar': 'Столб',
    'build.foundation': 'Основа',
    'build.cat.walls': 'Стены',
    'build.cat.frame': 'Каркас',
    'build.cat.roof': 'Крыша',
    'build.cat.props': 'Обстановка',
    'build.bed': 'Кровать',
    'build.table': 'Стол',
    'build.stool': 'Табурет',
    'build.cabinet': 'Шкаф',
    'build.barrel': 'Бочка',
    'build.shelf': 'Полка',
    'build.torch': 'Факел',
    'build.campfire': 'Костёр',
    'build.brazier': 'Жаровня',
    'build.lantern': 'Фонарь',
    'build.openDoor': 'E — открыть',
    'build.shutDoor': 'E — закрыть',
    'build.wallHalf': 'Полстены',
    'build.gable': 'Фронтон',
    'build.doorway': 'Проём',
    'build.doorArch': 'Арка',
    'build.doorLeaf': 'Дверь',
    'build.windowOpen': 'Проём окна',
    'build.windowGlass': 'Окно',
    'build.windowVent': 'Форточка',
    'build.beam': 'Балка',
    'build.roofGable': 'Двускатная',
    'build.roofHip': 'Четырёхскатная',
    'build.roofShed': 'Односкатная',
    'build.roofFlat': 'Плоская',
    'build.window': 'Окно',
    'build.stairs': 'Лестница',
    'build.railing': 'Перила',
    'build.remove': 'X убрать:',
    'build.hint': 'ЛКМ ставить · колесо выбор · [ ] группа · R поворот · X убрать · B выход ·',

    'players.title': 'Игроки',
    'players.admin': 'АДМИН',
    'players.offline': 'нет связи',

    'admin.title': 'Панель админа',
    'admin.fly': 'Полёт',
    'admin.noclip': 'Проходить сквозь стены',
    'admin.speed1': 'Скорость ×1',
    'admin.speed2': 'Скорость ×2',
    'admin.speed4': 'Скорость ×4',
    'admin.speed8': 'Скорость ×8',
    'admin.grow': 'Увеличить рост',
    'admin.shrink': 'Уменьшить рост',
    'admin.sizeReset': 'Обычный рост',
    'admin.dawn': 'Время: рассвет',
    'admin.noon': 'Время: полдень',
    'admin.dusk': 'Время: закат',
    'admin.night': 'Время: ночь',
    'admin.timeFwd': 'Время вперёд',
    'admin.zoomOut': 'Камера дальше',
    'admin.firstPerson': 'Вид от первого лица',
    'admin.toLobby': 'В лобби',
    'admin.toWorld': 'В открытый мир',
    'admin.nextSkin': 'Следующий персонаж',
    'admin.stats': 'Показатели',
    'start.ready': 'Нажмите «Играть», чтобы войти',
    'start.preparing': 'Пробуждаем руины…',
    'start.growing': 'Выращиваем мох…',
    'start.unavailable': 'Недоступно',

    'hud.hintDesktop':
      'WASD · Shift — бег · Space — прыжок · колёсико — вид от 3-го лица · Tab — курсор · F11 — во весь экран · Esc — меню',
    'hud.hintTouch': 'Слева — движение · Справа — обзор · Тап — прыжок · войдите в портал',

    'pause.title': 'Пауза',
    'pause.resume': 'Продолжить',
    'pause.settings': 'Настройки',
    'pause.fullscreen': 'Во весь экран',

    'set.character': 'Персонаж',
    'skin.applied': 'Персонаж сменён',
    'set.language': 'Язык',
    'set.fps': 'Частота кадров',
    'fps.vsync': 'По монитору (плавнее всего)',
    'fps.unlimited': 'Без ограничения (возможны разрывы)',
    'fps.restart': 'Перезапустите игру, чтобы применить',
    'set.quality': 'Качество',
    'set.music': 'Музыка',
    'set.sfx': 'Эффекты',
    'set.sensitivity': 'Чувствительность',
    'set.fov': 'Угол обзора',
    'quality.low': 'Низкое',
    'quality.medium': 'Среднее',
    'quality.high': 'Высокое',
    'quality.ultra': 'Максимальное',

    'upd.notChecked': 'Обновления: не проверялись',
    'upd.check': 'Проверить обновления',
    'upd.checking': 'Проверяем…',
    'upd.upToDate': 'Обновления: установлена последняя версия',
    'upd.available': 'Доступно обновление: v{version}',
    'upd.install': 'Установить и перезапустить',
    'upd.downloading': 'Скачиваем обновление…',
    'upd.downloadingPct': 'Скачиваем обновление… {pct}%',
    'upd.failed': 'Ошибка обновления: {error}',
    'upd.checkFailed': 'Не удалось проверить: {error}',
    'upd.webBuild': 'Обновления: веб-версия всегда актуальна',

    'err.noWebgl': 'WebGL недоступен на этой системе.',
    'err.renderer': 'Не удалось запустить рендерер: {error}',
    'err.world': 'Не удалось построить мир: {error}',
    'err.container': 'Не найден контейнер #app.',

    'win.minimise': 'Свернуть',
    'win.maximise': 'Развернуть',
    'win.quit': 'Выйти',
  },
} as const;

export type StringKey = keyof typeof STRINGS.en;

type Listener = (lang: Lang) => void;

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'ru') return saved;
  } catch {
    /* storage unavailable */
  }
  // Follow the OS/browser language, defaulting to English.
  const nav = typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : 'en';
  return nav.startsWith('ru') ? 'ru' : 'en';
}

let current: Lang = detectLang();
const listeners = new Set<Listener>();

/** Current language. */
export function getLang(): Lang {
  return current;
}

/** Translate a key, interpolating `{placeholders}`. */
export function t(key: StringKey, vars?: Record<string, string | number>): string {
  const table = STRINGS[current] as Record<string, string>;
  const fallback = STRINGS.en as Record<string, string>;
  let out = table[key] ?? fallback[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

export function onLangChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore */
  }
  applyTranslations();
  for (const fn of listeners) fn(lang);
}

/**
 * Rewrites every element tagged with `data-i18n` (text content) or
 * `data-i18n-title` (tooltip). Called on boot and on every language change.
 */
export function applyTranslations(root: ParentNode = document): void {
  document.documentElement.lang = current;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-i18n]'))) {
    const key = el.dataset.i18n as StringKey | undefined;
    if (key) el.textContent = t(key);
  }
  // Placeholders need their own pass: they are an attribute, not text content, and
  // an input's text content is not shown at all.
  for (const el of Array.from(
    root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]'),
  )) {
    const key = el.dataset.i18nPlaceholder as StringKey | undefined;
    if (key) el.placeholder = t(key);
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-i18n-title]'))) {
    const key = el.dataset.i18nTitle as StringKey | undefined;
    if (key) el.title = t(key);
  }
}
