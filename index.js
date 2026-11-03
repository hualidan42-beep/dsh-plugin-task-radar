/**
 * dsh-plugin-task-radar —— 宿主半。
 *
 * 本插件**不需要任何宿主能力**：雷达的数据全部由宿主前端已有的推送给出
 * （`useSessions` / `useSessionStatus` / `useWorkspaces` 三个 root 标准 props），
 * 跳转走 `ctx.uiWorkspace.openSession`，位置与未读状态存浏览器 localStorage。
 * 不注册路由、不留盘、不碰模型上下文。
 *
 * 之所以还留一个宿主半，是因为 DSH 的插件包装载方式要求包本身是个 Cordis 插件
 * （`dsh.bundle.patch` 把它插进层栈），客户端半只是它的一个出口。
 *
 * @module dsh-plugin-task-radar
 */

/** 稳定 Cordis 插件名（与 cordis.patch.yml 里的 id 对齐）。 */
export const name = "task-radar";

/** 不依赖任何宿主服务。 */
export const inject = [];

/** 空实现：装载即完成。 */
export function apply() {}
