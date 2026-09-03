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
// @grant        GM_getValue
// @grant        GM_setValue
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

  // GM 存储键：整张 {用户标识: 标签数组} 映射序列化后存于单键（ADR-0001/0002）。
  // 注意：GM 存储按浏览器而非登录账号隔离，与 ADR-0002「按登录账号全局
  // 一份」存在已知偏差（组件模式由 cloud_settings 天然按账号隔离）；
  // 用户脚本模式下同浏览器切换账号会看到同一份数据，待后续工单处置。
  const STORAGE_KEY = "friendTags";

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

  // 标签规范化：按连续空白切分、逐项 trim、丢弃空串；区分大小写去重、
  // 保留首次输入形式。全部为空时返回空数组（表示清除该好友所有标签）。
  function normalizeTags(input) {
    if (typeof input !== "string") return [];
    const tags = [];
    for (const piece of input.split(/\s+/)) {
      const tag = piece.trim();
      if (tag !== "" && !tags.includes(tag)) tags.push(tag);
    }
    return tags;
  }

  // 统一 store 接口（ADR-0003）：{ getAll, get, set }，全部同步。
  //   getAll() → {[用户标识]: string[]}
  //   get(标识) → string[]（副本，无记录时为 []）
  //   set(标识, tags) → 覆盖该好友的标签；空数组视为清除，删除该键。
  // 用户脚本后端：GM_getValue/GM_setValue 直接同步读写，无缓存层、无合并。
  // 存储内容损坏时按空映射处理，不让历史脏数据抛错。
  function createUserScriptStore({ gmGetValue, gmSetValue }) {
    function readAll() {
      const raw = gmGetValue(STORAGE_KEY);
      if (typeof raw !== "string") return {};
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object") return {};
        const result = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (Array.isArray(value)) {
            result[key] = value.filter((tag) => typeof tag === "string");
          }
        }
        return result;
      } catch {
        return {};
      }
    }

    function getAll() {
      return readAll();
    }

    function get(identifier) {
      const tags = readAll()[identifier];
      return Array.isArray(tags) ? tags.slice() : [];
    }

    function set(identifier, tags) {
      const all = readAll();
      if (tags.length === 0) delete all[identifier];
      else all[identifier] = tags;
      gmSetValue(STORAGE_KEY, JSON.stringify(all));
    }

    return { getAll, get, set };
  }

  // 降级后端：GM API 不可用时（如未授予 @grant）的内存后端，保证页面内
  // 可用但不持久化；选择初始化时告警而非静默丢失数据。
  function createMemoryStore() {
    const data = new Map();
    return {
      getAll() {
        return Object.fromEntries(data);
      },
      get(identifier) {
        const tags = data.get(identifier);
        return tags ? tags.slice() : [];
      },
      set(identifier, tags) {
        if (tags.length === 0) data.delete(identifier);
        else data.set(identifier, tags.slice());
      },
    };
  }

  // 从 /user/{标识} 形式的链接解析用户标识；无法解析时返回 null。
  function parseUserHref(href) {
    const match = /^\/user\/([^/?#]+)/.exec(href ?? "");
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  function createTagLink({ document, store, dialog, identifier }) {
    const link = document.createElement("a");
    link.setAttribute("href", "#;");
    link.setAttribute("class", "l");
    link.textContent = "tag";
    link.addEventListener("click", (event) => {
      event?.preventDefault?.();
      if (typeof dialog?.prompt !== "function") return;
      const raw = dialog.prompt(
        "设置该好友的标签（用空格分隔多个）：",
        store.get(identifier).join(" "),
      );
      if (raw === null || raw === undefined) return;
      store.set(identifier, normalizeTags(raw));
    });
    return link;
  }

  // 在每个好友项上安装 tag 按钮。有 PM/del 操作行（small.grey）的项把
  // tag 追加到行尾；没有的（他人页面）按 del 的样式创建独立按钮，插在
  // 原操作行所在的位置（userContainer 末尾）。
  function installTagButtons({ document, store, dialog }) {
    const list = document.querySelector("#memberUserList");
    if (!list) return;
    for (const item of list.querySelectorAll("li.user")) {
      const container = item.querySelector("div.userContainer");
      if (!container) continue;
      const identifier = parseUserHref(
        container.querySelector("a.avatar")?.getAttribute("href"),
      );
      if (!identifier) continue;

      const tagLink = createTagLink({ document, store, dialog, identifier });
      const opRow = container.querySelector("small.grey");
      const delLink = opRow
        ?.querySelectorAll("a")
        .find((anchor) => anchor.textContent.trim() === "del");
      if (opRow && delLink) {
        opRow.append(document.createTextNode(" / "), tagLink);
      } else {
        const holder = document.createElement("small");
        holder.setAttribute("class", "grey");
        holder.append(tagLink);
        container.append(holder);
      }
    }
  }

  // 依赖注入入口。deps（均可省略，浏览器中缺省回退到全局对象）：
  //   document    — 页面 Document；
  //   location    — 页面 Location；
  //   dialog      — { prompt } 页面对话框桩，缺省用全局 prompt；
  //   gmInfo      — 用户脚本管理器注入的 GM_info，存在即用户脚本模式；
  //   gmGetValue / gmSetValue — 用户脚本模式的存储后端读写函数；
  //   chiiApp     — 组件沙箱提供的 chiiApp，含 cloud_settings 即组件模式。
  // 返回运行环境描述符 { mode, page }；应静默退出时返回 null，且保证不
  // 读取、不修改页面 DOM。
  // 本票只交付用户脚本模式后端（ADR-0003），tag 按钮仅在用户脚本模式
  // 安装；组件模式等 cloud_settings 后端落地后再启用（避免先用内存后端
  // 造成「能编辑但刷新即丢」的体验）。
  function initialize(deps = {}) {
    const mode = detectMode(deps);
    if (!mode) return null;

    const page = parsePageType(deps.location?.pathname);
    if (!page) return null;

    if (mode !== MODE.USERSCRIPT || !deps.document) return { mode, page };

    let store;
    if (
      typeof deps.gmGetValue === "function" &&
      typeof deps.gmSetValue === "function"
    ) {
      store = createUserScriptStore({
        gmGetValue: deps.gmGetValue,
        gmSetValue: deps.gmSetValue,
      });
    } else {
      warnStorageFallback();
      store = createMemoryStore();
    }
    installTagButtons({ document: deps.document, store, dialog: deps.dialog });

    return { mode, page };
  }

  function warnStorageFallback() {
    if (typeof console !== "undefined") {
      console.warn?.(
        "bangumi-friend-tag: GM_getValue/GM_setValue 不可用，标签数据不会持久化。",
      );
    }
  }

  // 浏览器（用户脚本或组件）中的缺省依赖来源。仅在文件尾部的浏览器分支
  // 调用；typeof 守卫使其在任何全局环境下都不会抛出 ReferenceError。
  function globalDependencies() {
    return {
      document: typeof document === "undefined" ? undefined : document,
      location: typeof location === "undefined" ? undefined : location,
      dialog:
        typeof prompt === "undefined"
          ? undefined
          : {
              prompt: (message, defaultValue) => prompt(message, defaultValue),
            },
      gmInfo: typeof GM_info === "undefined" ? undefined : GM_info,
      gmGetValue: typeof GM_getValue === "undefined" ? undefined : GM_getValue,
      gmSetValue: typeof GM_setValue === "undefined" ? undefined : GM_setValue,
      chiiApp: typeof chiiApp === "undefined" ? undefined : chiiApp,
    };
  }

  const core = { initialize, normalizeTags, createUserScriptStore };

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
