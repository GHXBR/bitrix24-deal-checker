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

  // подробный dump iframe — только при verbose / DEBUG_DIAG=1
  frameDiagnostics: false,

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
  warehouseTaskHints: ['списание со склада', 'списание со склад', 'списание товара', 'списание'],
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
  // старое поле — на случай ручных конфигов
  acquiringCommentRegex: /эквайринг/i,

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
  acceptMatchingTotals: true,
  /**
   * Скачивание счетов поставщику нужно для сверки сумм.
   * На Windows антивирус сильно тормозит — при необходимости поставьте false
   * (проверка станет быстрее, но без сумм из файлов счетов).
   */
  downloadSupplierInvoices: true,
};
