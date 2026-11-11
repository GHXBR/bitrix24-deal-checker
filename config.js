/**
 * Правила проверки под портал.
 * Скрипт ничего не меняет в Битриксе — только читает и сверяет.
 */
const isWin = process.platform === 'win32';

module.exports = {
  // true / VERBOSE=1 — подробный лог шагов
  verbose: false,

  // пауза не нужна: между сделками ждём закрытия slider по условию
  delayBetweenDealsMs: 0,
  reportWaitMs: 120_000,
  // на Windows лента догружается тяжелее — меньше лишних скроллов
  timelineScrollSteps: isWin ? 2 : 4,

  /**
   * Скорость (особенно Windows):
   * - клик по ссылке в отчёте вместо полного goto карточки
   * - системный Chrome + постоянный профиль (.browser-profile)
   * - короче ожидания полей / сумм / ленты
   */
  openDealByClick: true,
  useSystemChrome: true,
  persistentProfile: true,
  persistentProfileDir: '.browser-profile',

  dealOpenTimeoutMs: isWin ? 12000 : 20000,
  dealFieldsTimeoutMs: isWin ? 12000 : 20000,
  costAmountsTimeoutMs: isWin ? 15000 : 30000,
  costRetryTimeoutMs: isWin ? 10000 : 20000,
  costLastChanceTimeoutMs: isWin ? 8000 : 15000,
  timelineTimeoutMs: isWin ? 8000 : 12000,
  // паузы после кликов в отчёте / панелях (вместо жёстких 600–800 мс)
  uiSettleMs: isWin ? 250 : 400,
  uiSettleTimeoutMs: isWin ? 2500 : 4000,

  /**
   * Fail-fast на Windows: не жечь 15–20 с на каждый провал download / задачу.
   * Лучше быстро null и идти дальше, чем минуты «зависаний».
   */
  downloadTimeoutMs: isWin ? 15000 : 20000,
  panelDownloadTimeoutMs: isWin ? 12000 : 15000,
  warehouseOpenTimeoutMs: isWin ? 8000 : 10000,
  sidePanelCloseTimeoutMs: isWin ? 2500 : 3500,

  dealNameLabel: 'Название',
  closeMonthLabel: 'Месяц завершения сделки',
  // сумма сделки (для 3% эквайринга в НАЛ/QR)
  dealAmountLabel: 'Сумма и валюта',

  clientInvoiceCommentText: 'счёт заказчику',
  clientInvoiceFileHints: ['исходящий', 'счет', 'счёт'],

  /**
   * Сделки, у которых НЕ должно быть счёта заказчику
   * (название начинается с одного из префиксов, без учёта регистра).
   */
  skipClientInvoiceNamePrefixes: ['нал', 'qr'],

  supplierPaymentTaskHints: ['предоплата', 'постоплата'],

  warehouseTaskHint: 'списание со склада',
  // любые формулировки задачи списания
  warehouseTaskHints: ['списание со склада', 'списание со склад', 'списание товара'],
  // В тексте задачи списания берём ТОЛЬКО «сумма» / «всего» (не «цена»).
  // Деньги: 1 234,56 / 1234.56 / 1234
  warehouseMoneyToken:
    '([0-9]{1,3}(?:[\\s\\u00A0][0-9]{3})+(?:[.,][0-9]{1,2})?|[0-9]+[.,][0-9]{1,2}|[0-9]{1,9}(?:[.,][0-9]{1,2})?)',

  // транспорт СДЭК из комментариев (счёта нет)
  cdekCommentHints: ['сдэк', 'cdek', 'сдек'],

  // эквайринг 3% от суммы сделки (НАЛ/QR).
  // В графе Поставщик лежит уже готовая сумма ≈3%; сверка с допуском ±1 ₽.
  acquiringFeePercent: 3,
  // достаточно намёка на эквайринг / 3% (формулировки разные)
  acquiringCommentRegexes: [
    /3\s*%\s*(?:за\s*)?эквайринг/i,
    /эквайринг\w*\s*(?:[-–—:]?\s*)?3\s*%/i,
    /комисси\w{0,6}.{0,25}эквайринг/i,
    /эквайринг\w*.{0,25}комисси/i,
    /3\s*%\s*(?:за\s*)?(?:терминал|картой|безнал)/i,
    /эквайринг/i,
  ],

  costFieldLabels: [
    'Поставщик',
    'Сумма закупок последующих поставщиков',
    'Дополнительные расходы',
    'Расходы без НДС',
    'Транспортные расходы',
    'Доп.расходы',
    'Доп. расходы',
  ],

  // округление Битрикса / копейки: ±1 ₽
  amountTolerance: 1,
  /**
   * false: наборы сумм должны совпасть поэлементно.
   * true: достаточно совпадения ИТОГО (скрывает разные составы сумм — опасно).
   */
  acceptMatchingTotals: false,

  /**
   * Минимальная сумма из счетов / СДЭК / «свободного» парсинга.
   * Мелочь вроде 18 из PDF (дата/кол-во) не должна попадать в сверку.
   * Исключение: сумма совпадает с графой затрат (±amountTolerance).
   */
  minSourceAmount: 50,
  /** Отбрасывать «сирот», которых нет в графах и которые << остальных сумм */
  dropTinyOrphans: true,
  orphanMaxAmount: 300,
  orphanMaxRatio: 0.12,

  /**
   * Нал/QR: если в названии «Нал-Ю26-2900» — 2900 как сумма сделки,
   * когда поле «Сумма и валюта» пустое. Эквайринг 3% можно взять из графы,
   * даже если комментарий написан нестандартно.
   */
  parseDealAmountFromTitle: true,
  acquiringMatchFromCostFields: true,

  /**
   * Счета поставщику всегда скачиваем и сверяем с графами затрат.
   * Из ленты берём только СДЭК и эквайринг — не подмену сумм счетов.
   * false ускорит прогон, но сверка станет бессмысленной.
   */
  downloadSupplierInvoices: true,

  /** Кэш скачанных файлов и разобранных сумм в рамках одного запуска. */
  cacheInvoiceFiles: true,
  /** Параллельная загрузка счетов по href (2 на Windows безопаснее для антивируса). */
  // на Windows параллель >1 часто даёт timeout/Invalid URL на disk.uf
  invoiceFetchConcurrency: 1,
};
