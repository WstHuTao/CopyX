export const cases = [
  {
    id: "01",
    name: "Excel 单个多行单元格外层引号清理",
    requirement:
      "输入是一个单元格复制的纯文本。仅在整个字符串同时以双引号开头、双引号结尾并且含有换行时，去掉一对外层双引号，并把内部两个连续双引号还原成一个。其他情况下原样返回。保留原有换行类型和正常正文引号，不做 trim。",
    samples: [
      { input: '"第一行\r\n第二行"', expected: "第一行\r\n第二行" },
      { input: '"他说""你好""\n第二行"', expected: '他说"你好"\n第二行' },
      { input: '客户 "A" 公司', expected: '客户 "A" 公司' },
      { input: '"正常引号"', expected: '"正常引号"' },
      { input: "", expected: "" },
    ],
  },
  {
    id: "02",
    name: "字面量换行转真实换行",
    requirement:
      "把文本中每个字面量反斜杠加小写 n（两个字符）替换为真实 LF 换行。保留已有 CRLF/LF、字面量反斜杠 t、其他文字和空格。空字符串返回空字符串。",
    samples: [
      { input: "A\\nB\\tC", expected: "A\nB\\tC" },
      { input: "甲\r\n乙\\n丙", expected: "甲\r\n乙\n丙" },
      { input: "", expected: "" },
    ],
  },
  {
    id: "03",
    name: "逐行清理首尾空格且保留换行类型",
    requirement:
      "只删除每行开头和末尾的 ASCII 空格及制表符。保留行内部空格、所有空行、CRLF/LF 换行类型及末尾换行，不把换行当作要删除的空白。",
    samples: [
      { input: " \t A  B \t\r\n  C \n\t", expected: "A  B\r\nC\n" },
      { input: "甲\t乙\r\n", expected: "甲\t乙\r\n" },
      { input: "", expected: "" },
    ],
  },
  {
    id: "04",
    name: "删除空白行",
    requirement:
      "按 CRLF 或 LF 分行，删除空行及仅由 ASCII 空格/制表符组成的行，其他行的内容原样保留，包括首尾空格。剩余行用 LF 连接，不额外添加末尾换行；没有剩余内容返回空字符串。",
    samples: [
      { input: "A\r\n \t\r\n B \n\nC\n", expected: "A\n B \nC" },
      { input: " \t\n\r\n", expected: "" },
      { input: "", expected: "" },
    ],
  },
  {
    id: "05",
    name: "逐行精确去重",
    requirement:
      "按 CRLF/LF 分行，忽略空行及仅有空格或制表符的行。对其余行进行区分大小写的精确去重，保留首次出现的顺序及行内、首尾空格。用 LF 连接，不额外添加末尾换行。",
    samples: [
      { input: "A\r\nA\n a \na\nA", expected: "A\n a \na" },
      { input: "A\n\nA\n", expected: "A" },
      { input: "", expected: "" },
    ],
  },
  {
    id: "06",
    name: "带引号 CSV 转 TSV",
    requirement:
      "把 CSV 转为制表符分隔的文本。支持双引号包裹字段、引号内逗号和两个连续双引号代表一个双引号；本用例字段内没有真实换行。字段解码后不额外包引号，保留空字段、末尾空列。输入记录分隔支持 CRLF/LF，输出记录使用 LF，不额外加末尾换行。空输入返回空字符串。",
    samples: [
      {
        input: '"公司,分部",金额\r\n"甲""乙",12.50',
        expected: '公司,分部\t金额\n甲"乙\t12.50',
      },
      { input: "a,,c\n1,2,", expected: "a\t\tc\n1\t2\t" },
      { input: "", expected: "" },
    ],
  },
  {
    id: "07",
    name: "TSV 表格转 JSON 对象数组",
    requirement:
      "把 TSV 表格转成紧凑 JSON 对象数组字符串。首行是表头，后续非空行是数据，缺少的列补空字符串。所有单元格值保持字符串，包括前导零、金额末尾零和首尾空格，键顺序按表头。支持 CRLF/LF。忽略末尾空行；空输入或只有表头输出 []。",
    samples: [
      {
        input: "公司\t编号\t金额\r\n甲公司\t001\t12.00\r\n乙\t002\t",
        expected:
          '[{"公司":"甲公司","编号":"001","金额":"12.00"},{"公司":"乙","编号":"002","金额":""}]',
      },
      { input: "a\tb\n x \ty", expected: '[{"a":" x ","b":"y"}]' },
      { input: "a\tb", expected: "[]" },
      { input: "", expected: "[]" },
    ],
  },
  {
    id: "08",
    name: "JSON 对象数组转固定列 TSV",
    requirement:
      "输入为 JSON 对象数组，输出 TSV，列固定为 name、qty、note，首行输出这三个表头。缺失和 null 输出空字符串，数字 0、false 必须保留为文本。忽略额外字段，字段中的双引号正常保留；本用例字段不含真实制表符或换行。输出 LF 分行且不额外加末尾换行。空数组只输出表头。",
    samples: [
      {
        input:
          '[{"name":"甲","qty":0,"note":"正常\\\"引号","extra":1},{"name":"乙","qty":false,"note":null}]',
        expected: 'name\tqty\tnote\n甲\t0\t正常"引号\n乙\tfalse\t',
      },
      { input: '[{"name":"A"}]', expected: "name\tqty\tnote\nA\t\t" },
      { input: "[]", expected: "name\tqty\tnote" },
    ],
  },
  {
    id: "09",
    name: "JSON 两空格格式化",
    requirement:
      "解析有效 JSON，再用两个空格缩进格式化为字符串，保留键顺序、值、数组和 Unicode 字符，不额外加末尾换行。空字符串原样返回。",
    samples: [
      {
        input: '{"name":"甲","items":[1,true,null]}',
        expected:
          '{\n  "name": "甲",\n  "items": [\n    1,\n    true,\n    null\n  ]\n}',
      },
      { input: "[1,2]", expected: "[\n  1,\n  2\n]" },
      { input: "", expected: "" },
    ],
  },
  {
    id: "10",
    name: "JSON 紧凑化",
    requirement:
      "解析有效 JSON 并输出不带额外缩进的紧凑 JSON 字符串，保留字符串内空格、正常引号、键顺序和数据类型。空字符串原样返回。",
    samples: [
      {
        input: '{\n  "name": " A  B ",\n  "n": 0\n}',
        expected: '{"name":" A  B ","n":0}',
      },
      { input: '[ true, null, "中 文" ]', expected: '[true,null,"中 文"]' },
      { input: "", expected: "" },
    ],
  },
  {
    id: "11",
    name: "提取并去重邮箱",
    requirement:
      "从文本提取常见 ASCII 邮箱，用户名支持字母数字及 . _ % + -，域名含点及至少两个英文字母的顶级域。邮箱外的中文和句末标点不属于邮箱。按首次出现排序，不区分大小写去重，保留首次出现邮箱的原始大小写。每行一个，LF 分隔；没有邮箱或空输入返回空字符串。",
    samples: [
      {
        input: "A.User+tag@example.com a.user+tag@EXAMPLE.com x_y@test.cn",
        expected: "A.User+tag@example.com\nx_y@test.cn",
      },
      {
        input: "联系：a@x.com，备用 b@test.io。",
        expected: "a@x.com\nb@test.io",
      },
      { input: "not-an-email foo@bar", expected: "" },
      { input: "", expected: "" },
    ],
  },
  {
    id: "12",
    name: "提取手机号且排除长编号中的子串",
    requirement:
      "提取中国大陆 11 位手机号，首位 1、第二位 3 到 9，左右不能紧邻其他数字，不能从更长编号中截取手机号。按首次出现顺序去重，每行一个，用 LF 分隔。没有手机号或空输入返回空字符串。",
    samples: [
      {
        input:
          "电话13800138000/13900139000，13800138000；订单9138001380001；座机021-12345678",
        expected: "13800138000\n13900139000",
      },
      { input: "x 12800138000 y 19900139000", expected: "19900139000" },
      { input: "", expected: "" },
    ],
  },
  {
    id: "13",
    name: "严格校验日期后统一格式",
    requirement:
      "只把文本中完整且日历合法的 YYYY/M/D 或 YYYY-M-D 日期转为 YYYY-MM-DD。月日可为一位或两位，年份四位；要校验闰年和月天数，非法日期原样保留。其他字符、编号和空格不改。",
    samples: [
      {
        input: "2026/1/2 和 2026-11-4，编号20261104",
        expected: "2026-01-02 和 2026-11-04，编号20261104",
      },
      {
        input: "2024/2/29 2025/2/29 2026/13/40",
        expected: "2024-02-29 2025/2/29 2026/13/40",
      },
      { input: "", expected: "" },
    ],
  },
  {
    id: "14",
    name: "只移除金额行中的千位分隔符",
    requirement:
      "逐行处理，仅当整行（允许首尾 ASCII 空格、制表符）是规范千位分组的十进制金额时，移除其中的英文逗号。金额可带正负号、可带小数；千位整数首组 1 到 3 位，之后每组恰为三位。保留所有数字、末尾零、符号、首尾空白和原始 CRLF/LF。不符合的行原样保留。",
    samples: [
      {
        input: "1,234.50\r\n-9,876.00\nABC,DEF\n编号1,234X",
        expected: "1234.50\r\n-9876.00\nABC,DEF\n编号1,234X",
      },
      { input: " +1,234 \n12,34", expected: " +1234 \n12,34" },
      { input: "", expected: "" },
    ],
  },
  {
    id: "15",
    name: "精确十进制金额四舍五入",
    requirement:
      "逐行将纯十进制数字（可带负号，小数点后至少一位，或只有整数）格式化为两位小数。必须按十进制精确进行绝对值四舍五入，不能因二进制浮点把 1.005 算成 1.00。负数按绝对值四舍五入后恢复负号，保留原换行类型。非数字行原样返回；空输入不加任何内容。",
    samples: [
      {
        input: "1.005\r\n-2.345\n12\n0",
        expected: "1.01\r\n-2.35\n12.00\n0.00",
      },
      {
        input: "999999999999999999.995\n文本",
        expected: "1000000000000000000.00\n文本",
      },
      { input: "", expected: "" },
    ],
  },
  {
    id: "16",
    name: "表格整数数量精确合计",
    requirement:
      "TSV 固定两列品名和数量，首行是表头。将后续非空记录的非负整数数量精确相加，数量可能超过 Number.MAX_SAFE_INTEGER，不能损失精度。保留表头和原记录文字，统一用 LF 分行，末尾追加 合计、制表符、精确总数，不额外加末尾换行。空输入原样返回。",
    samples: [
      {
        input: "品名\t数量\r\n甲\t2\n乙\t0\n丙\t3",
        expected: "品名\t数量\n甲\t2\n乙\t0\n丙\t3\n合计\t5",
      },
      {
        input: "品名\t数量\n甲\t9007199254740993\n乙\t7",
        expected:
          "品名\t数量\n甲\t9007199254740993\n乙\t7\n合计\t9007199254741000",
      },
      { input: "品名\t数量", expected: "品名\t数量\n合计\t0" },
      { input: "", expected: "" },
    ],
  },
  {
    id: "17",
    name: "表格按编号稳定数值排序",
    requirement:
      "TSV 两列编号和名称，首行为表头，后续编号均为整数文本。保留表头，按编号数值升序进行稳定排序，数值相等保持原顺序。保留编号原有前导零和行内文字；输出 LF，不额外添加末尾换行。只有表头保持表头，空输入返回空字符串。",
    samples: [
      {
        input: "编号\t名称\r\n10\t十\n2\t二\n02\t二零\n1\t一",
        expected: "编号\t名称\n1\t一\n2\t二\n02\t二零\n10\t十",
      },
      { input: "编号\t名称", expected: "编号\t名称" },
      { input: "", expected: "" },
    ],
  },
  {
    id: "18",
    name: "递归转换 JSON 对象的键名",
    requirement:
      "将有效 JSON 中所有对象的 snake_case 键名递归转为 camelCase（下划线后的小写英文字母改大写并移除下划线）。数组元素也递归处理。只改键，不能改字符串值、数字、布尔值或 null；输出紧凑 JSON。空字符串原样返回。",
    samples: [
      {
        input:
          '{"order_id":"A_01","line_items":[{"sku_code":"x_y","unit_price":12}],"is_ready":false}',
        expected:
          '{"orderId":"A_01","lineItems":[{"skuCode":"x_y","unitPrice":12}],"isReady":false}',
      },
      { input: '[{"a_b":null},"x_y"]', expected: '[{"aB":null},"x_y"]' },
      { input: "", expected: "" },
    ],
  },
  {
    id: "19",
    name: "仅转换 ASCII 小写字母",
    requirement:
      "仅将 ASCII a 到 z 转成 A 到 Z，其他字符一律保持，包括 é、ß、中文、组合 Emoji、数字、空格、制表符、CRLF/LF 和引号。不能对整个字符串直接使用会改变其他 Unicode 字母的 toUpperCase。",
    samples: [
      {
        input: 'Abc-éß 中文👨‍👩‍👧‍👦\t012\r\n"x"',
        expected: 'ABC-éß 中文👨‍👩‍👧‍👦\t012\r\n"X"',
      },
      { input: "café straße", expected: "CAFé STRAßE" },
      { input: "", expected: "" },
    ],
  },
  {
    id: "20",
    name: "全角 ASCII 与全角空格转换",
    requirement:
      "只把 U+FF01 到 U+FF5E 范围内的全角 ASCII 字符转为对应半角字符，并把 U+3000 全角空格转为普通 ASCII 空格。其他字符不改，包括中文句号、日文引号、带圈数字、中文、换行和制表符。",
    samples: [
      { input: "ＡＢＣ１２３，！　中文。", expected: "ABC123,! 中文。" },
      { input: "「Ａ」①\tＢ\r\nＣ", expected: "「A」①\tB\r\nC" },
      { input: "", expected: "" },
    ],
  },
];
