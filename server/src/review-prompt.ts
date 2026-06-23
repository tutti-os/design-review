export const DIM_NAMES = {
  "zh-CN": ["视觉层次/排版", "配色与对比", "一致性", "可用性/易用性", "品牌契合度", "转化/CTA 效果"],
  en: ["Visual hierarchy / layout", "Color & contrast", "Consistency", "Usability", "Brand fit", "Conversion / CTA"],
} as const;

export type Locale = keyof typeof DIM_NAMES;
export type Strictness = "relaxed" | "standard" | "strict";

export function normalizeStrictness(value: unknown): Strictness {
  const text = String(value ?? "").trim().toLowerCase();
  if (["relaxed", "loose", "lenient", "宽松"].includes(text)) return "relaxed";
  if (["strict", "harsh", "严苛", "严格"].includes(text)) return "strict";
  return "standard";
}

export function normalizeLocale(value: unknown, defaultLocale = "zh-CN"): Locale {
  const text = String(value ?? "").trim().replace("_", "-").toLowerCase();
  if (text.startsWith("en")) return "en";
  if (text.startsWith("zh")) return "zh-CN";
  return defaultLocale in DIM_NAMES ? (defaultLocale as Locale) : "zh-CN";
}

export function buildReviewPrompt(input: {
  url?: string;
  imagePath?: string;
  strictness: Strictness;
  locale: Locale;
}): string {
  const dims = DIM_NAMES[input.locale];
  if (input.locale === "en") {
    const tone =
      input.strictness === "strict"
        ? "Apply a strict, demanding bar; score harshly and let no flaw slide."
        : input.strictness === "relaxed"
          ? "Lean encouraging; score generously and focus on issues that truly hurt the experience."
          : "Apply a professional, objective bar; acknowledge strengths and name problems, and spread the scores.";
    const target = input.imagePath
      ? `Local image file to review: ${input.imagePath}\nRead this local image file and review it visually.`
      : `Website link: ${input.url}\nFirst actually open this link with your available browsing / web-fetch tools and review the real page you retrieve; do not score from memory. If you cannot reach it (intranet, localhost, login-gated, or unreachable), do not fabricate scores: set "overall" to 0 and say so in "summary".`;
    return [
      "# Role",
      `You are a senior design director running a strict, professional UI design review. ${tone}`,
      "",
      "# Task",
      "Review the provided UI design and score it across the six fixed, ordered dimensions below, then produce an actionable fix list.",
      "",
      "# Dimensions (cover all, exact names and order, do not add / rename / drop)",
      ...dims.map((name, index) => `${index + 1}. ${name}`),
      "",
      "# Output format (extremely strict; violations count as failure)",
      "- Output only one valid JSON object; no prefix, suffix, comments, or markdown code fences.",
      "- Use English for every string, be specific and actionable, and obey each field's length limit.",
      "- Keep the JSON complete and compact.",
      "",
      "{",
      '  "overall": <integer 0-100>,',
      '  "summary": "<one-line verdict, <= 80 chars>",',
      '  "dimensions": [',
      '    { "name": "<one of the six dimension names>", "score": <integer 0-100>, "verdict": "<one-line, <= 40 chars>", "detail": "<concrete issue or strength, <= 80 chars>" }',
      "  ],",
      '  "suggestions": [',
      '    { "priority": "<high|medium|low>", "title": "<short title, <= 40 chars>", "desc": "<how to do it, <= 90 chars>" }',
      "  ]",
      "}",
      "",
      "# Subject to review",
      target,
    ].join("\n");
  }

  const tone =
    input.strictness === "strict"
      ? "采用严苛挑剔的标准，分数从严，绝不放过任何瑕疵。"
      : input.strictness === "relaxed"
        ? "以鼓励为主，分数偏宽，重点指出真正影响体验的问题。"
        : "采用专业客观的标准，既肯定优点也直指问题，分数要拉开差距。";
  const target = input.imagePath
    ? `待评审设计的本地图片文件：${input.imagePath}\n请读取该本地图片文件并基于图片进行视觉评审。`
    : `网站链接：${input.url}\n请先用你可用的浏览/网页抓取工具实际打开该链接，并以你真实获取到的页面内容为准进行评审，不要凭记忆臆测。若确实无法访问（内网、localhost、需登录或不可达），不要编造分数：将 overall 记为 0，并在 summary 中说明无法访问。`;
  return [
    "# 角色",
    `你是一位资深设计总监，正在做一次严格、专业的界面设计评审。${tone}`,
    "",
    "# 任务",
    "评审我提供的界面设计，从下面六个【固定且有序】的维度逐一打分，并产出一份可直接执行的改进清单。",
    "",
    "# 评分维度（必须全部覆盖，name 与顺序严格如下，不得增删改名）",
    ...dims.map((name, index) => `${index + 1}. ${name}`),
    "",
    "# 输出格式（极其严格，违反则视为失败）",
    "- 只输出一个合法的 JSON 对象；不要任何前后缀、说明、注释或 markdown 代码块。",
    "- 全部使用简体中文，措辞具体、可执行，严格遵守每个字段的字数上限。",
    "- 务必保证整段 JSON 完整闭合且尽量精简。",
    "",
    "{",
    '  "overall": <整数 0-100>,',
    '  "summary": "<一句话总评，≤26字>",',
    '  "dimensions": [',
    '    { "name": "<上述六个维度名之一>", "score": <整数 0-100>, "verdict": "<一句话判断，≤12字>", "detail": "<具体问题或亮点，≤26字>" }',
    "  ],",
    '  "suggestions": [',
    '    { "priority": "<高|中|低>", "title": "<建议标题，≤12字>", "desc": "<具体怎么做，≤28字>" }',
    "  ]",
    "}",
    "",
    "# 待评审对象",
    target,
  ].join("\n");
}

