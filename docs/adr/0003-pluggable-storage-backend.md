# 存储后端按运行环境可插拔

脚本需要同时在超合金组件环境和用户脚本管理器（篡改猴/暴力猴）中运行，两者提供的持久化设施不同：组件环境有 `chiiApp.cloud_settings`（云同步），脚本管理器环境只有 `GM_getValue`/`GM_setValue`（仅本机）。我们决定：通过 `GM_info` 是否存在判定用户脚本模式、否则 `chiiApp.cloud_settings` 是否存在判定组件模式，两者皆无则静默退出；两种后端收敛到统一的 store 接口后面，用户脚本模式直接同步读写 GM 存储、不做缓存合并（GM 读写本身是同步的）。

后果：两种环境的数据互不相通（云端 vs 本机），导入/导出的 JSON 是唯一的互通桥梁；`@grant none` 不再成立，需要 `@grant GM_getValue` 与 `@grant GM_setValue`。

部分取代 ADR-0001（其结论收窄为仅组件模式的存储路径）。

## 修订（replaceAll 与可选的 refreshRemote）

统一 store 接口从 `{ getAll, get, set }` 扩展为 `{ getAll, get, set, replaceAll }`，组件模式后端另提供可选的 `refreshRemote()`（返回 Promise）做后台云端合并：

- `replaceAll(data)` 是导入语义的唯一入口：整张覆盖（不在 `data` 里的条目一并清除）、写入持久层、并置导入终态（丢弃本次会话 pending 的云端合并与本地编辑）。持久化细节由后端自决——用户脚本后端单次序列化写穿 GM 存储，组件后端一次性写穿云端与缓存。此前由调用方逐条 `set` 拼装导入，导致「无缓存且云端读取未完成时导入空映射」既不触发写穿、也无法置终态，旧云端标签会在下次加载复活。
- `refreshRemote` 是可选能力而非接口成员：用户脚本后端无云端，测试注入的最小 store 也只承诺统一接口；启动逻辑以 `store.refreshRemote?.()` 调用，不得假设其存在。

动机：把「文件是唯一事实来源」的后端细节收敛进 store，调用方不探测后端专属方法（`markImported`、`loadRemote` 已移除）。
