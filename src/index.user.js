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

  // 组件模式（ADR-0001，适用范围经 ADR-0003 收窄）：整张映射存放在
  // cloud_settings 的单个键中（规避「无法删除最后一个 key」的已知坑）。
  // cloud_settings 按登录账号天然隔离，无需账号后缀；localStorage 缓存
  // 键则必须带登录账号维度（见 createComponentStore 的 account 参数），
  // 否则同浏览器切换账号会读到别人的缓存。
  // cloud_settings 的值会被字符串化，但字符串数组可安全往返；数字键会被
  // 转成字符串键——用户标识本来就是字符串，无影响。
  const CLOUD_SETTINGS_KEY = "friendTags";

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
  // 存储键带登录账号维度（ADR-0002）：GM 存储按浏览器隔离而非按账号，
  // 固定键会让同浏览器切换账号共享同一份数据。旧无账号键的数据不迁移
  // （见 ADR 决策记录），从新键重新开始。
  function createUserScriptStore({ gmGetValue, gmSetValue, account }) {
    const storageKey = `friendTags:${account}`;

    function readAll() {
      const raw = gmGetValue(storageKey);
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
      gmSetValue(storageKey, JSON.stringify(all));
    }

    return { getAll, get, set };
  }

  function tagsEqual(a, b) {
    return a.length === b.length && a.every((tag, index) => tag === b[index]);
  }

  // 解析 cloud_settings / localStorage 中的整张标签映射。值可能是对象
  // （平台保留嵌套结构）或 JSON 字符串（防御双重序列化）；结构非法时
  // 返回 null，由调用方决定跳过合并而非覆盖本地。
  function parseTagMap(raw) {
    let data = raw;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        return null;
      }
    }
    return validateStoreData(data);
  }

  // 组件模式后端（ADR-0001/0003）：cloud_settings 单键 + localStorage
  // 缓存优先。cloud_settings 键（CLOUD_SETTINGS_KEY）按登录账号天然隔离，
  // 不加账号后缀；localStorage 缓存键按浏览器隔离，必须带登录账号
  // 维度（account 参数），否则同浏览器切换账号会读到别人的缓存。统一 store 接口同用户脚本后端（getAll/get/set，同步），
  // 另有 loadRemote()（返回 Promise）做后台云端合并：
  //   - 启动时先用 localStorage 缓存同步渲染（无缓存则为空映射）；
  //   - 云端到达后按用户标识条目级合并：本地编辑过（本次会话 set 过）
  //     的标识优先，其余以云端为准；合并产生变更时回写云端（update +
  //     save()），多标签页并发接受 last-write-wins；
  //   - 云端读取抛错/结构非法/键不存在时跳过合并不回写，避免误清本地。
  // save() 无回调（平台已知坑），保存结果无从感知，不依赖确认；所有
  // cloud_settings 调用均吞错，持久化失败不影响页面内使用（还有缓存）。
  function createComponentStore({
    cloudSettings,
    localStorage: storage,
    account,
  }) {
    const localCacheKey = `bangumi-friend-tag:friendTags:${account}`;
    // 缓存损坏或 storage 不可用时按无缓存处理（空映射，等云端）。
    let all = (() => {
      try {
        return parseTagMap(storage?.getItem?.(localCacheKey)) ?? {};
      } catch {
        return {};
      }
    })();
    const edited = new Set();
    // 导入即终态（#4 用户故事 14）：导入后本会话丢弃 pending 的云端
    // 合并结果，文件是唯一事实来源；导入数据经 set() 已推上云端。
    let imported = false;

    function writeCache() {
      try {
        storage?.setItem?.(localCacheKey, JSON.stringify(all));
      } catch {
        // 缓存写入失败（如隐私模式）：页面内仍可用，下次启动等云端。
      }
    }

    function persist() {
      writeCache();
      try {
        // update 合并写入指定键；save() 手动触发保存（未加入个性化
        // 面板时无自动保存），无回调、不等待、不依赖成功确认。
        cloudSettings.update?.({ [CLOUD_SETTINGS_KEY]: all });
        cloudSettings.save?.();
      } catch {
        // 云端写入失败无从感知：本地缓存已是最新，下次启动以缓存优先。
      }
    }

    function getAll() {
      return { ...all };
    }

    function get(identifier) {
      const tags = all[identifier];
      return Array.isArray(tags) ? tags.slice() : [];
    }

    function set(identifier, tags) {
      if (tags.length === 0) delete all[identifier];
      else all[identifier] = tags.slice();
      edited.add(identifier);
      persist();
    }

    // 按用户标识条目级合并云端数据；产生变更时回写并刷新缓存。
    // 返回是否产生了本地变更。
    function applyCloud(cloud) {
      if (!cloud) return false;
      let changed = false;
      for (const [identifier, tags] of Object.entries(cloud)) {
        if (edited.has(identifier)) continue;
        const current = all[identifier];
        if (!Array.isArray(current) || !tagsEqual(current, tags)) {
          all[identifier] = tags.slice();
          changed = true;
        }
      }
      for (const identifier of Object.keys(all)) {
        if (!edited.has(identifier) && !(identifier in cloud)) {
          delete all[identifier];
          changed = true;
        }
      }
      // ADR-0001 后果条款：合并期间存在本地编辑时，合并后必须回写云端，
      // 否则云端读取窗口之前的编辑会被云端的陈旧值在下次刷新时覆盖
      //（edited 条目在合并中被跳过，不回写就没人把本地值推上去）。
      if (changed || edited.size > 0) persist();
      return changed;
    }

    // 导入即终态：置位后 loadRemote 丢弃本次会话的云端合并结果。
    function markImported() {
      imported = true;
    }

    function loadRemote() {
      if (imported) return Promise.resolve(false);
      let raw;
      try {
        raw = cloudSettings.get?.(CLOUD_SETTINGS_KEY);
      } catch {
        return Promise.resolve(false);
      }
      return Promise.resolve(raw)
        .then((value) => (imported ? false : applyCloud(parseTagMap(value))))
        .catch(() => false);
    }

    return { getAll, get, set, loadRemote, markImported };
  }

  // 统一告警出口：带脚本前缀，console 缺失时静默。
  function warn(message) {
    if (typeof console !== "undefined") {
      console.warn?.(`bangumi-friend-tag: ${message}`);
    }
  }

  // 降级告警：GM API 不可用时（如未授予 @grant）告警后静默退出，
  // 不提供不可持久化的内存后端（规格只定义 GM/cloud 两种后端）。
  function warnStorageFallback() {
    warn("GM_getValue/GM_setValue 不可用，脚本不会运行。");
  }

  // 从 /user/{标识} 形式的链接解析用户标识；无法解析（含百分号解码
  // 失败）时返回 null，与 parsePageType 的策略一致：宁可跳过该条目，
  // 也不让同一好友因编码差异在不同页面落到不同的存储键。
  // 允许绝对 URL（页面右上角 idBadgerNeue 的头像链接带站内绝对地址）。
  function parseUserHref(href) {
    const match = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/]+)?\/user\/([^/?#]+)/.exec(
      href ?? "",
    );
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return null;
    }
  }

  // 从页面右上角 idBadgerNeue 的头像链接识别登录账号的用户标识。
  // 未登录时该容器内是 guest 登录/注册链接，取不到头像，返回 null。
  // 注意：不能用 #headerProfile 的 .headerAvatar——那是页面所有者的
  // 头像（subjectNav），在他人的好友页上会误把页主当登录账号。
  function detectAccountIdentifier(document) {
    const badge = document.querySelector(".idBadgerNeue");
    return parseUserHref(
      badge?.querySelector("a.avatar")?.getAttribute("href"),
    );
  }

  // 登录账号标识缺失（未登录或页头结构变动）时告警后静默退出：
  // 好友标签数据必须按登录账号隔离（ADR-0002），无账号宁可不可用。
  function warnAccountMissing() {
    warn("未能从页面识别登录账号，脚本不会运行。");
  }

  function createTagLink({ document, store, dialog, identifier, onEdit }) {
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
      onEdit?.(identifier);
    });
    return link;
  }

  // 收集当前页面实际出现的全部好友项。两类页面均无分页，面板的计数、
  // 标签列表与筛选都以这份清单为准。
  function collectFriendEntries(document) {
    const list = document.querySelector("#memberUserList");
    if (!list) return [];
    const entries = [];
    for (const item of list.querySelectorAll("li.user")) {
      const container = item.querySelector("div.userContainer");
      if (!container) continue;
      const identifier = parseUserHref(
        container.querySelector("a.avatar")?.getAttribute("href"),
      );
      if (!identifier) continue;
      entries.push({ identifier, item, container });
    }
    return entries;
  }

  // 导入数据结构校验：顶层对象、值均为字符串数组。不合法时返回 null。
  function validateStoreData(data) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      if (
        !Array.isArray(value) ||
        value.some((tag) => typeof tag !== "string")
      ) {
        return null;
      }
      result[key] = value.slice();
    }
    return result;
  }

  // 以导入数据覆盖整张 store：文件是唯一事实来源，现有数据中不在文件
  // 里的好友条目一并清除；同时置导入终态，丢弃 pending 的云端合并。
  function replaceStoreData(store, data) {
    store.markImported?.();
    for (const identifier of Object.keys(store.getAll())) {
      if (!(identifier in data)) store.set(identifier, []);
    }
    for (const [identifier, tags] of Object.entries(data)) {
      store.set(identifier, tags);
    }
  }

  // 唯一手写的新样式（AGENTS.md 硬性规范 3）：双栏布局。参数镜像站内
  // 右栏 #columnSubjectBrowserB{flex:3;min-width:0;margin-left:10px}。
  const PANEL_LAYOUT_CSS =
    "#friendTagPanelColumn{flex:3;min-width:0;margin-left:10px}";

  function installPanelStyles(document) {
    const head = document.querySelector("head");
    if (!head) return;
    const style = document.createElement("style");
    style.textContent = PANEL_LAYOUT_CSS;
    head.append(style);
  }

  // 站内 chiiBtn 的标准写法：<a class="chiiBtn"><span>文案</span></a>；
  // extraClass 追加站内工具类（如 .rr{float:right} 右对齐）。
  function createChiiButton(document, label, extraClass) {
    const button = document.createElement("a");
    button.setAttribute("href", "#;");
    button.setAttribute(
      "class",
      extraClass ? `chiiBtn ${extraClass}` : "chiiBtn",
    );
    const span = document.createElement("span");
    span.textContent = label;
    button.append(span);
    return button;
  }

  // 「好友的标签」栏：复刻条目页 SimpleSidePanel（标题 + tagList，计数
  // 复用站内 .tagList li a small 的右对齐浮动，见「我看过的动画」页
  // userTagList 的原始标记）。插入 .columns 内 columnUserSingle 之后的
  // 新右栏；空状态用站内 tip 风格「暂无标签」，标题与三个按钮常驻。
  // 筛选为单选，通过直接切换好友项可见性实现（不走 URL）；对数千好友
  // 项只做属性写入、不读取任何布局信息，避免逐项强制同步布局。
  function createTagPanel({ document, store, dialog, entries, files }) {
    const columns = document.querySelector(".columns");
    if (!columns) return { refresh() {} };
    installPanelStyles(document);

    const column = document.createElement("div");
    column.setAttribute("class", "column");
    column.setAttribute("id", "friendTagPanelColumn");

    const panel = document.createElement("div");
    panel.setAttribute("class", "SimpleSidePanel");
    panel.setAttribute("style", "width:190px;");

    const heading = document.createElement("h2");
    const resetButton = createChiiButton(document, "重置", "rr");
    heading.append(resetButton, document.createTextNode("好友的标签"));

    const listHolder = document.createElement("div");
    const emptyTip = document.createElement("div");
    emptyTip.setAttribute("class", "tip");
    emptyTip.textContent = "暂无标签";

    panel.append(heading, listHolder, emptyTip);

    const actions = document.createElement("div");
    const exportButton = createChiiButton(document, "导出");
    const importButton = createChiiButton(document, "导入");
    actions.append(exportButton, importButton);

    column.append(panel, actions);

    const anchor = columns.querySelector("#columnUserSingle");
    if (anchor && typeof anchor.insertAdjacentElement === "function") {
      anchor.insertAdjacentElement("afterend", column);
    } else {
      columns.append(column);
    }

    let selectedTag = null;
    let filterApplied = false;
    let currentList = null;

    // 计数与筛选共用同一份 store 快照，避免逐好友重复读取整张存储。
    function snapshot() {
      const all = store.getAll();
      const counts = new Map();
      for (const { identifier } of entries) {
        const tags = all[identifier];
        if (!Array.isArray(tags)) continue;
        for (const tag of new Set(tags)) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
      return { all, counts };
    }

    function renderList(counts) {
      if (currentList) currentList.remove();
      currentList = null;
      if (counts.size === 0) {
        emptyTip.style.display = "";
        return;
      }
      emptyTip.style.display = "none";
      const list = document.createElement("ul");
      list.setAttribute("class", "tagList");
      const sorted = [...counts.entries()].sort(
        ([tagA, countA], [tagB, countB]) =>
          countB - countA || (tagA < tagB ? -1 : 1),
      );
      for (const [tag, count] of sorted) {
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.setAttribute("href", "#;");
        link.setAttribute("class", tag === selectedTag ? "l focus" : "l");
        const countNode = document.createElement("small");
        countNode.textContent = String(count);
        link.append(countNode, document.createTextNode(tag));
        link.addEventListener("click", (event) => {
          event?.preventDefault?.();
          selectedTag = selectedTag === tag ? null : tag;
          refresh();
        });
        item.append(link);
        list.append(item);
      }
      listHolder.append(list);
      currentList = list;
    }

    function applyFilter(all) {
      const shouldFilter = selectedTag !== null;
      if (!shouldFilter && !filterApplied) return;
      filterApplied = shouldFilter;
      for (const { identifier, item } of entries) {
        const tags = all[identifier];
        const visible =
          !shouldFilter || (Array.isArray(tags) && tags.includes(selectedTag));
        item.style.display = visible ? "" : "none";
      }
    }

    function refresh() {
      const { all, counts } = snapshot();
      if (selectedTag !== null && !counts.has(selectedTag)) selectedTag = null;
      renderList(counts);
      applyFilter(all);
    }

    resetButton.addEventListener("click", (event) => {
      event?.preventDefault?.();
      if (selectedTag === null) return; // 无筛选时无副作用
      selectedTag = null;
      refresh();
    });

    exportButton.addEventListener("click", (event) => {
      event?.preventDefault?.();
      if (
        typeof dialog?.confirm !== "function" ||
        !dialog.confirm("导出好友标签数据？")
      ) {
        return;
      }
      files?.download?.(
        "bangumi-friend-tag-export.json",
        `${JSON.stringify(store.getAll(), null, 2)}\n`,
      );
    });

    importButton.addEventListener("click", (event) => {
      event?.preventDefault?.();
      if (typeof dialog?.confirm !== "function") return;
      if (!dialog.confirm("导入将覆盖现有全部标签数据，确定继续？")) return;
      Promise.resolve(files?.readText?.() ?? null)
        .then((text) => {
          if (text == null) return; // 用户取消了文件选择
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            // 保持 null，走下方结构校验失败分支。
          }
          const data = validateStoreData(parsed);
          if (!data) {
            dialog?.alert?.(
              "导入失败：文件不是合法的好友标签数据（应为对象，且值为字符串数组）。",
            );
            return;
          }
          replaceStoreData(store, data);
          refresh();
        })
        .catch(() => {
          dialog?.alert?.("导入失败：无法读取所选文件。");
        });
    });

    refresh();
    return { refresh };
  }

  // 在每个好友项上安装 tag 按钮。有 PM/del 操作行（small.grey）的项把
  // tag 追加到行尾；没有的（他人页面）按 del 的样式创建独立按钮，插在
  // 原操作行所在的位置（userContainer 末尾）。
  // entries 为 collectFriendEntries 收集的当前页好友项清单，onEdit 在
  // 每次编辑保存后回调（供标签栏面板刷新）。
  function installTagButtons({ document, store, dialog, entries, onEdit }) {
    for (const { identifier, container } of entries) {
      const tagLink = createTagLink({
        document,
        store,
        dialog,
        identifier,
        onEdit,
      });
      const opRow = container.querySelector("small.grey");
      const delLink = [...(opRow?.querySelectorAll("a") ?? [])].find(
        (anchor) => anchor.textContent.trim() === "del",
      );
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
  //   store       — 直接注入的 store（唯一测试 seam）；提供时跳过后端
  //                 构造与登录账号识别，由调用方对存储语义全权负责；
  //   dialog      — { prompt, confirm, alert } 页面对话框桩，缺省用全局
  //                 prompt/confirm/alert；
  //   files       — { download, readText } 文件桥桩，缺省用浏览器
  //                 Blob 下载与隐藏 file input 读取；
  //   gmInfo      — 用户脚本管理器注入的 GM_info，存在即用户脚本模式；
  //   gmGetValue / gmSetValue — 用户脚本模式的存储后端读写函数；
  //   chiiApp     — 组件沙箱提供的 chiiApp，含 cloud_settings 即组件模式；
  //   localStorage — 组件模式的本地缓存后端，缺省用全局 localStorage。
  // 返回运行环境描述符 { mode, page }；应静默退出时返回 null，且保证不
  // 读取、不修改页面 DOM。
  // 两种模式都从页面右上角 idBadgerNeue 头像识别登录账号，取不到时告警
  // 后静默退出（标签数据按登录账号隔离，ADR-0002，无账号宁可不可用）。
  // 用户脚本模式：GM 后端同步读写（ADR-0003），键带登录账号后缀。
  // 组件模式：cloud_settings 后端，缓存优先渲染 + 后台云端合并
  // （ADR-0001），云端到达后刷新面板；GM API 缺失时告警后静默退出，
  // 不提供不可持久化的内存后端。
  function initialize(deps = {}) {
    const mode = detectMode(deps);
    if (!mode) return null;

    const page = parsePageType(deps.location?.pathname);
    if (!page) return null;

    if (!deps.document) return { mode, page };

    let store = deps.store;
    if (!store) {
      const account = detectAccountIdentifier(deps.document);
      if (!account) {
        warnAccountMissing();
        return null;
      }
      if (mode === MODE.COMPONENT) {
        store = createComponentStore({
          cloudSettings: deps.chiiApp.cloud_settings,
          localStorage: deps.localStorage ?? null,
          account,
        });
      } else if (
        typeof deps.gmGetValue === "function" &&
        typeof deps.gmSetValue === "function"
      ) {
        store = createUserScriptStore({
          gmGetValue: deps.gmGetValue,
          gmSetValue: deps.gmSetValue,
          account,
        });
      } else {
        warnStorageFallback();
        return null;
      }
    }

    const entries = collectFriendEntries(deps.document);
    const panel = createTagPanel({
      document: deps.document,
      store,
      dialog: deps.dialog,
      entries,
      files: deps.files ?? defaultFiles(),
    });
    installTagButtons({
      document: deps.document,
      store,
      dialog: deps.dialog,
      entries,
      onEdit: () => panel.refresh(),
    });

    // 组件模式：云端数据后台到达后（无论是否合并出变更）刷新面板——
    // 无缓存时此刻才首次渲染出云端标签，有缓存时用云端刷新缓存渲染。
    // loadRemote 内部已吞掉所有错误，链路不会 reject。
    if (mode === MODE.COMPONENT) {
      store.loadRemote().then(() => panel.refresh());
    }

    return { mode, page };
  }

  // 浏览器（用户脚本或组件）中的缺省依赖来源。仅在文件尾部的浏览器分支
  // 调用；typeof 守卫使其在任何全局环境下都不会抛出 ReferenceError。
  function globalDependencies() {
    return {
      document: typeof document === "undefined" ? undefined : document,
      location: typeof location === "undefined" ? undefined : location,
      dialog: {
        prompt:
          typeof prompt === "undefined"
            ? undefined
            : (message, defaultValue) => prompt(message, defaultValue),
        confirm:
          typeof confirm === "undefined"
            ? undefined
            : (message) => confirm(message),
        alert:
          typeof alert === "undefined"
            ? undefined
            : (message) => alert(message),
      },
      files: defaultFiles(),
      gmInfo: typeof GM_info === "undefined" ? undefined : GM_info,
      gmGetValue: typeof GM_getValue === "undefined" ? undefined : GM_getValue,
      gmSetValue: typeof GM_setValue === "undefined" ? undefined : GM_setValue,
      chiiApp: typeof chiiApp === "undefined" ? undefined : chiiApp,
      // 隐私模式等场景下访问 localStorage 可能抛 SecurityError。
      localStorage: (() => {
        try {
          return typeof localStorage === "undefined" ? undefined : localStorage;
        } catch {
          return undefined;
        }
      })(),
    };
  }

  // 浏览器文件桥（导出下载与导入文件选择）。Blob/URL 不可用时导出为
  // 无操作；导入通过隐藏 file input 读取文本：用户取消选择时以 null
  // 结束（数据不变），读取失败时 reject（由调用方 alert 区分于取消）。
  function defaultFiles() {
    if (typeof document === "undefined") return undefined;
    return {
      download(filename, text) {
        if (
          typeof Blob === "undefined" ||
          typeof URL?.createObjectURL !== "function"
        ) {
          return;
        }
        const url = URL.createObjectURL(
          new Blob([text], { type: "application/json" }),
        );
        const anchor = document.createElement("a");
        anchor.setAttribute("href", url);
        anchor.setAttribute("download", filename);
        anchor.click();
        URL.revokeObjectURL(url);
      },
      readText() {
        return new Promise((resolve, reject) => {
          const input = document.createElement("input");
          input.setAttribute("type", "file");
          input.setAttribute("accept", ".json,application/json");
          // 现代浏览器在未选文件关闭文件框时触发 cancel；不支持的
          // 环境下 promise 保持 pending，数据同样不变。
          input.addEventListener("cancel", () => resolve(null));
          input.addEventListener("change", () => {
            const file = input.files?.[0];
            if (!file) {
              resolve(null);
              return;
            }
            file.text().then(resolve, reject);
          });
          input.click();
        });
      },
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
