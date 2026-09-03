# 存储后端按运行环境可插拔

脚本需要同时在超合金组件环境和用户脚本管理器（篡改猴/暴力猴）中运行，两者提供的持久化设施不同：组件环境有 `chiiApp.cloud_settings`（云同步），脚本管理器环境只有 `GM_getValue`/`GM_setValue`（仅本机）。我们决定：通过 `GM_info` 是否存在判定用户脚本模式、否则 `chiiApp.cloud_settings` 是否存在判定组件模式，两者皆无则静默退出；两种后端收敛到统一的 store 接口后面，用户脚本模式直接同步读写 GM 存储、不做缓存合并（GM 读写本身是同步的）。

后果：两种环境的数据互不相通（云端 vs 本机），导入/导出的 JSON 是唯一的互通桥梁；`@grant none` 不再成立，需要 `@grant GM_getValue` 与 `@grant GM_setValue`。

部分取代 ADR-0001（其结论收窄为仅组件模式的存储路径）。
