/**
 * 工作小管家的装配冒烟：不打开浏览器，把 client.js 真跑一遍。
 *
 * 假的在：`window.__ModuleLoader__`、`react`（一个够用的 hook 运行时）、DOM 的
 * `document.createElement / head.appendChild / querySelector`、`localStorage`、
 * `Notification`、`setInterval`。真的在：client.js 的 apply 装配、注册项、组件函数本体、
 * 分段渲染、拖拽、点击跳转、完成提醒、落盘。
 *
 * 跑法：node verify/apply-smoke.mjs
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
let passed = 0;

/**
 * 一条断言。
 * @param {boolean} ok 条件。
 * @param {string} label 说明。
 * @param {unknown} [detail] 现场。
 */
function check(ok, label, detail) {
  if (ok) {
    passed += 1;
    return;
  }
  failures += 1;
  console.error(`✗ ${label}`);
  if (detail !== undefined) console.error("  ", typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
}

// ── 假环境 ───────────────────────────────────────────────────────────────────
const store = new Map();
const styleTags = [];
const listeners = new Map();
const timers = [];
let notificationPermission = "granted";
const notifications = [];

globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

class FakeNotification {
  static permission = "granted";
  static requestPermission(callback) {
    FakeNotification.permission = "granted";
    callback?.("granted");
    return Promise.resolve("granted");
  }
  constructor(title, options) {
    notifications.push({ title, options });
    this.title = title;
    this.options = options;
  }
  close() {}
}
Object.defineProperty(FakeNotification, "permission", {
  get: () => notificationPermission,
  set: (value) => { notificationPermission = value; },
});

globalThis.Notification = FakeNotification;

globalThis.document = {
  hidden: false,
  addEventListener: (name, fn) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
  },
  removeEventListener: (name, fn) => { listeners.get(name)?.delete(fn); },
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => {
    const element = { tagName: tag, dataset: {}, style: {}, textContent: "", appendChild() {} };
    if (tag === "style") styleTags.push(element);
    return element;
  },
  head: { appendChild() {} },
  body: null,
};

globalThis.window = {
  __ModuleLoader__: { load: (definition) => { globalThis.__loaded = definition; } },
  innerWidth: 1440,
  innerHeight: 900,
  console: { info() {}, warn() {} },
  addEventListener: (name, fn) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
  },
  removeEventListener: (name, fn) => { listeners.get(name)?.delete(fn); },
  setInterval: (fn, period) => {
    timers.push({ fn, period, cleared: false });
    return timers.length;
  },
  clearInterval: (id) => { const timer = timers[id - 1]; if (timer) timer.cleared = true; },
  setTimeout: (fn) => { timers.push({ fn, period: "timeout", cleared: false }); return timers.length; },
  focus() {},
  requestAnimationFrame: (fn) => { fn(); return 1; },
  cancelAnimationFrame() {},
};

// ── 够用的 hook 运行时 ───────────────────────────────────────────────────────
const h = (type, props, ...children) => {
  const merged = { ...(props ?? {}) };
  if (children.length === 1) merged.children = children[0];
  else if (children.length > 1) merged.children = children;
  return { type, props: merged };
};

function sameDeps(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
}

function createRuntime() {
  const cells = [];
  const pendingEffects = [];
  const cleanups = [];
  let cursor = 0;
  let dirty = false;

  const take = (init) => {
    const index = cursor++;
    if (!cells[index]) cells[index] = init();
    return cells[index];
  };

  const React = {
    createElement: h,
    memo: (component) => component,
    useRef(initial) {
      return take(() => ({ current: initial }));
    },
    useState(initial) {
      const slot = take(() => ({ value: typeof initial === "function" ? initial() : initial }));
      const set = (next) => {
        const value = typeof next === "function" ? next(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        dirty = true;
      };
      return [slot.value, set];
    },
    useMemo(factory, deps) {
      const slot = take(() => ({ deps: undefined, value: undefined, ready: false }));
      if (!slot.ready || !sameDeps(slot.deps, deps)) {
        slot.deps = deps;
        slot.ready = true;
        slot.value = factory();
      }
      return slot.value;
    },
    useCallback(fn, deps) {
      const slot = take(() => ({ deps: undefined, value: undefined, ready: false }));
      if (!slot.ready || !sameDeps(slot.deps, deps)) {
        slot.deps = deps;
        slot.ready = true;
        slot.value = fn;
      }
      return slot.value;
    },
    useEffect(fn, deps) {
      const slot = take(() => ({ deps: undefined, ready: false }));
      if (!slot.ready || !sameDeps(slot.deps, deps)) {
        slot.deps = deps;
        slot.ready = true;
        pendingEffects.push({ slot, fn });
      }
    },
  };

  const flush = () => {
    for (const { slot, fn } of pendingEffects.splice(0)) {
      if (typeof slot.cleanup === "function") {
        try { slot.cleanup(); } catch (error) { console.error("  清理函数抛错:", error); }
        slot.cleanup = undefined;
      }
      const cleanup = fn();
      if (typeof cleanup === "function") slot.cleanup = cleanup;
    }
  };

  const render = (component, props) => {
    for (let round = 0; round < 30; round += 1) {
      cursor = 0;
      dirty = false;
      const tree = component(props);
      flush();
      if (!dirty) return tree;
    }
    throw new Error("渲染没有收敛：疑似状态更新死循环");
  };

  const unmount = () => {
    for (const cell of cells) {
      if (cell && typeof cell.cleanup === "function") {
        try { cell.cleanup(); } catch (error) { console.error("  卸载清理抛错:", error); }
      }
    }
    return cleanups.length;
  };

  /**
   * 清空 hook 单元，换一个组件重新开始。
   *
   * 为什么需要：同一套 cell 数组按「第几个 hook」取位置，给两个不同组件复用会错位
   * （小窗的第 2 个 hook 是 useState(view)，面板的第 2 个是 useState(now)，会拿到同一个槽）。
   * @returns {void}
   */
  const reset = () => {
    cells.length = 0;
    pendingEffects.length = 0;
    cursor = 0;
    dirty = false;
  };

  return { React, render, unmount, reset };
}

// ── 把元素树摊成可断言的普通对象 ─────────────────────────────────────────────
function hydrate(node) {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (Array.isArray(node)) {
    const out = [];
    for (const child of node) {
      const value = hydrate(child);
      if (Array.isArray(value)) out.push(...value);
      else if (value !== null) out.push(value);
    }
    return out;
  }
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node.type === "function") return hydrate(node.type(node.props ?? {}));
  const children = hydrate(node.props?.children);
  return {
    tag: node.type,
    props: node.props ?? {},
    children: children === null ? [] : Array.isArray(children) ? children : [children],
  };
}

function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  return node.children ? node.children.map(textOf).join(" ") : "";
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node === "string") return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, out);
  return out;
}

const withClass = (node, name) =>
  findAll(node, (element) => typeof element.props?.className === "string" && element.props.className.split(/\s+/).includes(name));

// ── 装载 client.js ───────────────────────────────────────────────────────────
const ReactStub = createRuntime();
await import(pathToFileURL(join(here, "..", "client.js")).href);
const radar = globalThis.__loaded.factory((name) => {
  if (name === "react") return ReactStub.React;
  throw new Error("unexpected require: " + name);
});

check(radar.NODE_ID === "task-radar" && radar.SLOT === "shell.overlay", "模块导出：注册 id 与挂载点");

// ── 宿主侧：槽位服务与三个标准 props ─────────────────────────────────────────
const opened = [];
const workspaceService = { openSession: (id) => opened.push(id) };
const captured = { slot: null, options: null, component: null, registered: 0, all: [] };
const warnings = [];

const ctx = {
  logger: { warn: (...args) => warnings.push(args) },
  get: (name) => (name === "uiWorkspace" ? workspaceService : undefined),
  slots: {
    inject: (name, callback) => { captured.slot = name; return callback(); },
    register: (options, component) => {
      captured.options = options;
      captured.component = component;
      captured.all.push({ options, component });
      captured.registered += 1;
      return () => { captured.registered -= 1; };
    },
  },
};

radar.apply(ctx);

check(captured.slot === "shell.overlay", "apply: 等的是 shell.overlay 这个席位");
// 加面板之前这里只有 overlay 一条。现在一共三条：主区面板、侧栏行、悬浮小窗。
// 断言不能只看总数，要钉住「overlay 仍然只有一条」—— 那才是「不替换既有条目」的意思。
check(captured.all.filter((row) => row.options.name === "shell.overlay").length === 1, "apply: overlay 只注册一条（加在既有条目旁边，不替换）");
check(captured.all.filter((row) => row.options.name === "main").length === 1, "apply: 主区面板注册一条");
check(captured.all.filter((row) => row.options.name === "sidebar.panellist").length === 1, "apply: 侧栏行注册一条");
const panelRow = captured.all.find((row) => row.options.name === "sidebar.panellist");
const mainRow = captured.all.find((row) => row.options.name === "main");
check(panelRow.options.id === "task-radar" && panelRow.options.id === radar.PANEL_KEY, "侧栏行 id 与自研名单一致");
check(panelRow.options.order === 30 && panelRow.options.label() === "工作小管家", "侧栏行 order / 文案（与小窗卡头同名）");
check(mainRow.options.key === "task-radar", "主区面板与侧栏行共用同一个键");
check(captured.options.name === "shell.overlay" && captured.options.id === "task-radar", "apply: 注册项 name/id 正确", captured.options);
check(typeof captured.options.order === "number", "apply: 带 order，和别的 overlay 条目一起排序", captured.options);
check(styleTags.length === 1 && styleTags[0].dataset.pluginCss === "dsh-plugin-task-radar/radar.css", "apply: 样式表注入一次（重复加载去重靠 data-plugin-css）");
check(styleTags[0].textContent.includes(".dtr-card") && styleTags[0].textContent.includes(".dtr-pill"), "apply: 样式表里确实画了卡片和胶囊");

// ── 造一份真实形状的宿主数据 ─────────────────────────────────────────────────
const now = Date.now();
const listState = {
  phase: "ready",
  ids: ["run", "wait", "done", "idle1", "blank", "sub", "arch"],
  byId: {
    run: { id: "run", displayTitle: "重写鉴权中间件", running: true, updatedAt: now - 300_000, cwd: "D:/work/skill" },
    wait: { id: "wait", displayTitle: "迁移数据库", running: false, updatedAt: now - 120_000 },
    done: { id: "done", displayTitle: "生成周报", running: false, updatedAt: now - 60_000 },
    idle1: { id: "idle1", displayTitle: "上周的排障", running: false, updatedAt: now - 86_400_000 },
    blank: { id: "blank", displayTitle: "新会话", running: false, blank: true, updatedAt: now },
    sub: { id: "sub", displayTitle: "子代理：翻文档", running: true, updatedAt: now - 10_000, origin: "subagent", parentId: "run" },
    arch: { id: "arch", displayTitle: "归档掉的旧活", running: false, updatedAt: now - 900_000 },
  },
  projectionsBySession: {
    run: { values: {
      todos: [{ content: "拆接口", status: "completed" }, { content: "补测试", status: "in_progress" }, { content: "回归", status: "pending" }, { content: "上线", status: "pending" }],
      modelSelection: { lastUsed: { provider: "deepseek", model: "v4.1-flash" }, next: null },
      // 用量：这里用宿主**真实**的 `tokenUsage` 投影形状（四桶不相交，缓存在输入之外）。
      // 总数 1.2M = 未缓存输入 700K + 缓存读 200K + 输出 300K —— 缓存读必须算进去，
      // 漏了它这个数会变成 1.0M，正好能被下面的断言抓住。
      tokenUsage: { uncachedInputTokens: 700_000, outputTokens: 300_000, cacheReadTokens: 200_000, cacheWriteTokens: 0 },
    } },
    sub: { values: {
      modelSelection: { lastUsed: null, next: { provider: "deepseek", model: "v4.1-pro" } },
      subagentTiming: { settledMs: 0, active: { since: now - 45_000, through: now } },
      tokenUsage: { uncachedInputTokens: 200_000, outputTokens: 200_000, cacheReadTokens: 50_000, cacheWriteTokens: 0 },
    } },
    // 老宿主/只有单次用量的那一套：退回单次那一格（15.5K）
    wait: { values: {
      usage: { inputTokens: 12_000, outputTokens: 3_500 },
    } },
  },
};
const statusState = new Map([
  ["run", { running: true, pendingInteraction: undefined, completionUnread: false }],
  ["wait", { running: false, pendingInteraction: { kind: "approval", key: "k1", sessionId: "wait" }, completionUnread: false }],
  ["done", { running: false, pendingInteraction: undefined, completionUnread: true }],
  ["sub", { running: true, pendingInteraction: undefined, completionUnread: false }],
]);
/** 宿主快照是不可变的：改状态就换一个新 Map（原地 mutate 会让 useMemo 看不见变化，真宿主也不会这么干）。 */
let statuses = statusState;
const workspaceState = {
  items: [
    { workspaceId: "w1", title: "skill", path: "D:/work/skill", sessionIds: ["run", "wait", "sub", "idle1"] },
    { workspaceId: "w2", title: "内容生产", path: "D:/work/content", sessionIds: ["done"] },
  ],
  archivedSessionIds: ["arch"],
};
const props = {
  useSessions: (selector) => selector(listState),
  useSessionStatus: (selector) => selector(statuses),
  useWorkspaces: (selector) => selector(workspaceState),
};

/**
 * 换掉一份会话状态（不可变更新，模拟宿主的推送）。
 * @param {string} id 会话 id。
 * @param {object | null} value 新状态，null 表示删掉。
 */
function setStatus(id, value) {
  const next = new Map(statuses);
  if (value === null) next.delete(id);
  else next.set(id, value);
  statuses = next;
}

// ── 首屏 ─────────────────────────────────────────────────────────────────────
let tree = hydrate(ReactStub.render(captured.component, props));
let text = textOf(tree);

check(withClass(tree, "dtr-card").length === 1, "首屏: 渲染出卡片");
check(text.includes("工作小管家"), "首屏: 有标题");
check(text.includes("待批准"), "首屏: 等你处理的行带待批准短标签");
check(withClass(tree, "dtr-grouphead").length >= 2, "首屏: 按工作区归堆，工作区标题可见", withClass(tree, "dtr-grouphead").length);
check(!text.includes("Agent Tree") && !text.includes("智力研发团队"), "首屏: 不伪造 Agent Tree 工作流");
check(text.includes("skill") && text.includes("内容生产"), "首屏: workspace 作为任务分组上下文");
check(text.includes("重写鉴权中间件") && text.includes("生成周报"), "首屏: 会话标题来自宿主 displayTitle");
check(text.includes("├─") || text.includes("└─"), "首屏: 会话行带树线", text.slice(0, 200));
check(text.includes("1/4 步") && text.includes("补测试"), "首屏: todo 进度与正在做的那一步");
check(!text.includes("新会话") && !text.includes("归档掉的旧活"), "首屏: 空会话与归档会话都不列");
check(text.includes("子代理：翻文档"), "首屏: 子代理默认摊开，直接挂在父行下面（树就该摊开）");
check(text.includes("↳1"), "首屏: 父行上仍然带子代理计数");
check(text.includes("v4.1-flash"), "首屏: 跑着的行带模型标签", text);
check(text.includes("5 个会话") || /\d+ 个会话/.test(text), "首屏: 尾巴上有会话总量");

// ── 每个任务的 Token ────────────────────────────────────────────────────────
// 行上只显示一个数（累计优先）：run 累计 1.2M、sub 累计 450K、wait 只有单次 15.5K。
const usageChips = withClass(tree, "dtr-usage");
check(usageChips.length === 3, "Token: 有量的三行各挂一个（没量的行不出现空 chip）", usageChips.map((chip) => textOf(chip)));
check(text.includes("1.2M tok"), "Token: 跑着的会话显示累计 1.2M，而不是本次的 3.5K", text.slice(0, 400));
check(text.includes("450K tok"), "Token: 子代理有自己那一格（子代理也在烧 token）");
check(text.includes("16K tok"), "Token: 只有单次用量时退回单次那一格");
const runChip = usageChips.find((chip) => textOf(chip).includes("1.2M"));
check(String(runChip?.props?.title ?? "").includes("未缓存输入 700K"), "Token: 悬浮里区分「未缓存输入」与缓存（宿主四桶不相交）", runChip?.props?.title);
check(String(runChip?.props?.title ?? "").includes("缓存读 200K"), "Token: 缓存读单列，并且已经算进了那个 1.2M", runChip?.props?.title);
check(!text.includes("生成周报") || !withClass(tree, "dtr-row").find((row) => textOf(row).includes("生成周报") && withClass(row, "dtr-usage").length > 0), "Token: 没用量数据的行不编数字");
check(text.includes("∑ " + radar.formatTokens(1_665_500) + " tok"), "Token: 尾巴上是各会话累计之和（含子代理）", text.slice(-200));

// ── 子代理就地收起（点 ↳1，不跳会话）────────────────────────────────────────
const expander = findAll(tree, (element) => typeof element.props?.className === "string" && element.props.className.includes("dtr-kidsbtn"))[0];
check(Boolean(expander) && expander.props["aria-expanded"] === true, "子代理: 折叠开关默认是打开态");
let jumped = opened.length;
expander.props.onClick({ stopPropagation() {} });
tree = hydrate(ReactStub.render(captured.component, props));
text = textOf(tree);
check(!text.includes("子代理：翻文档"), "子代理: 点 ↳1 就地收起明细");
check(opened.length === jumped, "子代理: 收起不触发跳转");
findAll(tree, (element) => typeof element.props?.className === "string" && element.props.className.includes("dtr-kidsbtn"))[0].props.onClick({ stopPropagation() {} });
tree = hydrate(ReactStub.render(captured.component, props));
text = textOf(tree);
check(text.includes("子代理：翻文档"), "子代理: 再点一下摊开回来");
check(text.includes("v4.1-pro"), "子代理: 明细行各自带模型");
check(withClass(tree, "dtr-kid").length === 1, "子代理: 明细挂在父行下面（dtr-kid）");
check(findAll(tree, (element) => element.props?.className === "dtr-guide").length >= 2, "子代理: 明细行也带树线（dtr-guide）");

// ── 待办清单就地展开（点进度条）──────────────────────────────────────────────
const meter = findAll(tree, (element) => typeof element.props?.className === "string" && element.props.className.includes("dtr-meterbtn"))[0];
check(Boolean(meter) && meter.props["aria-expanded"] === true, "待办: 进行中任务的进度条默认展开");
check(withClass(tree, "dtr-plan").length >= 1, "待办: 首屏直接铺出进行中任务的清单");
let jumpedPlan = opened.length;
meter.props.onClick({ stopPropagation() {} });
tree = hydrate(ReactStub.render(captured.component, props));
check(withClass(tree, "dtr-plan").length === 0, "待办: 点进度条可以收起清单");
check(opened.length === jumpedPlan, "待办: 收起清单不触发跳转");
findAll(tree, (element) => typeof element.props?.className === "string" && element.props.className.includes("dtr-meterbtn"))[0].props.onClick({ stopPropagation() {} });
tree = hydrate(ReactStub.render(captured.component, props));
check(withClass(tree, "dtr-planrow").length === 4, "待办: 再点进度条铺出全部 4 步", withClass(tree, "dtr-planrow").length);
check(textOf(tree).includes("拆接口") && textOf(tree).includes("回归"), "待办: 清单里连做完的和没做的都能看见");
const statusesSeen = withClass(tree, "dtr-planrow").map((row) => row.props["data-status"]);
check(statusesSeen.join(",") === "completed,in_progress,pending,pending", "待办: 每条带自己的状态", statusesSeen);
check(/✓\s*拆接口/.test(textOf(withClass(tree, "dtr-plan")[0])) && /●\s*补测试/.test(textOf(withClass(tree, "dtr-plan")[0])), "待办: 做完的打勾、正在做的打点", textOf(withClass(tree, "dtr-plan")[0]));
check(text.includes("空闲 1"), "首屏: 空闲收成一行可展开");

const rows = withClass(tree, "dtr-row");
check(rows.length >= 3, "首屏: 根会话都是同一棵树里的兄弟行", rows.map((row) => row.props["data-kind"]));

// ── 点一行 = 跳进那个会话 ────────────────────────────────────────────────────
const doneRow = rows.find((row) => textOf(row).includes("生成周报"));
check(doneRow !== undefined, "定位: 找到「刚完成」那一行");
doneRow.props.onClick();
check(opened.length === 1 && opened[0] === "done", "点击行: 调了 uiWorkspace.openSession，带的是那个会话 id", opened);
// 真打开会话后宿主会自己清掉 completionUnread；这里手动模拟那一步。
setStatus("done", { running: false, pendingInteraction: undefined, completionUnread: false });
tree = hydrate(ReactStub.render(captured.component, props));
text = textOf(tree);
check(!text.includes("生成周报") || text.includes("空闲"), "点击行: 打开后完成行不再作为活动项");
check(text.includes("空闲"), "点击行: 那一行回到空闲区", text.slice(0, 160));

// ── 拖拽 ─────────────────────────────────────────────────────────────────────
/**
 * 按 aria-label 取按钮。
 *
 * 以前这里按下标取（`buttons[0]` 是设置、`[1]` 是收起），标题栏一加按钮就全错位 ——
 * 而且错位之后测试还是"绿"的，只是测到了别的按钮。按名字取才扛得住改动。
 */
const buttonByLabel = (node, label) => findAll(node, (element) => element.props?.["aria-label"] === label)[0];

const head = withClass(tree, "dtr-head")[0];const fakeEvent = (x, y) => ({
  clientX: x, clientY: y, button: 0, pointerId: 1,
  target: null,
  currentTarget: { setPointerCapture() {}, releasePointerCapture() {} },
  preventDefault() {},
});
head.props.onPointerDown(fakeEvent(1200, 700));
head.props.onPointerMove(fakeEvent(400, 300));
head.props.onPointerUp(fakeEvent(400, 300));
tree = hydrate(ReactStub.render(captured.component, props));
const rootStyle = tree.props.style ?? {};
check(typeof rootStyle.left === "number" && typeof rootStyle.top === "number", "拖拽: 位置变成 left/top 绝对值", rootStyle);
check(rootStyle.left >= 16 && rootStyle.top >= 16, "拖拽: 夹在视口内", rootStyle);

const saved = JSON.parse(store.get(radar.STORAGE_KEY) ?? "{}");
check(saved.view?.pos?.x === rootStyle.left && saved.view?.pos?.y === rootStyle.top, "拖拽: 位置落盘", saved.view?.pos);

// ── 改大小：拖右下角那颗把手 ────────────────────────────────────────────────
// 卡片本身没有真实尺寸（假 DOM），把手按 CARD_W 兜底 —— 这里只验"拖了会变、会落盘、能复位"。
const grip = withClass(tree, "dtr-grip")[0];
check(Boolean(grip), "改大小: 卡片右下角有把手（不然用户根本找不到入口）");
check(grip.props.role === "separator" && String(grip.props["aria-label"]).includes("大小"), "改大小: 把手对读屏有名字");
grip.props.onPointerDown(fakeEvent(900, 700));
grip.props.onPointerMove(fakeEvent(1_020, 820));
grip.props.onPointerUp(fakeEvent(1_020, 820));
tree = hydrate(ReactStub.render(captured.component, props));
const sizedCard = withClass(tree, "dtr-card")[0];
check(sizedCard.props.style.width === "300px" || /^\d+px$/.test(String(sizedCard.props.style.width)), "改大小: 拖完宽高变成了具体像素", sizedCard.props.style.width);
check(sizedCard.props.style.maxHeight === "none", "改大小: 固定高度时要撤掉 max-height（否则高度还能被内容压回去）");
const sizedSaved = JSON.parse(store.get(radar.STORAGE_KEY));
check(Number.isFinite(sizedSaved.view.size.w) && Number.isFinite(sizedSaved.view.size.h), "改大小: 宽高落盘", sizedSaved.view.size);
// 双击把手复位
withClass(tree, "dtr-grip")[0].props.onDoubleClick(fakeEvent(0, 0));
tree = hydrate(ReactStub.render(captured.component, props));
check(JSON.parse(store.get(radar.STORAGE_KEY)).view.size === null, "改大小: 双击把手恢复默认");
check(withClass(tree, "dtr-card")[0].props.style.width === undefined, "改大小: 复位后回到 CSS 那套自适应");

// 设置页里得写清楚这个入口在哪 —— 用户当初就是「调不了」而是根本没找到。
buttonByLabel(tree, "工作小管家设置").props.onClick();
tree = hydrate(ReactStub.render(captured.component, props));
const settingsText = textOf(tree);
check(settingsText.includes("右下角"), "改大小: 设置页里写着把手在哪", settingsText.slice(0, 200));
const hasResetSize = findAll(tree, (element) => textOf(element) === "把框体大小恢复默认↺").length + findAll(tree, (element) => typeof element.props?.onClick === "function" && textOf(element).includes("把框体大小恢复默认")).length;
check(hasResetSize === 0, "改大小: 没调过就不留「恢复默认大小」的空按钮");
buttonByLabel(tree, "返回列表").props.onClick();
tree = hydrate(ReactStub.render(captured.component, props));
withClass(tree, "dtr-grip")[0].props.onPointerDown(fakeEvent(900, 700));
withClass(tree, "dtr-grip")[0].props.onPointerMove(fakeEvent(950, 760));
withClass(tree, "dtr-grip")[0].props.onPointerUp(fakeEvent(950, 760));
tree = hydrate(ReactStub.render(captured.component, props));
buttonByLabel(tree, "工作小管家设置").props.onClick();
tree = hydrate(ReactStub.render(captured.component, props));
check(findAll(tree, (element) => typeof element.props?.onClick === "function" && textOf(element).includes("把框体大小恢复默认")).length === 1, "改大小: 调过之后设置里出现「把框体大小恢复默认」");
buttonByLabel(tree, "返回列表").props.onClick();
tree = hydrate(ReactStub.render(captured.component, props));

// 拖完会短暂抑制"松手后的 click"，这里把那个 500ms 的定时器跑掉（真浏览器里等半秒即可）。
for (const timer of timers) {
  if (timer.period === "timeout" && timer.cleared === false) {
    timer.cleared = true;
    timer.fn();
  }
}

// ── 刷新（卡片）──────────────────────────────────────────────────────────────
// 刷新的真语义是「重读本插件自己的本地记录」：另一个标签页写进去的起跑时间，
// 不重读就永远用着打开页面那一刻的快照。这里就按这个语义测。
// 先渲染一次：组件会把"自己内存里的记忆"写回本地存储，
// 所以注入必须发生在这次渲染**之后**，否则立刻被覆盖掉（这个先后顺序本身就是真实情形）。
tree = hydrate(ReactStub.render(captured.component, props));
const refreshButton = buttonByLabel(tree, "刷新");
check(Boolean(refreshButton), "刷新: 卡片标题栏有刷新按钮");
const beforeRefresh = JSON.parse(store.get(radar.STORAGE_KEY) ?? "{}");
const fiveMinutesAgo = Date.now() - 5 * 60_000;
store.set(
  radar.STORAGE_KEY,
  JSON.stringify({
    ...beforeRefresh,
    memory: { ...beforeRefresh.memory, running: { ...beforeRefresh.memory?.running, run: fiveMinutesAgo } },
  }),
);
refreshButton?.props.onClick();
tree = hydrate(ReactStub.render(captured.component, props));
const refreshedRow = withClass(tree, "dtr-row").find((row) => textOf(row).includes("重写鉴权中间件"));
check(/5:0\d/.test(textOf(refreshedRow ?? { props: {} })), "刷新: 重读本地记录后，已跑时长按新记录重算", textOf(refreshedRow ?? { props: {} }));
check(String(buttonByLabel(tree, "刷新")?.props?.["data-spin"]) === "true", "刷新: 点了会有转圈反馈（不是静默的）");
check(timers.some((timer) => timer.period === "timeout"), "刷新: 转圈会自己停下（挂了定时器复位）");
for (const timer of timers) {
  if (timer.period === "timeout" && timer.cleared === false) {
    timer.cleared = true;
    timer.fn();
  }
}

// ── 收成胶囊 ─────────────────────────────────────────────────────────────────
tree = hydrate(ReactStub.render(captured.component, props));
let header = withClass(tree, "dtr-head")[0];
const buttons = header.children.filter((child) => typeof child?.props?.className === "string" && child.props.className.includes("dtr-btn"));
check(buttons.length === 3, "展开态: 标题栏有刷新 / 设置 / 收起三个按钮", buttons.map((button) => button.props["aria-label"]));
buttonByLabel(tree, "收成胶囊").props.onClick();
tree = hydrate(ReactStub.render(captured.component, props));
text = textOf(tree);
check(withClass(tree, "dtr-pill").length === 1 && withClass(tree, "dtr-card").length === 0, "收起: 变成胶囊");
check(text.includes("1") && !text.includes("工作小管家"), "收起: 胶囊只留计数", text);

// 胶囊点一下能展开
withClass(tree, "dtr-pill")[0].props.onClick();
tree = hydrate(ReactStub.render(captured.component, props));
check(withClass(tree, "dtr-card").length === 1, "胶囊: 点一下又展开");

// ── 设置面板 ─────────────────────────────────────────────────────────────────
header = withClass(tree, "dtr-head")[0];
buttonByLabel(tree, "工作小管家设置").props.onClick();
tree = hydrate(ReactStub.render(captured.component, props));
text = textOf(tree);
check(text.includes("显示空闲会话") && text.includes("完成时弹系统通知") && !text.includes("子代理单独成行"), "设置: 两个开关都在（子代理改成逐行展开，不再占一个全局开关）");
// 开关按"文字"取：这个面板的开关会继续加（空闲 / 通知 / 今天别再弹），按下标取迟早错位。
const switchByLabel = (node, label) => findAll(node, (element) => element.props?.role === "switch" && textOf(element).includes(label))[0];
check(Boolean(switchByLabel(tree, "显示空闲会话")) && Boolean(switchByLabel(tree, "完成时弹系统通知")), "设置: 两个老开关都在");
check(switchByLabel(tree, "完成时弹系统通知").props["aria-checked"] === true, "设置: 开关状态取自本地设置");
switchByLabel(tree, "完成时弹系统通知").props.onClick(); // 关掉系统通知
tree = hydrate(ReactStub.render(captured.component, props));
check(switchByLabel(tree, "完成时弹系统通知").props["aria-checked"] === false, "设置: 关掉通知后状态落下来");
check(JSON.parse(store.get(radar.STORAGE_KEY)).view.settings.notify === false, "设置: 通知开关落盘");
// 再打开，后面要测通知
switchByLabel(tree, "完成时弹系统通知").props.onClick();
tree = hydrate(ReactStub.render(captured.component, props));

// ── 边框：用户自己调粗细 / 颜色 ──────────────────────────────────────────────
const borderSlider = findAll(tree, (element) => element.props?.["aria-label"] === "边框粗细")[0];
check(Boolean(borderSlider), "边框: 设置里有粗细滑杆");
check(borderSlider.props.min === 0 && borderSlider.props.max === 3, "边框: 滑杆范围 0~3px（0 就是不要边框）", [borderSlider.props.min, borderSlider.props.max]);
check(borderSlider.props.value === 1, "边框: 没设过时滑杆停在主题那一档（1px）", borderSlider.props.value);
borderSlider.props.onChange({ target: { value: "3" } });
tree = hydrate(ReactStub.render(captured.component, props));
check(JSON.parse(store.get(radar.STORAGE_KEY)).view.theme.border.width === 3, "边框: 拖到 3px 会落盘");

const colorInput = findAll(tree, (element) => element.props?.["aria-label"] === "边框颜色")[0];
check(Boolean(colorInput) && colorInput.props.type === "color", "边框: 有原生取色器（能取屏幕任意一点，比自己画格子有用）");
colorInput.props.onChange({ target: { value: "#8a5a12" } });
tree = hydrate(ReactStub.render(captured.component, props));
check(JSON.parse(store.get(radar.STORAGE_KEY)).view.theme.border.color === "#8a5a12", "边框: 颜色落盘");

const borderRootStyle = tree.props.style ?? {};
check(borderRootStyle["--dtr-border-w"] === "3px", "边框: 粗细变成根节点上的 --dtr-border-w（卡片和胶囊都吃这个变量）", borderRootStyle);
check(borderRootStyle["--dtr-border-color"] === "#8a5a12", "边框: 颜色变成 --dtr-border-color", borderRootStyle);
// ── 让它安静：静音 / 我认这活做完了 / 今天别再弹 ──────────────────────────────
// 三颗钉子都在设置里；每行 hover 出的两颗在列表里（静音、收工）。
const quietSwitch = switchByLabel(tree, "今天别再弹提醒");
check(Boolean(quietSwitch), "安静: 设置里有「今天别再弹提醒」");
check(quietSwitch.props["aria-checked"] === false, "安静: 默认不静音");
quietSwitch.props.onClick();
tree = hydrate(ReactStub.render(captured.component, props));
const quietSaved = JSON.parse(store.get(radar.STORAGE_KEY)).memory;
check(Number.isFinite(quietSaved.quietUntil) && quietSaved.quietUntil > Date.now(), "安静: 打开后落盘到「明天 0 点」", quietSaved.quietUntil);
check(textOf(tree).includes("到明天"), "安静: 设置页写着什么时候恢复", textOf(tree).slice(0, 200));
// 关掉，后面还要测通知
switchByLabel(tree, "今天别再弹提醒").props.onClick();
tree = hydrate(ReactStub.render(captured.component, props));
check(JSON.parse(store.get(radar.STORAGE_KEY)).memory.quietUntil === 0, "安静: 再点一下立刻恢复");

// 回到列表
buttonByLabel(tree, "返回列表").props.onClick();
tree = hydrate(ReactStub.render(captured.component, props));
check(withClass(tree, "dtr-row").length >= 2 && withClass(tree, "dtr-grouphead").length >= 1 && withClass(tree, "dtr-set").length === 0, "设置: 能切回树（分组标题回来了、设置面板退场）", withClass(tree, "dtr-row").length);

// ── 行上那两颗钉子：静音一小时 / 我认这活做完了 ───────────────────────────────
const actButtons = findAll(tree, (element) => String(element.props?.["aria-label"] ?? "").startsWith("静音 1 小时"));
check(actButtons.length >= 1, "钉子: 每行都有「静音 1 小时」（hover 才显示）");
const snoozeTarget = actButtons[0];
const snoozeRowEl = snoozeTarget.props;
snoozeRowEl.onClick({ stopPropagation() {} });
tree = hydrate(ReactStub.render(captured.component, props));
const snoozedIds = Object.keys(JSON.parse(store.get(radar.STORAGE_KEY)).memory.snoozed ?? {});
check(snoozedIds.length === 1, "钉子: 静音落盘（一条）", snoozedIds);
check(withClass(tree, "dtr-foot-snooze").length === 1, "钉子: 卡底出现「静音 1」，不是默默消失");
check(textOf(withClass(tree, "dtr-foot-snooze")[0]).includes("静音 1"), "钉子: 卡底写着静音了几条");
// 点一下卡底那颗，全部恢复
withClass(tree, "dtr-foot-snooze")[0].props.onClick({ stopPropagation() {} });
tree = hydrate(ReactStub.render(captured.component, props));
check(Object.keys(JSON.parse(store.get(radar.STORAGE_KEY)).memory.snoozed ?? {}).length === 0, "钉子: 点卡底那颗就恢复");
check(withClass(tree, "dtr-foot-snooze").length === 0, "钉子: 恢复后卡底那颗消失");

// 收工：行从主列表进「已收工」，不占四个状态格
// 「等你处理」的行不参与收工：有人要你批东西，比"我说过做完了"要紧。
const waitingItem = withClass(tree, "dtr-item").find((node) => textOf(node).includes("待批准"));
const waitingSettle = findAll(waitingItem, (element) => element.props?.["aria-label"] === "标记完成")[0];
check(waitingSettle === undefined, "钉子: 等你处理的行**不画**「标记完成」（按了不生效的按钮比没有更糟）");
check(findAll(waitingItem, (element) => element.props?.["aria-label"] === "静音 1 小时").length === 1, "钉子: 等审批的行仍然可以静音");

const normalItem = withClass(tree, "dtr-item").find((node) => !textOf(node).includes("待批准"));
const settleTarget = findAll(normalItem, (element) => element.props?.["aria-label"] === "标记完成")[0];
check(Boolean(settleTarget), "钉子: 非等待的行有「标记完成」");
settleTarget.props.onClick({ stopPropagation() {} });
tree = hydrate(ReactStub.render(captured.component, props));
const settledAcc = withClass(tree, "dtr-acc").find((node) => textOf(node).includes("已收工"));
check(Boolean(settledAcc) && textOf(settledAcc).includes("1"), "钉子: 列表底部出现「已收工 1」", textOf(settledAcc ?? { props: {} }));
settledAcc.props.onClick();
tree = hydrate(ReactStub.render(captured.component, props));
const settledItems = withClass(tree, "dtr-item").filter((node) => node.props?.["data-settled"] === "true");
check(settledItems.length === 1, "钉子: 收工的那行带 data-settled（视觉上有删除线）");
const restoreBtn = findAll(tree, (element) => element.props?.["aria-label"] === "恢复")[0];
check(Boolean(restoreBtn), "钉子: 收工的行上给的是「恢复」");
restoreBtn.props.onClick({ stopPropagation() {} });
tree = hydrate(ReactStub.render(captured.component, props));
check(Object.keys(JSON.parse(store.get(radar.STORAGE_KEY)).memory.settled ?? {}).length === 0, "钉子: 恢复后收工记录清掉");

// ── 分组折叠 ─────────────────────────────────────────────────────────────────
const rowsBefore = withClass(tree, "dtr-row").length;
check(withClass(tree, "dtr-grouphead")[0].props["data-open"] === "true", "分组: 默认展开");
withClass(tree, "dtr-grouphead")[0].props.onClick();
tree = hydrate(ReactStub.render(captured.component, props));
check(withClass(tree, "dtr-row").length < rowsBefore, "分组: 点标题收起整组", withClass(tree, "dtr-row").length);
withClass(tree, "dtr-grouphead")[0].props.onClick();
tree = hydrate(ReactStub.render(captured.component, props));
check(withClass(tree, "dtr-row").length === rowsBefore, "分组: 再点一下整组回来");

// ── 完成提醒 ─────────────────────────────────────────────────────────────────
notifications.length = 0;
document.hidden = true;
setStatus("run", { running: false, pendingInteraction: undefined, completionUnread: false });
tree = hydrate(ReactStub.render(captured.component, props));
check(notifications.length === 0, "通知: 父回合停了但子代理仍跑，不能误报完成");
const backgroundRow = withClass(tree, "dtr-row").find((row) => textOf(row).includes("重写鉴权中间件"));
check(backgroundRow !== undefined && !textOf(backgroundRow).includes("待办还剩"), "后台子代理: 父任务继续显示为运行中");
setStatus("sub", { running: false, pendingInteraction: undefined, completionUnread: false });
tree = hydrate(ReactStub.render(captured.component, props));
check(notifications.length === 1, "通知: 页面在后台时，跑完的会话弹一条系统通知", notifications.map((note) => note.title));
check(notifications[0]?.title.includes("重写鉴权中间件"), "通知: 标题带会话名", notifications[0]?.title);
check(String(notifications[0]?.options?.tag).startsWith("task-radar:"), "通知: 用 tag 去重，同一个会话不会叠一堆", notifications[0]?.options?.tag);

// 「停了」不等于「做完了」：这个会话的待办只勾了 1/4，刚完成那一行要直接点出来。
const stoppedRow = withClass(tree, "dtr-row").find((row) => textOf(row).includes("重写鉴权中间件"));
check(stoppedRow !== undefined && textOf(stoppedRow).includes("待办还剩 3/4"), "刚完成: 待办没勾完就在行上点出来", stoppedRow && textOf(stoppedRow));
check(!textOf(stoppedRow ?? { props: {} }).includes("点击查看"), "刚完成: 有待办时不再显示「点击查看」占位");

notifications.length = 0;
document.hidden = false;
setStatus("wait", { running: false, pendingInteraction: undefined, completionUnread: false });
tree = hydrate(ReactStub.render(captured.component, props));
check(notifications.length === 0, "通知: 人在页面上看着时，不拿系统弹窗打断");

// ── 主区面板：同一份数据，另一条入口 ────────────────────────────────────────
// 「更多」菜单里能看见本插件、点开有东西可看，靠的就是这个面板。
ReactStub.unmount();
ReactStub.reset();
const Panel = radar.makeRadarPanel(ctx);
const panelTree = hydrate(ReactStub.render(Panel, props));
const panelText = textOf(panelTree);

check(withClass(panelTree, "dtr-panel").length === 1, "面板: 渲染出面板根节点");
check(
  withClass(panelTree, "dtr-panel")[0].props["data-dsh-skin"] === "off",
  "面板: 标了 data-dsh-skin=\"off\"（不跟「主题与外观」换肤、也不透它的壁纸）"
);
check(panelText.includes("工作小管家"), "面板: 标题也叫工作小管家（别跟侧栏行对不上）");
check(panelText.includes("等你处理") && panelText.includes("正在跑") && panelText.includes("刚完成"), "面板: 三个状态分组都在");
// 2026-11-07 起主面板不再铺会话清单（右下角小窗已经在列，重复只会把页面撑高）。
// 会话标题出现在面板里反而是回归，这里钉反向断言；清单本身由小窗那组用例负责。
check(!panelText.includes("重写鉴权中间件"), "面板: 不再重复列会话（清单只在浮动小窗里）");
check(withClass(panelTree, "dtr-panel-row").length === 0, "面板: 一行任务都不渲染");
check(!panelText.includes("归档掉的旧活") && !panelText.includes("新会话"), "面板: 归档与空会话都不列");

// 总览带：先给结论（几个在跑 / 几个等你 / 几个刚完成 / 几个空闲），再给明细。
const overviewCells = withClass(panelTree, "dtr-overview-cell");
check(overviewCells.length === 4, "面板: 顶部有四个总览格（等你 / 在跑 / 刚完成 / 空闲）", overviewCells.length);
check(overviewCells.map((cell) => cell.props["data-k"]).join(",") === "waiting,running,done,idle", "面板: 总览格顺序固定", overviewCells.map((cell) => cell.props["data-k"]));
check(textOf(overviewCells[0]).includes("等你处理") && textOf(overviewCells[1]).includes("正在跑"), "面板: 总览格带人话标签");

// 刷新：面板只读，刷新＝重读本地记录 + 重置"现在"，不写盘。
const panelRefreshButton = withClass(panelTree, "dtr-panel-refresh")[0];
check(Boolean(panelRefreshButton), "面板: 顶部有刷新按钮");
const storeBeforePanelRefresh = store.get(radar.STORAGE_KEY);
panelRefreshButton.props.onClick();
const panelAfterRefresh = hydrate(ReactStub.render(Panel, props));
check(store.get(radar.STORAGE_KEY) === storeBeforePanelRefresh, "面板: 刷新不写盘（面板只读）");
check(withClass(panelAfterRefresh, "dtr-overview-cell").length === 4, "面板: 刷新后仍正常渲染");
check(String(withClass(panelAfterRefresh, "dtr-panel-refresh")[0].props["data-spin"]) === "true", "面板: 刷新有转圈反馈");
for (const timer of timers) {
  if (timer.period === "timeout" && timer.cleared === false) {
    timer.cleared = true;
    timer.fn();
  }
}

// ── 面板上的 Token：每个任务一格 + 一行合计 ─────────────────────────────────
// 用一份干净的宿主数据单独渲染：前面的用例已经把会话推到「刚完成」了，
// 那份状态里没有"等你/在跑"的行可测。数据刻意分三种——有累计、只有单次、完全没给。
const tokenStatuses = new Map([
  ["t1", { running: true, pendingInteraction: undefined, completionUnread: false }],
  ["t2", { running: false, pendingInteraction: { kind: "approval", key: "k", sessionId: "t2" }, completionUnread: false }],
  ["t3", { running: false, pendingInteraction: undefined, completionUnread: false }],
]);
const tokenList = {
  phase: "ready",
  ids: ["t1", "t2", "t3"],
  byId: {
    t1: { id: "t1", displayTitle: "大活", running: true, updatedAt: now },
    t2: { id: "t2", displayTitle: "小活", running: false, updatedAt: now - 60_000 },
    t3: { id: "t3", displayTitle: "没记账的", running: false, updatedAt: now - 90_000 },
  },
  projectionsBySession: {
    // t1 走宿主真实的 tokenUsage 投影（300K = 150K 未缓存 + 50K 缓存读 + 100K 输出）；
    // t2 只有单次（15.5K）；t3 宿主没给用量。
    t1: { values: { tokenUsage: { uncachedInputTokens: 150_000, cacheReadTokens: 50_000, cacheWriteTokens: 0, outputTokens: 100_000 } } },
    t2: { values: { usage: { inputTokens: 12_000, outputTokens: 3_500 } } },
  },
};
const tokenProps = {
  ...props,
  useSessions: (selector) => selector(tokenList),
  useSessionStatus: (selector) => selector(tokenStatuses),
  useWorkspaces: (selector) => selector({ items: [], archivedSessionIds: [] }),
};
const tokenPanel = hydrate(ReactStub.render(Panel, tokenProps));
const tokenPanelText = textOf(tokenPanel);
// 2026-11-07：逐任务的 Token 格子跟着任务清单一起挪到了浮动小窗（小窗那组用例已覆盖
// 「有量才挂、累计优先、单次兜底」三条口径）。面板这边只保留"合计"与"不重复列任务"。
check(withClass(tokenPanel, "dtr-panel-tok").length === 0, "面板 Token: 不再逐个任务挂格子（只在合计里出现）");
check(!tokenPanelText.includes("300K tok"), "面板 Token: 不再重复显示单任务用量");
const spend = withClass(tokenPanel, "dtr-panel-spend")[0];
check(Boolean(spend), "面板 Token: 总览带下面有一行合计");
check(textOf(spend).includes(radar.formatTokens(315_500)), "面板 Token: 合计是各任务之和（300K + 16K），不是只取第一个", textOf(spend));
check(textOf(spend).includes("2 个有记账"), "面板 Token: 写清合计算了几个（没记账的不算进去）", textOf(spend));
check(!tokenPanelText.includes("0 tok") && !tokenPanelText.includes("NaN"), "面板 Token: 没数据不出 0 tok / NaN", tokenPanelText.slice(0, 300));

// Token 流水：三档（今天 / 本周 / 本月）+ 最近 7 天柱图。
// 这里只验"有没有挂出来、口径字样对不对"，具体数字怎么算在 radar-unit.mjs 里钉。
const ledgerBlock = withClass(tokenPanel, "dtr-ledger")[0];
check(Boolean(ledgerBlock), "面板流水: 合计下面有一块 Token 流水");
const ledgerCells = withClass(tokenPanel, "dtr-ledger-cell");
check(ledgerCells.length === 3, "面板流水: 今天 / 本周 / 本月三格", ledgerCells.map((cell) => textOf(cell)));
check(ledgerCells.map((cell) => textOf(cell)).join("|") === "今天 — 0 点起|本周 — 周一起|本月 — 1 号起", "面板流水: 三格各自写明起点（0 点 / 周一 / 1 号）", ledgerCells.map((cell) => textOf(cell)));
// 柱图只在"开始记账之后"才画（空态不画七根空柱，否则看着像有数据）。
check(withClass(tokenPanel, "dtr-ledger-bars").length === 0, "面板流水: 没记过账时不画柱图");
check(ledgerBlock?.props?.["data-empty"] === "true", "面板流水: 没记过账时是空态，不假装有数");
check(textOf(ledgerBlock).includes("还没开始记"), "面板流水: 空态说实话（还没开始记）", textOf(ledgerBlock));

// 面板不再列任务，所以"点一行进会话"这条路径由浮动小窗的用例负责（见上文卡片点击）。

// ── 面板上的换肤区：两种世界 ────────────────────────────────────────────────
/**
 * 这段测两件事，缺一不可：
 *
 * 1. **没装主题插件时不许画假按钮** —— 没接上就直说，别给一排点了没反应的卡。
 * 2. **接上了要真的把请求派出去** —— 换肤不是本插件自己实现的，它只是把
 *    `dsh-skin:apply` 发给 dsh-plugin-skin；这条不测，面板上点一下可能什么都没有。
 */
ReactStub.reset();
const lonelyPanel = hydrate(ReactStub.render(Panel, props));
check(withClass(lonelyPanel, "dtr-skin").length === 1, "换肤: 没有主题插件时这块区域仍然在（说明原因，而不是消失）");
check(textOf(lonelyPanel).includes("没检测到"), "换肤: 没接上时明说没检测到「主题与外观」插件");
check(withClass(lonelyPanel, "dtr-skin-card").length === 0, "换肤: 没接上时不画点了没反应的皮肤卡");

// 装一个假的主题插件：接口 + 一份两套皮肤的快照
const skinEvents = [];
globalThis.window.dispatchEvent = (event) => { skinEvents.push(event); return true; };
globalThis.window.__dshSkinRuntime = {
  api: {
    get: () => ({
      skin: "graphite",
      skinLabel: "石墨灰",
      wallpaper: "__paper__",
      skins: [
        { id: "graphite", label: "石墨灰", note: "中性灰", accent: "#a8c2d4", bg: "#1b1f24", panel: "linear-gradient(#111,#222)", swatches: ["#111", "#222", "#333"] },
        { id: "sand", label: "米沙纸", note: "暖米调", accent: "#e6c68f", bg: "#2a241c", panel: "linear-gradient(#221,#443)", swatches: ["#333", "#444", "#555"] },
      ],
      wallpapers: [
        { id: "__paper__", label: "米纸纹", kind: "css" },
        { id: "__rainbow__", label: "黄昏彩虹", kind: "image" },
      ],
    }),
  },
};
ReactStub.reset();
const skinPanel = hydrate(ReactStub.render(Panel, props));
const skinCards = findAll(skinPanel, (element) => element.props?.className === "dtr-skin-card");
check(skinCards.length === 2, "换肤: 接上后按对方给的皮肤表画卡", skinCards.length);
check(textOf(skinPanel).includes("当前：石墨灰"), "换肤: 显示当前皮肤名");
const activeCard = skinCards.find((card) => card.props["data-active"] === "true");
check(activeCard !== undefined && textOf(activeCard).includes("石墨灰"), "换肤: 当前那套高亮");

skinCards.find((card) => textOf(card).includes("米沙纸"))?.props.onClick();
check(skinEvents.length === 1 && skinEvents[0].type === "dsh-skin:apply", "换肤: 点卡派发 dsh-skin:apply", skinEvents.map((event) => event.type));
check(skinEvents[0]?.detail?.skin === "sand", "换肤: 派出去的是被点那套的 id", skinEvents[0]?.detail);

const skinChips = findAll(skinPanel, (element) => element.props?.className === "dtr-skin-chip");
check(skinChips.length === 2, "换肤: 壁纸也列出来了（纹理和插画都在）", skinChips.length);
skinChips.find((chip) => textOf(chip).includes("黄昏彩虹"))?.props.onClick();
check(skinEvents[1]?.detail?.wallpaper === "__rainbow__", "换肤: 点壁纸派发的是 wallpaper", skinEvents[1]?.detail);

// 对方广播换了皮肤：面板要跟着重画（否则选中态会一直停在旧的那套）
globalThis.window.__dshSkinRuntime = undefined;
delete globalThis.window.dispatchEvent;
globalThis.window.__dshSkinRuntime = {
  api: { get: () => ({ skin: "sand", skinLabel: "米沙纸", skins: [{ id: "graphite", label: "石墨灰" }, { id: "sand", label: "米沙纸" }], wallpapers: [] }) },
};
ReactStub.reset();
const replayed = hydrate(ReactStub.render(Panel, props));
check(textOf(replayed).includes("当前：米沙纸"), "换肤: 对方换了皮肤，面板读到的当前皮肤跟着变");
delete globalThis.window.__dshSkinRuntime;

// ── 应用图标 ────────────────────────────────────────────────────────────────
// 图标是内联的 data URI（见 scripts/build-icon.mjs）：不能 Network 请求、不能留盘。
const sidebarIcon = hydrate(ReactStub.render(radar.PanelIcon, {}));
check(sidebarIcon.props?.className === "dtr-appicon", "图标: 侧栏那一行用的是图标元素，不再是字符 ◉", sidebarIcon.props?.className);
check(String(sidebarIcon.props?.src ?? "").startsWith("data:image/png;base64,"), "图标: 侧栏图标是内联 PNG（不发请求、不落盘）");
check(sidebarIcon.props?.alt === "", "图标: 装饰性图标 alt 为空（旁边就有文字，别让读屏念两遍）");

ReactStub.reset();
const iconCard = hydrate(ReactStub.render(captured.component, props));
check(withClass(iconCard, "dtr-appicon").length >= 1, "图标: 小窗标题栏也用同一张图");

// ── 卸载 ─────────────────────────────────────────────────────────────────────
ReactStub.unmount();
check(true, "卸载: 效果清理函数跑完没抛错");
check(warnings.length >= 0, "日志: 没有意外告警", warnings.length);

// ── 汇总 ─────────────────────────────────────────────────────────────────────
console.log(`\n${passed} 通过 / ${failures} 失败`);
if (failures > 0) process.exitCode = 1;
