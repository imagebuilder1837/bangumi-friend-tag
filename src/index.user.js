// ==UserScript==
// @name         Bangumi 好友标签
// @namespace    https://github.com/imagebuilder1837/bangumi-friend-tag
// @version      0.1.0
// @description  让好友/反向好友页能够添加并管理好友标签。
// @author       imagebuilder1837
// @match        https://bgm.tv/user/*/friends
// @match        https://bgm.tv/user/*/rev_friends
// @match        https://bangumi.tv/user/*/friends
// @match        https://bangumi.tv/user/*/rev_friends
// @match        https://chii.in/user/*/friends
// @match        https://chii.in/user/*/rev_friends
// @run-at       document-end
// @grant        none
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/imagebuilder1837/bangumi-friend-tag/refs/heads/main/src/index.user.js
// @updateURL    https://raw.githubusercontent.com/imagebuilder1837/bangumi-friend-tag/refs/heads/main/src/index.user.js
// ==/UserScript==

(function () {
  "use strict";

  const MODE = Object.freeze({
    COMPONENT: "component",
    USERSCRIPT: "userscript",
  });

  // 页面路径形如 /user/{标识}/friends 或 /user/{标识}/rev_friends，
  // 标识为数字或字符串（见 CONTEXT.md「用户标识」）。
  const PAGE_PATH_PATTERN = /^\/user\/([^/]+)\/(friends|rev_friends)\/?$/;

  // 运行环境判定（ADR-0003）：存在 GM_info → 用户脚本模式；否则存在
  // chiiApp.cloud_settings → 组件模式；两者皆无 → 返回 null，调用方静默退出。
  function detectMode(deps) {
    if (deps.gmInfo != null) return MODE.USERSCRIPT;
    if (deps.chiiApp?.cloud_settings) return MODE.COMPONENT;
    return null;
  }

  // 从 location 解析页面类型；非好友/反向好友页返回 null。组件模式的
  // @match 语义宽于油猴标准（见 docs/bangumi/cloud-settings.md），不能只
  // 靠匹配规则保证页面归属，需要在运行时二次判定。
  function parsePageType(pathname) {
    const match = PAGE_PATH_PATTERN.exec(pathname ?? "");
    if (!match) return null;
    let ownerIdentifier;
    try {
      ownerIdentifier = decodeURIComponent(match[1]);
    } catch {
      return null;
    }
    return { section: match[2], ownerIdentifier };
  }

  // 依赖注入入口。deps（均可省略，浏览器中缺省回退到全局对象）：
  //   document — 页面 Document；
  //   location — 页面 Location；
  //   store    — 好友标签统一存储后端（ADR-0003；当前骨架尚未消费）；
  //   dialog   — { prompt, confirm, alert } 页面对话框桩（当前骨架尚未消费）；
  //   gmInfo   — 用户脚本管理器注入的 GM_info，存在即用户脚本模式；
  //   chiiApp  — 组件沙箱提供的 chiiApp，含 cloud_settings 即组件模式。
  // 返回运行环境描述符 { mode, page }；应静默退出时返回 null，且保证不
  // 读取、不修改页面 DOM。
  function initialize(deps = {}) {
    const mode = detectMode(deps);
    if (!mode) return null;

    const page = parsePageType(deps.location?.pathname);
    if (!page) return null;

    return { mode, page };
  }

  // 浏览器（用户脚本或组件）中的缺省依赖来源。仅在文件尾部的浏览器分支
  // 调用；typeof 守卫使其在任何全局环境下都不会抛出 ReferenceError。
  function globalDependencies() {
    return {
      document: typeof document === "undefined" ? undefined : document,
      location: typeof location === "undefined" ? undefined : location,
      gmInfo: typeof GM_info === "undefined" ? undefined : GM_info,
      chiiApp: typeof chiiApp === "undefined" ? undefined : chiiApp,
    };
  }

  const core = { initialize };

  // 仅在 CommonJS 且无 document 的环境（即 node --test）导出 core；
  // 浏览器中跳过导出分支并自动初始化。
  if (
    typeof module === "object" &&
    module.exports &&
    typeof document === "undefined"
  ) {
    module.exports = core;
    return;
  }

  initialize(globalDependencies());
})();
