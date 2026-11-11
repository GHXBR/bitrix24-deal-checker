const {
  extractAmountFromText,
  pickBestAmount,
  isNetWithoutVatLabel,
} = require('../src/invoiceAmount');

let fail = 0;
function assert(name, got, expect) {
  const ok = got === expect || Object.is(got, expect);
  if (!ok) fail++;
  console.log(ok ? 'OK  ' : 'FAIL', name, '=>', got, 'want', expect);
}

function assertBool(name, got, expect) {
  assert(name, !!got, !!expect);
}

assert(
  'не подставлять prefer из середины PDF',
  extractAmountFromText('Дата 580\nТовар\nИтого к оплате: 5480', [580, 4900]),
  5480
);

assert(
  'prefer только если это помеченная сумма',
  extractAmountFromText('Итого: 580\nпрочее 5480', [580, 9500]),
  580
);

assert(
  'итого без prefer',
  extractAmountFromText('К оплате: 4900', [21240]),
  4900
);

assert(
  'без ярлыка: графа ≈ max документа — берём графу',
  extractAmountFromText('просто числа 100 200 300', [300]),
  300
);

assert(
  'без ярлыка: графы нет в числах — null',
  extractAmountFromText('просто числа 100 300 400', [200]),
  null
);

assert(
  'сильный итог важнее слабой графы 4900',
  pickBestAmount([4900], [100, 4900, 999, 5480], [5480], [4900, 21240]),
  5480
);

assert(
  'pick: strong when prefer not labeled',
  pickBestAmount([], [580], [5480], [580, 4900]),
  5480
);

assert(
  'не подменять Итого 5480 графой 4900 (Δ580)',
  extractAmountFromText(
    '1 товар 580,00\n2 товар 4500,00\n3 доставка 400,00\nИтого: 5480,00\nВсего к оплате: 5480,00',
    [4900, 21240]
  ),
  5480
);

assert(
  'ИНН не режется на итог (9731107362 → не 9731107/362)',
  extractAmountFromText(
    'ИНН 9731107362 КПП 773101001\nИтого: 93000,00\nВ том числе НДС: 16770,49',
    [580, 9500.14, 18130, 93000]
  ),
  93000
);

assert(
  'действителен к оплате — не ярлык итога',
  extractAmountFromText(
    'Счет действителен к оплате в течение 2-х рабочих дней.\nИтого: 18130,00',
    [18130, 9500.14]
  ),
  18130
);

assert(
  'не брать сумму НДС вместо итога',
  extractAmountFromText('Сумма НДС: 16293.26\nИтого к оплате: 90353.51', [90353.51]),
  90353.51
);

assert(
  'отбросить одну только сумму НДС',
  extractAmountFromText('Сумма НДС: 16293.26\nТовар xyz', [90353.51]),
  null
);

assert(
  'vat ratio от графы',
  extractAmountFromText('Сумма: 16293.26', [90353.51]),
  null
);

assertBool('метка без НДС', isNetWithoutVatLabel('Сумма без НДС'), true);

assert(
  'не брать сумму без НДС, если есть итого',
  extractAmountFromText('Сумма без НДС: 24065\nИтого: 27014', [27014]),
  27014
);

assert(
  'слабая сумма + графа в числах → графа',
  extractAmountFromText('Сумма: 8600.39\nТовар 15800.83\nпрочее 100', [15800.83]),
  15800.83
);

assert(
  'доминирующий крупнейший итог / графа в числах',
  extractAmountFromText('позиции 1200 800\nоплата 45000', [45000]),
  45000
);

assert(
  'Всего: как сильный итог',
  extractAmountFromText('Всего: 20760\nНДС 3450', [20760]),
  20760
);

assert(
  'не брать р/с 502401001 вместо итога',
  extractAmountFromText('р/с 502401001\nИтого: 15800.83\nпрочее 100', [15800.83]),
  15800.83
);

assert(
  'графа в числах без ярлыка',
  pickBestAmount([], [502401001, 15800.83, 100], [], [15800.83]),
  15800.83
);

assert(
  'мусор 9731107 не побеждает 93000 у итога',
  extractAmountFromText('Итого к оплате: 93000\nтел 9731107', [93000, 580]),
  93000
);

assert(
  'нетто → брутто по близкой графе',
  extractAmountFromText('Сумма без НДС: 22142.62\nпрочее', [27014, 66500]),
  27014
);

assert(
  'с итогом берём итог, не графу',
  extractAmountFromText('Сумма без НДС: 22142.62\nИтого: 27014', [27014, 66500]),
  27014
);

assert(
  'графа в тексте с пробелами',
  extractAmountFromText('К оплате 27 014,00 руб', [27014]),
  27014
);

assert(
  'крупный счёт не притягивать к мелкой графе',
  extractAmountFromText('Итого: 83200\nпрочее 3542', [3542, 83200]),
  83200
);

assert(
  'мелкий счёт остаётся мелкой графой',
  extractAmountFromText('Итого: 3542\nдата', [3542, 83200]),
  3542
);

assert(
  'Итого 93000 важнее слабой суммы 18130',
  extractAmountFromText('Сумма: 18130\nИтого: 93000', [580, 18130, 93000, 9500.14]),
  93000
);

assert(
  'чужая крупная графа не делает итог 18130 «НДС»',
  extractAmountFromText('Итого: 18130,00\nНДС: 3269.35', [580, 9500.14, 18130, 93000]),
  18130
);

assert(
  'к оплате прописью важнее нетто Итого',
  extractAmountFromText(
    'Всего к оплате сумма: двадцать семь тысяч четырнадцать рублей 00 копеек, Итого 24 065,00',
    [27014, 66500]
  ),
  27014
);

assert(
  'к оплате прописью 3542',
  extractAmountFromText(
    'Всего к оплате сумма: три тысячи пятьсот сорок два рубля 00 копеек, Итого 3 114,00',
    [3542, 83200]
  ),
  3542
);

process.exit(fail ? 1 : 0);
