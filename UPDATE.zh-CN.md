# 更新发布流程

工作小管家已在 npm 与自定义市场索引上线。以后每次更新，按下面顺序做。
发布仓库里的 `market-index.json` 是市场的入口，它只在 npm 上真的能查到新版本之后才改。

## 0. 先确认改了什么

在开发目录 `D:\work\skill\plugins\dsh-plugin-task-radar` 修改代码。
用户可见的功能变化，记得同步到本仓库的 `README.md`（这里是面向用户的版本，
不会被同步脚本覆盖）。

## 1. 递增版本号

npm 不允许重复发布同一个版本号。只改代码不改版本号，第 5 步会失败。

```powershell
cd D:\work\skill\plugins\dsh-plugin-task-radar
npm version patch --no-git-tag-version   # 修 bug：0.7.1 → 0.7.2
npm version minor --no-git-tag-version   # 加功能：0.7.x → 0.8.0
```

## 2. 跑测试和打包检查

```powershell
npm run verify
npm pack --dry-run --ignore-scripts
```

测试必须 0 失败；打包清单应只有 5 个文件（`index.js`、`client.js`、
`cordis.patch.yml`、`README.md`、`package.json`）。多出素材、截图或测试目录就先修 `files`。

## 3. 同步到发布仓库

```powershell
node D:\work\skill\tools\sync-task-radar-release.mjs
```

脚本会把四个运行文件复制到本仓库，不动这里手写的 `README.md`。

## 4. 提交并推送 GitHub

```powershell
cd D:\work\skill\releases\task-radar-github
git status --short
git add client.js index.js cordis.patch.yml package.json README.md market-index.json
git commit -m "Release Task Radar <新版本号>"
git push origin main
```

## 5. 发布到 npm（需要你本人在场）

**一定要从发布快照目录发布**，不要从开发目录发：开发目录的 `files` 会带上 `docs/` 和
开发脚本，包会大一半，内容也和 GitHub 上的快照不一致。

这一步会要求 npm 账号的 2FA 验证码，只能由你本人在自己的 PowerShell 里输入：

```powershell
cd D:\work\skill\releases\task-radar-github
npm publish --access public --registry=https://registry.npmjs.org/
```

看到 `+ dsh-plugin-task-radar@<版本号>` 就成功了。如果提示 `EOTP`，说明当前终端
拿不到验证码，在自己开的 PowerShell 窗口里重跑即可；提示 `E403` 多半是 2FA 没通过；
提示 `E409` 表示这个版本号已经存在，回到第 1 步换一个版本号。

## 6. 更新市场索引

```powershell
node D:\work\skill\tools\update-market-index.mjs
```

脚本只认 npm 上的真实发布时间；查不到新版本就直接报错，不会写脏数据。

然后提交推送：

```powershell
cd D:\work\skill\releases\task-radar-github
git add market-index.json
git commit -m "Market index: Task Radar <新版本号>"
git push origin main
```

## 7. 让别人拿到新版本

用户在自己的 DSH 里打开 **插件 → 发现**，刷新后工作小管家会显示“有新版本”，
点击更新即可。也可以用精确版本安装：

```powershell
dsh plugin --profile <profile> add "dsh-plugin-task-radar@<版本号>"
```

## 已经装过的本地开发版

你机器上如果还链接着开发目录（`link:` 方式），市场里的 npm 版本不会自动替换它。
想用发布版，先移除链接依赖再装：

```powershell
dsh plugin --profile <profile> remove dsh-plugin-task-radar
dsh plugin --profile <profile> add "dsh-plugin-task-radar@<版本号>"
```

## 常见问题

- **改了代码但用户看不到变化**：确认版本号递增了、npm 发布成功、索引也推送了。
  三者缺一个，市场都拿不到新版本。
- **索引推送了但发现页没有新版本**：发现页会缓存索引，刷新一次再等一会儿。
- **想撤回某个版本**：npm 发布 72 小时内可以用 `npm unpublish <包名>@<版本号>`,
  超过就只能发布新版本覆盖，不能删除。索引里删掉那条版本也很重要。

## 延伸：还没做的部分

- 社区目录 `awesome-dsh-plugin` 的收录 PR 尚未提交；提交后每次描述变化需要另开 PR
  更新对应条目。
- 仓库 `dsh-plugin` topic 与 GitHub Release 的添加状态需要在网页上核实。
