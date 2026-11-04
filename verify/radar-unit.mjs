/**
 * 工作小管家的纯逻辑单测（不需要浏览器）。
 *
 * 只测 client.js 里那些"给定输入必定得到同样输出"的函数：状态分类、分段、排序、
 * 本地记忆、位置夹取/吸附、本地存储的容错。渲染与装配在 apply-smoke.mjs 里测。
 *
 * 跑法：node verify/radar-unit.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
let passed = 0;

/**
 * 一条断言。
 * @param {boolean} ok 条件。
 * @param {string} label 说明。
 * @param {unknown} [detail] 失败时附带的现场。
 */
function check(ok, label, detail) {
  if (ok) {
    passed += 1;
    return;
  }
  failures += 1;
  console.error(`✗ ${label}`);
  if (detail !== undefined) console.error("  ", JSON.stringify(detail));
}

/**
 * 深相等（够用的版本：只处理 JSON 值）。
 * @param {unknown} a 左。
 * @param {unknown} b 右。
 * @returns {boolean} 是否相等。
 */
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── 装载 client.js：把 window / localStorage / react 换成假的 ─────────────────
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
globalThis.window = {
  __ModuleLoader__: { load: (definition) => { globalThis.__loaded = definition; } },
  console: { info() {}, warn() {} },
};
globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, style: {} }), head: { appendChild() {} } };

const ReactStub = {
  createElement: () => null,
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === "function" ? value() : value, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  memo: (component) => component,
};
const requireStub = (name) => {
  if (name === "react") return ReactStub;
  throw new Error("unexpected require: " + name);
};

await import(pathToFileURL(join(here, "..", "client.js")).href);
const radar = globalThis.__loaded.factory(requireStub);

// ── 纯函数 ───────────────────────────────────────────────────────────────────
check(radar.formatClock(1200) === "1s", "formatClock: 1.2 秒 → 1s", radar.formatClock(1200));
check(radar.formatClock(65_000) === "1:05", "formatClock: 65 秒 → 1:05", radar.formatClock(65_000));
check(radar.formatClock(3_725_000) === "1:02:05", "formatClock: 1h2m5s → 1:02:05", radar.formatClock(3_725_000));
check(radar.formatClock(55_320_000) === "15h22m", "formatClock: 15 小时以上折成 15h22m", radar.formatClock(55_320_000));
check(radar.formatClock(220_806_000) === "61h20m", "formatClock: 两天以上折成 61h20m", radar.formatClock(220_806_000));
check(radar.formatClock(4 * 3600_000) === "4:00:00", "formatClock: 10 小时内仍然带秒", radar.formatClock(4 * 3600_000));
check(radar.formatAgo(800) === "刚刚", "formatAgo: 0.8 秒 → 刚刚", radar.formatAgo(800));
check(radar.formatAgo(45_000) === "45 秒前", "formatAgo: 45 秒", radar.formatAgo(45_000));
check(radar.formatAgo(125_000) === "2 分钟前", "formatAgo: 125 秒", radar.formatAgo(125_000));
check(radar.formatAgo(7_200_000) === "2 小时前", "formatAgo: 2 小时", radar.formatAgo(7_200_000));
check(radar.basename("D:\\work\\skill\\") === "skill", "basename: Windows 路径取末段", radar.basename("D:\\work\\skill\\"));
check(radar.basename("/home/me/proj") === "proj", "basename: POSIX 路径取末段", radar.basename("/home/me/proj"));

check(radar.todoProgress(null) === null, "todoProgress: 没有投影 → null");
check(same(radar.todoProgress([]), null), "todoProgress: 空数组 → null");
check(same(radar.normalizeUsage({ prompt_tokens: 1200, completion_tokens: 350, total_tokens: 1550 }), {
  inputTokens: 1200,
  outputTokens: 350,
  totalTokens: 1550,
}), "normalizeUsage: 兼容 API 命名并保留总量", radar.normalizeUsage({ prompt_tokens: 1200, completion_tokens: 350, total_tokens: 1550 }));
check(radar.normalizeUsage({}) === null, "normalizeUsage: 空对象 → null");
check(same(radar.trajectoryUsage({ requests: [
  { purpose: "assistant", usage: { inputTokens: 100, outputTokens: 20 } },
  { purpose: "assistant", usage: { inputTokens: 300, outputTokens: 50, reasoningTokens: 10 } },
  { purpose: "compaction", usage: { inputTokens: 999, outputTokens: 999 } },
] }), {
  usage: { inputTokens: 300, outputTokens: 50, reasoningTokens: 10 },
  cumulativeUsage: { inputTokens: 400, outputTokens: 70, reasoningTokens: 10, totalTokens: 470 },
}), "trajectoryUsage: 取最近请求并累计会话用量");
check(radar.usageTotal({ inputTokens: 1200, outputTokens: 350 }) === 1550, "usageTotal: 缺 totalTokens 时按输入加输出");
check(radar.formatTokens(1550) === "1.6K", "formatTokens: 1550 → 1.6K", radar.formatTokens(1550));
check(same(radar.usageSummary({
  usage: { inputTokens: 1200, outputTokens: 350, reasoningTokens: 80 },
  cumulativeUsage: { inputTokens: 5000, outputTokens: 1800, totalTokens: 6800 },
}), {
  label: "本次 1.6K · 累计 6.8K",
  title: "输入 1.2K · 输出 350 · 推理 80",
}), "usageSummary: 生成行上摘要和明细", radar.usageSummary({
  usage: { inputTokens: 1200, outputTokens: 350, reasoningTokens: 80 },
  cumulativeUsage: { inputTokens: 5000, outputTokens: 1800, totalTokens: 6800 },
}));
check(
  same(radar.usageFigure({
    usage: { inputTokens: 1200, outputTokens: 350 },
    cumulativeUsage: { inputTokens: 5000, outputTokens: 1800, totalTokens: 6800 },
  }), { value: 6800, basis: "cumulative" }),
  "usageFigure: 有累计就用累计（「这个任务烧了多少」问的是累计，不是最后一次请求）",
);
check(
  same(radar.usageFigure({ usage: { inputTokens: 1200, outputTokens: 350 }, cumulativeUsage: null }), { value: 1550, basis: "current" }),
  "usageFigure: 宿主只给单次时退回单次",
);
check(radar.usageFigure({ usage: null, cumulativeUsage: null }) === null, "usageFigure: 没有用量就返回 null（不拿字符数估一个假数）");
check(radar.usageFigure({ usage: { inputTokens: 0, outputTokens: 0 }, cumulativeUsage: null }) === null, "usageFigure: 全 0 当成没有");

const chip = radar.usageChip({
  usage: { inputTokens: 1200, outputTokens: 350, reasoningTokens: 80 },
  cumulativeUsage: { inputTokens: 900_000, outputTokens: 300_000, cacheReadTokens: 100_000, totalTokens: 1_200_000 },
});
check(chip.label === "1.2M tok", "usageChip: 行上只留一个数（卡片窄，两个数会把模型标签挤没）", chip.label);
check(chip.title.includes("累计 1.2M") && chip.title.includes("本次 1.6K"), "usageChip: 悬浮里两个口径都在", chip.title);
check(chip.title.includes("输入 900K") && chip.title.includes("输出 300K") && chip.title.includes("缓存读 100K"), "usageChip: 悬浮里有输入/输出/缓存明细", chip.title);
check(chip.basis === "cumulative", "usageChip: 标出口径");
check(radar.usageChip({ usage: null, cumulativeUsage: null }) === null, "usageChip: 没用量就不出行（不渲染空 chip）");

// ── 三套 usage 命名都要认（否则真宿主上永远是空的）────────────────────────────
// 1) 本仓宿主的权威形状：tokenUsage 投影，四个桶不相交，缓存在输入之外。
const hostUsage = radar.normalizeUsage({ uncachedInputTokens: 200_000, outputTokens: 300_000, cacheReadTokens: 100_000, cacheWriteTokens: 0 });
check(hostUsage?.inputSeparate === true, "normalizeUsage: tokenUsage 投影标出「输入不含缓存」");
check(hostUsage.inputTokens === 200_000 && hostUsage.cacheReadTokens === 100_000, "normalizeUsage: uncachedInputTokens 认成输入");
check(radar.usageTotal(hostUsage) === 600_000, "usageTotal: 缓存读算进总数（漏掉会少算四成）");
// 2) Trajectory 短名
check(
  radar.usageTotal(radar.normalizeUsage({ input: 100, output: 200, cacheRead: 50, reasoning: 80 })) === 350,
  "usageTotal: 短名形状 = 输入 + 缓存 + 输出，reasoning 已在 output 里不再加",
);
// 3) provider 原样：prompt_tokens 已含缓存，不能再加一次缓存
check(
  radar.usageTotal(radar.normalizeUsage({ prompt_tokens: 1000, completion_tokens: 200 })) === 1200,
  "usageTotal: prompt_tokens 已含缓存，不重复加",
);
check(radar.normalizeUsage({ input_tokens: 8, cache_read_input_tokens: 2, output_tokens: 5 }) !== null, "normalizeUsage: 认 tokenUsage 之外的 snake_case");

// 投影优先：有 tokenUsage 就不必去问 trajectory（那个要按会话逐个取快照，贵）
const viaProjection = radar.usageOf({
  values: {
    tokenUsage: { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 },
    usage: { inputTokens: 999, outputTokens: 1 },
  },
});
check(viaProjection.usage === null && viaProjection.cumulativeUsage.inputTokens === 10, "usageOf: 有 tokenUsage 时只信投影，别的名字让位", viaProjection);
check(radar.usageTotal(viaProjection.cumulativeUsage) === 35, "usageOf: 投影算出来 35（10 + 5 缓存 + 20）");
check(
  radar.usageOf({ values: { tokenUsage: { totals: { uncachedInputTokens: 7, outputTokens: 3 } } } }).cumulativeUsage?.inputTokens === 7,
  "usageOf: 兼容带 totals 那一层的状态形状",
);
check(
  radar.usageTotal(radar.usageOf({ values: {} }, { usage: { inputTokens: 1, outputTokens: 2 }, cumulativeUsage: { inputTokens: 3, outputTokens: 4 } }).cumulativeUsage) === 7,
  "usageOf: 投影没有时退回 trajectory（本次 + 累计都在）",
);
check(
  radar.usageTotal(radar.usageOf({ values: {} }, () => ({ usage: null, cumulativeUsage: { inputTokens: 9, outputTokens: 1 } })).cumulativeUsage) === 10,
  "usageOf: trajectory 可以惰性传入（有投影时根本不会调用）",
);
let trajectoryAsked = 0;
radar.usageOf({ values: { tokenUsage: { outputTokens: 5 } } }, () => {
  trajectoryAsked += 1;
  return { usage: null, cumulativeUsage: null };
});
check(trajectoryAsked === 0, "usageOf: 有投影时确实没去取 trajectory");

check(
  same(radar.todoProgress([
    { content: "写方案", status: "completed" },
    { content: "做原型", status: "in_progress" },
    { content: "验收", status: "pending" },
  ]), {
    total: 3,
    done: 1,
    current: "做原型",
    // items 是给"就地展开看清单"用的，顺序跟宿主给的一致。
    items: [
      { content: "写方案", status: "completed" },
      { content: "做原型", status: "in_progress" },
      { content: "验收", status: "pending" },
    ],
  }),
  "todoProgress: 总数 / 已完成 / 正在做 / 完整清单",
  radar.todoProgress([
    { content: "写方案", status: "completed" },
    { content: "做原型", status: "in_progress" },
    { content: "验收", status: "pending" },
  ]),
);

// 脏数据：没有 content 的条目不该进清单，也不该被当成"正在做的那一步"。
check(
  same(radar.todoProgress([{ content: "", status: "in_progress" }, { content: "验收", status: "done-ish" }]), {
    total: 2,
    done: 0,
    current: null,
    items: [{ content: "验收", status: "pending" }],
  }),
  "todoProgress: 空内容丢掉 / 未知状态当 pending",
  radar.todoProgress([{ content: "", status: "in_progress" }, { content: "验收", status: "done-ish" }]),
);

check(radar.pendingLabel({ kind: "approval" }) === "待批准", "pendingLabel: approval");
check(radar.pendingLabel({ kind: "plan-review" }) === "计划待审", "pendingLabel: plan-review");
check(radar.pendingLabel({ kind: "question" }) === "待回答", "pendingLabel: question");
check(radar.pendingLabel({ kind: "whatever" }) === "等待处理", "pendingLabel: 认不出就退回等待处理");
check(radar.pendingLabel(undefined) === "等待处理", "pendingLabel: 没有交互对象也不崩");

const memory = { running: {}, finished: {}, opened: {} };
const now = 1_000_000;
check(radar.classify({ pending: { kind: "approval" }, running: true, unread: true }, memory, "a", now) === "waiting", "classify: 等你处理压过运行中");
check(radar.classify({ pending: null, running: true, unread: true }, memory, "a", now) === "running", "classify: 运行中压过未读");
check(radar.classify({ pending: null, running: false, unread: true }, memory, "a", now) === "done", "classify: 宿主未读 → 刚完成");
check(radar.classify({ pending: null, running: false, unread: false }, memory, "a", now) === "idle", "classify: 都没有 → 空闲");
check(
  radar.classify({ pending: null, running: false, unread: false }, { running: {}, finished: { a: now - 60_000 }, opened: {} }, "a", now) === "done",
  "classify: 本地记的完成（刷新后仍认）",
);
check(
  radar.classify({ pending: null, running: false, unread: false }, { running: {}, finished: { a: now - 60_000 }, opened: { a: now - 30_000 } }, "a", now) === "idle",
  "classify: 打开过就不再算刚完成",
);

// ── 模型装配 ─────────────────────────────────────────────────────────────────
const list = {
  phase: "ready",
  ids: ["run", "wait", "done", "blank", "sub", "arch"],
  byId: {
    run: { id: "run", displayTitle: "重写鉴权中间件", running: true, updatedAt: 900_000, cwd: "D:/work/skill" },
    wait: { id: "wait", displayTitle: "迁移数据库", running: false, updatedAt: 950_000 },
    done: { id: "done", displayTitle: "生成周报", running: false, updatedAt: 990_000 },
    blank: { id: "blank", displayTitle: "新会话", running: false, blank: true, updatedAt: 999_000 },
    sub: { id: "sub", displayTitle: "子代理：查文档", running: true, updatedAt: 980_000, origin: "subagent", parentId: "run" },
    arch: { id: "arch", displayTitle: "已归档的旧任务", running: false, updatedAt: 500_000 },
  },
  projectionsBySession: {
    run: { values: {
      todos: [{ content: "拆接口", status: "completed" }, { content: "补测试", status: "in_progress" }, { content: "回归", status: "pending" }, { content: "上线", status: "pending" }],
      modelSelection: { lastUsed: { provider: "deepseek", model: "v4.1-flash" }, next: null },
      usage: { inputTokens: 1200, outputTokens: 350, reasoningTokens: 80 },
      cumulativeUsage: { inputTokens: 5000, outputTokens: 1800, totalTokens: 6800 },
    } },
    sub: { values: {
      modelSelection: { lastUsed: { provider: "deepseek", model: "v4.1-pro" }, next: { provider: "deepseek", model: "v4.1-pro" } },
      subagentTiming: { settledMs: 5000, active: { since: 940_000, through: 999_000 } },
    } },
  },
};
const statuses = new Map([
  ["run", { running: true, pendingInteraction: undefined, completionUnread: false }],
  ["wait", { running: false, pendingInteraction: { kind: "approval", key: "k1", sessionId: "wait" }, completionUnread: false }],
  ["done", { running: false, pendingInteraction: undefined, completionUnread: true }],
  ["sub", { running: true, pendingInteraction: undefined, completionUnread: false }],
]);
const workspaces = {
  items: [
    { workspaceId: "w1", title: "skill", path: "D:/work/skill", sessionIds: ["run", "wait", "sub"] },
    { workspaceId: "w2", title: "内容生产", path: "D:/work/content", sessionIds: ["done"] },
  ],
  archivedSessionIds: ["arch"],
};

const model = radar.buildModel({
  list, statuses, workspaces,
  memory: { running: { run: 880_000 }, finished: {}, opened: {} },
  now,
  settings: { showIdle: true, notify: true },
});

check(same(model.counts, { waiting: 1, running: 1, done: 1, idle: 0, total: 3 }), "buildModel: 分段计数（空会话/归档/子代理都不算行）", model.counts);
check(model.sections.waiting[0].id === "wait" && model.sections.waiting[0].waitLabel === "待批准", "buildModel: 等你处理带短标签");
check(model.sections.running[0].id === "run", "buildModel: 正在跑");
check(model.sections.running[0].workspace === "skill", "buildModel: 行尾工作区标签", model.sections.running[0].workspace);
check(same(model.sections.running[0].todo, {
  total: 4,
  done: 1,
  current: "补测试",
  items: [
    { content: "拆接口", status: "completed" },
    { content: "补测试", status: "in_progress" },
    { content: "回归", status: "pending" },
    { content: "上线", status: "pending" },
  ],
}), "buildModel: todo 进度 + 完整清单进到行里");
check(model.sections.done[0].id === "done" && model.sections.done[0].workspace === "内容生产", "buildModel: 刚完成 + 工作区");
check(model.subagents.run === 1, "buildModel: 子代理记到父行上", model.subagents);
check(model.totals.sessions === 3 && model.totals.subagents === 1, "buildModel: 尾巴上的总量（会话/子代理）", model.totals);
check(model.sections.running[0].model === "v4.1-flash", "buildModel: 行上带模型 id", model.sections.running[0].model);
check(same(model.sections.running[0].usageSummary, {
  label: "本次 1.6K · 累计 6.8K",
  title: "输入 1.2K · 输出 350 · 推理 80",
}), "buildModel: 会话行带 Token 摘要", model.sections.running[0].usageSummary);

const subs = model.sections.running[0].children;
check(subs.length === 1 && subs[0].id === "sub", "buildModel: 子代理挂在父行的 children 里，不单独占行", subs.map((kid) => kid.id));
check(subs[0].model === "v4.1-pro", "buildModel: 子代理用 next（用户刚切过的那个）", subs[0].model);
check(subs[0].since === 940_000, "buildModel: 子代理时长取宿主的 subagentTiming.active.since", subs[0].since);
check(model.rows.every((row) => row.id !== "sub"), "buildModel: 子代理不再混进顶层行");

// ── 工作区任务分组：会话是任务，子代理仍挂在父会话下 ───────────────────────
check(model.groups.length === 2, "buildModel: 按工作区形成两组", model.groups.map((group) => group.title));
check(model.groups[0].title === "skill" && model.groups[1].title === "内容生产", "buildModel: 工作区标题保留为上下文");
check(model.groups[0].rows.map((row) => row.id).join(",") === "wait,run", "buildModel: 工作区内按待处理→进行中排序");
check(model.groups[1].rows[0].id === "done", "buildModel: 完成任务在自己的工作区里");
check(model.groups[0].rows.find((row) => row.id === "run").todo.items.length === 4, "buildModel: 进行中的任务携带完整待办清单");
check(model.groups[0].rows.some((row) => row.id === "run" && row.children.length === 1), "buildModel: 子代理直接挂在任务会话下面");

// 父会话已停，但后台子代理仍活跃：必须参与父行分段，不能藏进空闲。
for (const unread of [false, true]) {
  const background = radar.buildModel({
    list: { ids: ["parent", "child"], byId: {
      parent: { id: "parent", running: false },
      child: { id: "child", origin: "subagent", parentId: "parent", running: true },
    }, projectionsBySession: {} },
    statuses: new Map([["parent", { running: false, completionUnread: unread }]]),
    workspaces: EMPTY(), memory, now,
  });
  check(background.counts.running === 1 && background.counts.idle === 0 && background.counts.done === 0,
    `后台子代理: 父行${unread ? "未读完成" : "空闲"}时仍计为运行中`, background.counts);
  check(background.groups.some((group) => group.rows.some((row) => row.id === "parent")),
    "后台子代理: 父行仍出现在工作区，不被隐藏");
}
const noModel = radar.buildModel({
  list: { phase: "ready", ids: ["x"], byId: { x: { id: "x", displayTitle: "无投影", running: false, updatedAt: 1 } }, projectionsBySession: {} },
  statuses: new Map(), workspaces: EMPTY(), memory, now,
});
check(noModel.rows[0].model === "" && noModel.rows[0].children.length === 0, "buildModel: 没有投影就老老实实空着");

const idleModel = radar.buildModel({
  list: {
    phase: "ready",
    ids: ["i1", "i2"],
    byId: {
      i1: { id: "i1", displayTitle: "旧任务一", running: false, updatedAt: 10 },
      i2: { id: "i2", displayTitle: "旧任务二", running: false, updatedAt: 20 },
    },
  },
  statuses: new Map(),
  workspaces: { items: [], archivedSessionIds: [] },
  memory,
  now,
  settings: { showIdle: true, notify: true },
});
check(idleModel.counts.idle === 2 && idleModel.idle[0].id === "i2", "buildModel: 空闲按最近活动排");

const pendingModel = radar.buildModel({
  list: { phase: "pending", ids: [], byId: {}, projectionsBySession: {} },
  statuses: new Map(), workspaces: EMPTY(), memory, now, settings: { showIdle: true, notify: true },
});
check(pendingModel.phase === "pending" && pendingModel.counts.total === 0, "buildModel: 列表还没到时是 pending 相位");

function EMPTY() {
  return { items: [], archivedSessionIds: [] };
}

// ── 本地记忆的状态机 ─────────────────────────────────────────────────────────
const step1 = radar.updateMemory(
  { running: {}, finished: {}, opened: {} },
  { rows: [{ id: "a", kind: "running" }] },
  1000,
);
check(step1.running.a === 1000, "updateMemory: 看到在跑就记开始时刻");

const step2 = radar.updateMemory(step1, { rows: [{ id: "a", kind: "done" }] }, 5000);
check(step2.running.a === undefined && step2.finished.a === 5000, "updateMemory: 从跑到停 → 记完成时刻", step2);

const step3 = radar.updateMemory(step2, { rows: [{ id: "a", kind: "idle" }] }, 6000);
check(step3.finished.a === 5000, "updateMemory: 完成记录不会因为下一帧就丢");

const opened = radar.updateMemory(
  step2,
  { rows: [{ id: "a", kind: "done" }] },
  7000,
);
check(opened.finished.a === 5000, "updateMemory: 未打开前保留完成记录");

const cleared = radar.updateMemory(
  { ...step2, opened: { a: 9000 } },
  { rows: [{ id: "a", kind: "done" }] },
  10_000,
);
check(cleared.finished.a === undefined, "updateMemory: 打开过就清掉完成记录");

const restarted = radar.updateMemory(step2, { rows: [{ id: "a", kind: "running" }] }, 20_000);
check(restarted.finished.a === undefined && restarted.running.a === 20_000, "updateMemory: 重新跑起来会清掉旧的完成记录");

const stale = radar.updateMemory(
  { running: {}, finished: { old: 0 }, opened: {} },
  { rows: [] },
  13 * 3600 * 1000,
);
check(stale.finished.old === undefined, "updateMemory: 过期的完成记录会被扔掉");

check(radar.memorySignature({ rows: [{ id: "a", kind: "running" }, { id: "b", kind: "idle" }] }) === "a:running|b:idle", "memorySignature: 谁的状态变了才推进");

// ── 位置 ─────────────────────────────────────────────────────────────────────
const vp = { w: 1440, h: 900 };
const size = { w: 336, h: 400 };
check(same(radar.clampPos({ x: -100, y: -100 }, size, vp), { x: 16, y: 16 }), "clampPos: 左上越界夹回");
check(same(radar.clampPos({ x: 9_999, y: 9_999 }, size, vp), { x: 1440 - 336 - 16, y: 900 - 400 - 16 }), "clampPos: 右下越界夹回");
check(radar.snapPos({ x: 20, y: 400 }, size, vp).x === 16, "snapPos: 离左边近就贴边");
check(radar.snapPos({ x: vp.w - size.w - 20, y: 400 }, size, vp).x === vp.w - size.w - 16, "snapPos: 离右边近就贴边");
check(radar.snapPos({ x: 400, y: 300 }, size, vp).x === 400, "snapPos: 离边远就不动");

// ── 本地存储 ─────────────────────────────────────────────────────────────────
const fresh = radar.readStore("nope");
check(fresh.view.collapsed === false && fresh.view.pos === null && fresh.memory.running && Object.keys(fresh.memory.running).length === 0, "readStore: 没有记录给默认值");

check(radar.writeStore("t1", { view: { pos: { x: 100, y: 200 }, collapsed: true, idleOpen: true, settings: { showIdle: false, notify: false } }, memory: { running: { a: 1 }, finished: {}, opened: {} } }), "writeStore: 写入成功");
const roundTrip = radar.readStore("t1");
check(same(roundTrip.view.pos, { x: 100, y: 200 }) && roundTrip.view.collapsed === true, "readStore: 位置与折叠读回来");
check(roundTrip.view.settings.showIdle === false && roundTrip.view.settings.notify === false, "readStore: 设置读回来");
check(roundTrip.memory.running.a === 1, "readStore: 记忆读回来");

store.set("bad", "{ not json");
check(radar.readStore("bad").view.collapsed === false, "readStore: 坏 JSON 退回默认值");

store.set("partial", JSON.stringify({ view: { settings: { notify: "yes" } }, memory: { running: "nope" } }));
const partial = radar.readStore("partial");
check(partial.view.settings.notify === true && same(partial.memory.running, {}), "readStore: 非法字段回落到默认值");

const throwing = radar.readStore("x", { getItem() { throw new Error("boom"); } });
check(throwing.view.pos === null, "readStore: 存储抛错也不炸");

// 默认外观是发给别人的第一眼，必须是完整的插画主题（不是「跟随宿主」那种像没装的灰白）。
check(fresh.view.theme.preset === "osmanthus", "readStore: 头一次装上默认就是桂花月兔", fresh.view.theme);
store.set("keep", JSON.stringify({ view: { theme: { preset: "raven", opacity: 80, image: "" } } }));
check(radar.readStore("keep").view.theme.preset === "raven", "readStore: 用户选过的主题不会被默认值盖掉");
store.set("dirty", JSON.stringify({ view: { theme: { preset: "no-such-theme" } } }));
check(radar.readStore("dirty").view.theme.preset === "osmanthus", "readStore: 主题名不认识就退回默认（不是留着坏值渲染一屏没样式）");

// ── 换肤桥：normalizeSkinSnapshot ────────────────────────────────────────────
/**
 * 这一段钉的是"对方给什么都不能把面板画崩"。
 *
 * 快照来自另一个插件，形状只靠一份口头契约维持：它升级、改字段、或者干脆
 * 传个 `{}`，本面板都不该出现空白选择器或点了没反应的按钮。
 */
const clean = {
  skin: "graphite",
  skinLabel: "石墨灰",
  wallpaper: "__paper__",
  skins: [
    { id: "graphite", label: "石墨灰", note: "中性灰", accent: "#a8c2d4", bg: "#1b1f24", panel: "linear-gradient(#111,#222)", swatches: ["#111", "#222", "#333"] },
    { id: "sand", label: "米沙纸", swatches: ["#111"] },
  ],
  wallpapers: [
    { id: "__paper__", label: "米纸纹", kind: "css" },
    { id: "__rainbow__", label: "黄昏彩虹", kind: "image" },
  ],
};
const normalized = radar.normalizeSkinSnapshot(clean);
check(normalized !== null && normalized.skin === "graphite" && normalized.skinLabel === "石墨灰", "换肤桥: 正常快照被接受");
check(normalized.wallpapers.length === 2 && normalized.wallpapers[0].kind === "css", "换肤桥: 壁纸种类透传（css / image）");
check(normalized.skins[1].swatches.length === 1, "换肤桥: 少给色块也照收");

check(radar.normalizeSkinSnapshot(null) === null, "换肤桥: null → 视为没接上");
check(radar.normalizeSkinSnapshot({}) === null, "换肤桥: 空对象 → 视为没接上");
check(radar.normalizeSkinSnapshot({ skins: [] }) === null, "换肤桥: 没有皮肤 → 视为没接上");
check(radar.normalizeSkinSnapshot({ skins: [{ id: 1 }, { label: "没 id" }] }) === null, "换肤桥: 皮肤缺 id/label 全部丢掉");

const mixedIn = radar.normalizeSkinSnapshot({
  skins: [{ id: "ok", label: "可用" }, { id: "", label: "空 id" }, null, { id: "ok2" }],
  wallpapers: [{ id: "w", label: "壁纸" }, { id: "w2" }],
});
check(mixedIn.skins.length === 1 && mixedIn.skins[0].id === "ok", "换肤桥: 脏皮肤条目被过滤，好的留着", mixedIn.skins);
check(mixedIn.wallpapers.length === 1, "换肤桥: 脏壁纸条目被过滤", mixedIn.wallpapers);
check(mixedIn.skinLabel === "" && mixedIn.skin === "", "换肤桥: 没给当前皮肤时不瞎猜");

const curated = radar.normalizeSkinSnapshot({
  skin: "b",
  skins: [
    { id: "a", label: "A", swatches: Array.from({ length: 9 }, (_v, i) => `#${i}${i}${i}`) },
    { id: "b", label: "B" },
  ],
});
check(curated.skinLabel === "B", "换肤桥: 没给 skinLabel 时按当前 id 反推名字", curated.skinLabel);
check(curated.skins[0].swatches.length === 5, "换肤桥: 色块最多取 5 个（面板只画 3 个）", curated.skins[0].swatches.length);

const oversized = radar.normalizeSkinSnapshot({ skins: Array.from({ length: 60 }, (_v, i) => ({ id: `s${i}`, label: `S${i}` })) });
check(oversized.skins.length === 24, "换肤桥: 皮肤卡最多 24 张，不把面板画成墙", oversized.skins.length);

// ── 换肤桥：出口与样式表结构 ─────────────────────────────────────────────────
check(radar.SKIN_EVENT_APPLY === "dsh-skin:apply" && radar.SKIN_EVENT_CHANGED === "dsh-skin:changed",
  "换肤桥: 事件名与 dsh-plugin-skin 对齐（写错就是点了没反应）");

const sent = [];
const realWindow = globalThis.window;
globalThis.window = { ...realWindow, dispatchEvent: (event) => { sent.push(event); return true; } };
check(radar.requestSkinApply({ skin: "sand" }) === true, "换肤桥: 有事件环境时派发成功");
check(sent.length === 1 && sent[0].type === "dsh-skin:apply" && sent[0].detail.skin === "sand",
  "换肤桥: 派发的是 dsh-skin:apply，detail 带皮肤 id", sent.map((event) => event.type));
globalThis.window = { ...realWindow, dispatchEvent: undefined };
check(radar.requestSkinApply({ skin: "sand" }) === false, "换肤桥: 没有 dispatchEvent 时返回 false 而不抛");
globalThis.window = realWindow;

/**
 * 回归守门：主区面板的 CSS 必须**在** `prefers-reduced-motion` 媒体查询之外。
 *
 * 2026-11-02 真的踩过：面板规则被插进了那个 @media 里面，
 * 结果只有"系统开了减少动效"的用户才看得到面板样式，其余人看到的是裸的浏览器默认按钮。
 * 假 DOM 里看不出来（测试只取 textContent），只能直接查样式表正文。
 */
const css = radar.CSS || "";
// 外观那几条要查"源码里有没有这段分支/这个常量"，所以顺手把 client.js 读成字符串。
const clientSource = readFileSync(join(here, "..", "client.js"), "utf8");
const mediaAt = css.indexOf("@media (prefers-reduced-motion:reduce)");
const panelAt = css.indexOf(".dtr-panel{");
const skinAt = css.indexOf(".dtr-skin{");
check(mediaAt >= 0 && panelAt > mediaAt, "样式: 面板规则写在减少动效媒体查询之后", { mediaAt, panelAt });
const mediaBlock = mediaAt >= 0 && panelAt > mediaAt ? css.slice(mediaAt, panelAt) : "";
check(
  (mediaBlock.match(/\{/g) || []).length === (mediaBlock.match(/\}/g) || []).length,
  "样式: 减少动效那条 @media 自己闭合了（没把后续规则吞进去）",
  mediaBlock.length,
);
check(skinAt > panelAt && skinAt > 0, "样式: 换肤区有独立样式块");
check(/\.dtr-skin-grid\{display:grid/.test(css), "样式: 皮肤卡走 grid 布局");

// ── 换壁纸之后字还看得见 ─────────────────────────────────────────────────────
/**
 * 2026-11-02 用户报的真问题：换了一张深色壁纸，面板和小窗里"有些字看不见，鼠标移上去才看得见"。
 *
 * 根因不在文字颜色：皮肤插件为了把壁纸透出来，会把**表面**令牌的透明度压到 0.4~0.6，
 * 而文字令牌还是实色。深色壁纸从半透明的面板底下透上来，深色字就糊在上面；
 * hover 换了背景才在字后面垫上点东西，于是"移上去就看见了"。
 *
 * 修法：承载文字的面改用 relative color（rgb(from <令牌> r g b)）抹掉 alpha ——
 * 色相仍跟宿主/皮肤走，面永远实心。这里钉住三件事：兜底规则在、写在原规则**之后**、面板自己有底。
 */
const plateAt = css.indexOf("background-color:rgb(from var(--dsw-alias-bg-base");
const cardAt = css.indexOf(".dtr-card{");
const pillAt = css.indexOf(".dtr-pill{");
check(plateAt > 0, "换壁纸: 面板有一层实心底（原来它压根没有背景，字直接压在壁纸上）");
check(cardAt >= 0 && plateAt > cardAt, "换壁纸: 实心兜底写在卡片规则之后（写在前面会被覆盖，等于没改）");
check(pillAt >= 0 && plateAt > pillAt, "换壁纸: 实心兜底也盖住了胶囊");
check(/\.dtr-card\{[^}]*background-color:rgb\(from var\(--dsw-alias-bg-layer-1/.test(css), "换壁纸: 卡片底色不再直接吃宿主的半透明令牌");
check(/\.dtr-head,\.dtr-foot[^{]*\{background-color:rgb\(from/.test(css), "换壁纸: 卡头/卡尾/设置页这些承载文字的面都实心化");
check(!/\.dtr-panel-row:hover\{background:rgb\(from/.test(css), "换壁纸: hover 层保持半透明（实心 hover 会把行糊成色块）");
// 踩过的坑：relative color 省略 alpha 时会**继承原色的透明度**，
// `rgb(from rgba(...,.42) r g b)` 算出来还是 0.42 —— 看着"改了"，其实一点没变。
// 注释里也写着 `rgb(from … r g b)` 当例子，所以先剥注释再数。
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");
check((cssCode.match(/ r g b\)/g) || []).length === 0, "换壁纸: 没有漏写 / 1 的 relative color（省略 alpha 会继承令牌透明度，等于白改）");
check((cssCode.match(/ r g b \/ 1\)/g) || []).length >= 5, "换壁纸: 承载文字的面都显式把 alpha 钉成 1");
// 品牌蓝当小字用只有 4.3:1（实测），差一点点不到 AA 4.5。往字色里收 22% 就够，
// 而且这个混法是"往当前字色靠"，深色主题下自动变成提亮，不用分两套。
check(
  /\.dtr-panel-row \.dtr-panel-tok\{[^}]*color:color-mix\(in srgb,var\(--dsw-alias-state-business-primary/.test(css),
  "换壁纸: Token 数字的品牌蓝往字色里收过（纯品牌蓝 12px 文字只有 4.3:1，不到 AA）",
);

// ── 外观：樱粉主题与角上的装饰画 ─────────────────────────────────────────────
// 这套语言（同色系柔光 + 角上探出植物 + 发丝树线）是照着同事那版 Agent Tree Dock 的思路做的，
// 但画的是自己的东西：只有植物，不画人物。
check(radar.THEME_PRESETS.sakura?.deco === "sakura", "主题: 樱粉存在且带 deco 标记", JSON.stringify(radar.THEME_PRESETS.sakura));
check(radar.THEME_PRESETS.sakura?.tone === "light", "主题: 樱粉按浅色排版（深色文字）");
check(
  Object.values(radar.THEME_PRESETS).filter((preset) => preset.deco).length === 6,
  "主题: 自带插画的只有这六套（樱粉 + 五个角色），别的主题是纯配色，不出插画",
);
// 装饰图是内联 data URI：插件不注册路由，图片只能内联（同图标那套理由）。
check(/^data:image\/png;base64,[A-Za-z0-9+/=]{2000,}$/.test(radar.DECO_ART.branch ?? ""), "装饰: 樱花枝是内联 PNG data URI");
check(/^data:image\/png;base64,[A-Za-z0-9+/=]{2000,}$/.test(radar.DECO_ART.sprig ?? ""), "装饰: 小花簇是内联 PNG data URI");
// 150px 显示宽度要 2 倍屏，所以图本身得够大 —— 320px 宽的源图缩到 150 才不糊。
check((radar.DECO_ART.branch ?? "").length > 20000, "装饰: 樱花枝的 data URI 够大（源图 320px，2 倍屏用）");

// 卡片规则被覆盖过好几次（主题、换壁纸、圆形度），要取**最后一条**才算数。
const cardRule = [...radar.CSS.matchAll(/\.dtr-card\{[^}]*\}/g)].at(-1)?.[0] ?? "";
check(/border-radius:18px/.test(cardRule), "外观: 卡片圆角 18px（原来是 12px，圆一点更像一张纸）");
check(/box-shadow:[^;}]*var\(--dtr-glow/.test(cardRule), "外观: 卡片的投影跟着主题走（--dtr-glow）");
check(/var\(--dtr-grad,none\)/.test(radar.CSS), "外观: 渐变层夹在遮罩与底图之间（主题能用渐变，不破坏自定义底图）");
check(/\.dtr-headtext\{[^}]*flex-direction:column/.test(radar.CSS), "外观: 标题与小字叠成一列（不是横着一排胶囊）");
// 小字原来是 label-tertiary，实测在樱粉底上只有 3.15:1 —— 低于 AA 4.5。改回 secondary 就够了。
const badgesRule = /\.dtr-badges\{[^}]*\}/.exec(radar.CSS)?.[0] ?? "";
check(
  /color:var\(--dsw-alias-label-secondary/.test(badgesRule),
  "外观: 卡头那行小字用 secondary（tertiary 在樱粉底上只有 3.15:1，不到 AA）",
);
check(/--dsw-alias-label-tertiary:#885d6c/.test(radar.CSS), "外观: 樱粉的 tertiary 再收一档到 5.2:1（4.58 那版压在 layer-2 上只有 4.49）");
// 树线：字符留在 DOM 里，视觉上由 CSS 画成线；行里带 data-guide 让"最后一行"收起竖线。
check(/\.dtr-guide\{[^}]*width:15px/.test(radar.CSS), "树线: .dtr-guide 变成固定宽度的画线位");
check(/\.dtr-guide::before\{[^}]*background:var\(--dtr-line/.test(radar.CSS), "树线: 竖线用的是 --dtr-line（跟主题走）");
check(/data-guide="last"[\s\S]{0,80}bottom:50%/.test(radar.CSS) || /\.dtr-row\[data-guide="last"\]/.test(radar.CSS), "树线: 最后一行的竖线收在中间（画成 └，不是一根到底）");
check(/data-guide"?: *(String|guide)/.test(radar.CSS) === false, "树线: 画线逻辑不在 CSS 里猜");
const guideSpan = radar.CSS.includes("dtr-guide");
check(guideSpan, "树线: 有 .dtr-guide 相关规则");
// 装饰画压在卡片上面（z-index:2）而且大半截在卡外 —— 被背景盖住就只剩一条边，看不出是人画的东西。
check(/\.dtr-deco\{[^}]*z-index:2/.test(radar.CSS), "装饰: 压在卡片上层（藏在下面只露一条边）");
check(/\.dtr-deco\{[^}]*pointer-events:none/.test(radar.CSS), "装饰: 不吃鼠标事件（不然会挡住拖动和点击）");
check(/\.dtr-deco-layer\{display:contents\}/.test(radar.CSS), "装饰: 包壳用 display:contents（不新增布局盒子，图才能跑到卡外）");
check(/\[data-slot="tl"\]\{[^}]*top:-76px[^}]*width:120px/.test(radar.CSS), "装饰: 樱花枝 120px，且咬住卡片左上角（不再是浮在卡外的一段）");
check(/\[data-slot="br"\]\{[^}]*width:52px/.test(radar.CSS), "装饰: 卡下那簇花 52px（比上面那枝轻，不抢）");
// 设置页的滑杆底、总览格、换肤区用 layer-2；这层不跟着换，"只有主列表变色"就是这么来的。
check(/--dsw-alias-bg-layer-2:#fff1f7/.test(radar.CSS), "主题: 樱粉连 layer-2 一起换（否则设置页/总览格还是灰白的）");
// 胶囊在卡片外面，不给它一份 data-theme，收起之后还是宿主那个白。
check(/\.dtr-card\[data-theme="sakura"\],\.dtr-pill\[data-theme="sakura"\]\{/.test(radar.CSS), "主题: 胶囊也吃到樱粉令牌（展开是粉的、收起是白的就不算同步）");
check(/"data-theme": view\.theme\?\.preset \?\? "auto",/.test(clientSource), "胶囊: 渲染时把当前主题挂在 data-theme 上");
// 收起之后右端那枝花要站得住：右边得留出位置，否则压住数字。
check(/\.dtr-pill\[data-deco="true"\]\{padding-right:36px/.test(radar.CSS), "胶囊: 有装饰的主题右侧留 36px 给那枝花/头像，不压数字");
check(/\[data-slot="pill"\]\{[^}]*right:3px[^}]*width:26px/.test(radar.CSS), "胶囊: 花画在胶囊右端里面（26px，像盖了个章）");
check(/\.dtr-deco-face\[data-slot="pill"\]\{[^}]*width:30px;height:30px[^}]*background-size:240%/.test(radar.CSS), "胶囊: 人物主题的小头像放大三倍截到脸（<img> 不裁，整张人像缩进 30px 只剩一团墨）");
check(/\(var\(--dtr-focus-x[^)]*\) - 20\.83%\) \/ 0\.5833/.test(radar.CSS), "胶囊: 头像窗口按构图焦点换算（一处焦点，两处裁切）");

// ── 六套主题与它们的角饰（樱粉 + 五套角色）─────────────────────────────────
const DECO_THEMES = ["sakura", "pine-fox", "osmanthus", "nebula", "falcon", "raven"];
for (const id of DECO_THEMES) {
  check(radar.DECO_SPEC?.[id] !== undefined, `主题: ${id} 在 DECO_SPEC 里有配置`);
}
check(DECO_THEMES.every((id) => radar.DECO_SPEC[id].card?.length > 0 && radar.DECO_SPEC[id].pill?.art), "装饰: 每套都是「卡片角饰 + 胶囊里一枚」");
// 最容易烂的一条：spec 里写了 art 键，但构建脚本没注入那张图 → 界面上悄悄没有装饰。
const missingArt = Object.values(radar.DECO_SPEC ?? {}).flatMap((spec) =>
  [...spec.card.map((item) => item.art), spec.pill?.art].filter((art) => !radar.DECO_ART?.[art]));
check(missingArt.length === 0, "装饰: spec 里引用的图都在 DECO_ART 里（漏注入会静默没装饰）");
check(Object.keys(radar.DECO_ART ?? {}).length === 7, "装饰: 七张图（樱粉两件 + 五人像）都在");
for (const id of DECO_THEMES) {
  check(new RegExp(`\\.dtr-card\\[data-theme="${id}"\\],\\.dtr-pill\\[data-theme="${id}"\\]\\{`).test(radar.CSS), `主题: ${id} 的令牌块挂到了卡片和胶囊两处`);
}
check(/\[data-slot="hero"\]\{left:-96px[^}]*width:132px;height:176px[^}]*z-index:0/.test(radar.CSS), "装饰: 人像站在卡片左边，z-index 低于卡片（身子藏在窗口后面）");
check(/object-position:calc\(\(var\(--dtr-focus-x[^)]*\) - 38\.46%\) \/ 0\.2308\)/.test(radar.CSS), "装饰: 卡边窗口也按构图焦点换算（改尺寸不会把脸裁掉）");
check((radar.CSS.match(/--dtr-focus-x:/g) ?? []).length === 5, "装饰: 五套角色主题各有一个构图焦点");
check(/--dsw-alias-bg-layer-2:#f1eadd/.test(radar.CSS), "主题: 墨刃黑鸦连 layer-2 一起换");

// 令牌对比度：每套主题三档墨色都要在 layer-1 / layer-2 上都过 4.5。
// 为什么不只靠像素测量：这里量的是**设计意图**（写死的颜色），改动时最先发现不对；
// 像素测量要起浏览器、还会被抗锯齿和笔画覆盖率干扰。
{
  const hexOf = (value) => {
    const matched = /^#([0-9a-f]{6})$/i.exec(String(value).trim());
    if (!matched) return null;
    const n = Number.parseInt(matched[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const channel = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const ratioOf = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  for (const id of DECO_THEMES) {
    const block = new RegExp(`\\[data-theme="${id}"\\],\\.dtr-pill\\[data-theme="${id}"\\]\\{([^}]+)\\}`).exec(radar.CSS);
    const body = block ? block[1] : "";
    const token = (name) => {
      const found = new RegExp(`--dsw-alias-${name}:([^;]+);`).exec(body);
      return found ? found[1].trim() : "";
    };
    const bgs = [hexOf(token("bg-layer-1")), hexOf(token("bg-layer-2"))].filter(Boolean);
    let worst = { ratio: Infinity, name: "" };
    for (const name of ["label-primary", "label-secondary", "label-tertiary"]) {
      const ink = hexOf(token(name));
      for (const bg of bgs) {
        const ratio = ink ? ratioOf(ink, bg) : 0;
        if (ratio < worst.ratio) worst = { ratio, name };
      }
    }
    check(bgs.length === 2 && worst.ratio >= 4.5, `主题: ${id} 三档墨色在两种底色上都过 4.5（最低 ${worst.name} ${worst.ratio.toFixed(2)}:1）`);
  }
}
// 卡头小标跟着主题走
check(/const APP_ICONS = \{/.test(clientSource), "图标: 注入了主题图标表");
check((clientSource.match(/": "data:image\/png;base64,/g) ?? []).length >= 6, "图标: 六套主题各一张（同一套几何，只换配色）");
check(/APP_ICONS\[view\.theme\?\.preset\]/.test(clientSource), "图标: 卡头按当前主题挑图标，挑不到回退主图标");

// ── Token 账本：今天 / 本周 / 本月 ───────────────────────────────────────────
{
  const { dateKey, startOfWeek, startOfMonth, emptyLedger, normalizeLedger, recordUsage, ledgerTotals, usageSamples, ledgerSignature } = radar;

  check(dateKey(new Date(2026, 10, 2, 23, 59)) === "2026-11-02", "账本: 日期键按本地时区（不是 UTC）");
  check(dateKey(startOfWeek(new Date(2026, 10, 2))) === "2026-11-02", "账本: 周一那天，本周就从它起");
  check(dateKey(startOfWeek(new Date(2026, 10, 8))) === "2026-11-02", "账本: 周日归到上一个周一（中文口径，不是往前 0 天）");
  check(dateKey(startOfMonth(new Date(2026, 10, 15))) === "2026-11-01", "账本: 本月从 1 号起");

  // 首见只当基线：装插件那天不该把会话历史一口气倒进今天。
  const first = recordUsage(emptyLedger(), [{ id: "a", tokens: 5_000_000 }], new Date(2026, 10, 2, 10).getTime());
  check(first.days["2026-11-02"] === undefined, "账本: 第一次见到会话只记基线，不倒算历史");
  check(first.seen.a === 5_000_000, "账本: 基线记下来了");

  // 之后涨多少记多少。
  const grown = recordUsage({ ...first, seen: { ...first.seen } }, [{ id: "a", tokens: 5_400_000 }], new Date(2026, 10, 2, 11).getTime());
  check(grown.days["2026-11-02"] === 400_000, "账本: 增量记到今天");

  // 变小（会话被压缩）不倒扣。
  const shrunk = recordUsage(grown, [{ id: "a", tokens: 300_000 }], new Date(2026, 10, 2, 12).getTime());
  check(shrunk.days["2026-11-02"] === 400_000, "账本: 计数变小不倒扣（宁可少记，不出负数）");
  check(shrunk.seen.a === 300_000, "账本: 基线跟着降下来");

  // 三档口径：今天 / 本周 / 本月各算一次。
  const ledger = normalizeLedger({
    since: "2026-10-01",
    seen: {},
    days: {
      "2026-09-30": 999_999, // 上个月、也不是本周 → 哪个都不该算
      "2026-10-31": 2_000_000, // 本月但不在本周
      "2026-11-01": 3_000_000, // 本周（周日）本月
      "2026-11-02": 4_000_000, // 今天、本周、本月
    },
  });
  // 今天就是周一：上周日（11-01）不算本周，但算本月。
  const totals = ledgerTotals(ledger, new Date(2026, 10, 2, 15).getTime());
  check(totals.today === 4_000_000, "账本: 今天只算今天");
  check(totals.week === 4_000_000, "账本: 周一当天，本周只有今天（上周日不算）");
  check(totals.month === 7_000_000, "账本: 本月 = 11-01 + 11-02（10-31 与 9-30 不算）");
  check(totals.last7.length === 7 && totals.last7[6].key === "2026-11-02", "账本: 最近 7 天最后一格是今天");
  check(totals.last7[6].value === 4_000_000 && totals.last7[0].value === 0, "账本: 没量那天是 0，不是缺格");
  check(totals.days === 4 && totals.since === "2026-10-01", "账本: 记了多少天、从哪天开始记");

  // 周日看：本周要从那个周一算起，11-02 在里头、11-01 不在。
  const sunday = ledgerTotals(ledger, new Date(2026, 10, 8, 9).getTime());
  check(sunday.week === 4_000_000, "账本: 周日看到的「本周」是 11-02 起那 7 天，不含 11-01");
  check(sunday.month === 7_000_000, "账本: 周日看到的「本月」仍是整个 11 月");
  check(sunday.today === 0, "账本: 周日当天没量就是 0");

  // 脏数据不许把整份账弄坏。
  const dirty = normalizeLedger({ days: { "2026-11-02": 5, "坏键": 9, "2026-11-03": -1 }, seen: { a: 1, b: "x" }, since: 7 });
  check(Object.keys(dirty.days).length === 1 && dirty.days["2026-11-02"] === 5, "账本: 脏日期键与非正数一律丢掉");
  check(dirty.since === null, "账本: since 不是日期就当没有");

  // 采样：行 + 子代理各算各的（跟 Token 合计同一口径）。
  const fakeModel = {
    rows: [
      { id: "s1", usage: { cumulativeUsage: { totalTokens: 1_000 } }, children: [{ id: "k1", usage: { cumulativeUsage: { totalTokens: 200 } } }] },
      { id: "s2", usage: { usage: { totalTokens: 300 } }, children: [] },
      { id: "s3", usage: null, children: [] },
    ],
  };
  const samples = usageSamples(fakeModel);
  check(samples.length === 3, "账本: 采样含行与子代理（各算各的，不重不漏）");
  check(samples.find((item) => item.id === "k1")?.tokens === 200, "账本: 子代理用自己的累计");
  check(ledgerSignature(fakeModel).includes("s1:1000") && ledgerSignature(fakeModel).includes("k1:200"), "账本: 签名能感知变化（省掉每次轮询写盘）");
}

// ── 应用图标 ─────────────────────────────────────────────────────────────────
// 图标是内联的 data URI（不注册路由，见 scripts/build-icon.mjs 里的说明）。
// 这里钉两件事：它确实是张 PNG，而且没有被误替换成空串 —— 空串会让侧栏退回 `◉`，
// 那是"能跑但没做图标"的样子，不该悄悄发生。
const icon = radar.APP_ICON ?? "";
check(icon.startsWith("data:image/png;base64,"), "图标: 是内联的 PNG data URI", icon.slice(0, 24));
check(icon.length > 800 && icon.length < 40_000, "图标: 体积合理（几百字节是空图，几十 KB 是忘了压）", icon.length);
const iconBytes = Buffer.from(icon.split(",")[1] ?? "", "base64");
check(iconBytes.length > 600 && iconBytes[1] === 0x50 && iconBytes[2] === 0x4e && iconBytes[3] === 0x47, "图标: base64 解出来是 PNG 魔数", iconBytes.length);
check(/\.dtr-appicon\{/.test(css), "样式: 应用图标有独立样式（圆角，不跟着文字色变）");

// ── 汇总 ─────────────────────────────────────────────────────────────────────
console.log(`\n${passed} 通过 / ${failures} 失败`);
if (failures > 0) process.exitCode = 1;
