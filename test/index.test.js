const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const core = require("../src/index.user.js");

const SOURCE_PATH = path.join(__dirname, "..", "src", "index.user.js");

// 手写最小 DOM 桩（模仿 bangumi-friend-sorter）：从真实页面 fixture 的
// memberUserList 子树解析出一棵轻量节点树，只支持源码实际使用的复合选择器
// （单个 tag/class/id 组合，不支持后代组合器），任何无法解析的选择器一律
// 断言失败，避免测试与实现静默漂移。桩记录源码施加的全部操作（含查询），
// 未发生交互时可用 mutations 深比较证明源码既没查询也没修改页面。
class StubElement {
  constructor(tagName, record) {
    this.tagName = tagName;
    this.attributes = {};
    this.children = [];
    this.clickListeners = [];
    // 可见性筛选直接写 style.display；桩用普通对象承接属性写入。
    this.style = {};
    this.parent = null;
    this.#record = record;
  }

  #record;

  setAttribute(name, value) {
    this.#record("setAttribute", { tagName: this.tagName, name, value });
    this.attributes[name] = value;
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }

  get textContent() {
    return this.children
      .map((child) => (typeof child === "string" ? child : child.textContent))
      .join("");
  }

  set textContent(value) {
    this.#record("setText", { tagName: this.tagName, data: value });
    this.children = [String(value)];
  }

  append(...nodes) {
    this.#record("append", { tagName: this.tagName, count: nodes.length });
    this.children.push(...nodes);
    for (const node of nodes) {
      if (typeof node !== "string") node.parent = this;
    }
  }

  appendChild(node) {
    this.#record("appendChild", { tagName: this.tagName });
    this.children.push(node);
    node.parent = this;
    return node;
  }

  insertBefore(node) {
    this.#record("insertBefore", { tagName: this.tagName });
    this.children.unshift(node);
    node.parent = this;
    return node;
  }

  // 面板右栏插入 columnUserSingle 之后用 afterend；其他位置一律断言失败。
  insertAdjacentElement(position, node) {
    this.#record("insertAdjacentElement", { tagName: this.tagName, position });
    assert.equal(position, "afterend", `桩只支持 afterend 插入，收到：${position}`);
    assert.ok(this.parent, "insertAdjacentElement 需要 parent 指针");
    const index = this.parent.children.indexOf(this);
    this.parent.children.splice(index + 1, 0, node);
    node.parent = this.parent;
    return node;
  }

  remove() {
    this.#record("remove", { tagName: this.tagName });
    if (this.parent) {
      const index = this.parent.children.indexOf(this);
      if (index !== -1) this.parent.children.splice(index, 1);
      this.parent = null;
    }
  }

  click() {
    this.#record("click", { tagName: this.tagName });
    for (const listener of this.clickListeners) listener({ preventDefault() {} });
  }

  addEventListener(type, listener) {
    this.#record("addEventListener", { tagName: this.tagName, type });
    if (type === "click") this.clickListeners.push(listener);
  }

  querySelector(selector) {
    this.#record("querySelector", { tagName: this.tagName, selector });
    const parsed = parseCompound(selector);
    if (matchesSelector(this, parsed)) return this;
    for (const node of walkElements(this)) {
      if (matchesSelector(node, parsed)) return node;
    }
    return null;
  }

  querySelectorAll(selector) {
    this.#record("querySelectorAll", { tagName: this.tagName, selector });
    const parsed = parseCompound(selector);
    return [...walkElements(this)].filter((node) =>
      matchesSelector(node, parsed)
    );
  }
}

const VOID_TAGS = new Set(["br", "img", "input", "hr", "meta", "link"]);

// 把（好友页子树的）HTML 片段解析成 StubElement 树。文本节点用字符串表示。
function parseFragment(html, record) {
  const root = new StubElement("#fragment", record);
  const stack = [root];
  const pattern =
    /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)[^>]*>|<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    if (match[4] !== undefined) {
      stack.at(-1).children.push(match[4]);
      continue;
    }
    if (match[0].startsWith("<!--")) continue;
    if (match[1] !== undefined) {
      const name = match[1].toLowerCase();
      while (stack.length > 1 && stack.at(-1).tagName.toLowerCase() !== name) {
        stack.pop();
      }
      stack.pop();
      continue;
    }
    const element = new StubElement(match[2].toLowerCase(), record);
    for (const attr of match[3].matchAll(/([\w-]+)(?:\s*=\s*"([^"]*)")?/g)) {
      element.attributes[attr[1]] = attr[2] ?? "";
    }
    element.parent = stack.at(-1);
    stack.at(-1).children.push(element);
    if (!VOID_TAGS.has(element.tagName) && !match[0].endsWith("/>")) {
      stack.push(element);
    }
  }
  return root;
}

function parseCompound(selector) {
  assert.match(selector, /^\S+$/, `桩不支持复合选择器：${selector}`);
  const match = /^([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+)*)$/.exec(selector);
  assert.ok(match, `桩无法解析选择器：${selector}`);
  return {
    tag: match[1] ?? null,
    classes: [...selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]),
    id: selector.match(/#([\w-]+)/)?.[1] ?? null,
  };
}

function matchesSelector(node, parsed) {
  if (typeof node !== "object" || node.tagName === undefined) return false;
  if (
    parsed.tag &&
    parsed.tag !== "*" &&
    node.tagName.toLowerCase() !== parsed.tag.toLowerCase()
  ) {
    return false;
  }
  if (parsed.id && node.attributes.id !== parsed.id) return false;
  const classes = (node.attributes.class ?? "").split(/\s+/);
  return parsed.classes.every((cls) => classes.includes(cls));
}

function* walkElements(node) {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    yield child;
    yield* walkElements(child);
  }
}

// 从已解析的子树根构造 document 桩（供 fixture 与手工构造树共用）。
function documentFromTree(root) {
  const mutations = [];
  const record = (kind, detail) => mutations.push({ kind, ...detail });
  const document = {
    createElement(tagName) {
      record("createElement", { tagName });
      return new StubElement(tagName, record);
    },
    createTextNode(data) {
      record("createTextNode", { data });
      return String(data);
    },
    querySelector(selector) {
      record("querySelector", { selector });
      const parsed = parseCompound(selector);
      if (matchesSelector(root, parsed)) return root;
      for (const node of walkElements(root)) {
        if (matchesSelector(node, parsed)) return node;
      }
      return null;
    },
    querySelectorAll(selector) {
      record("querySelectorAll", { selector });
      const parsed = parseCompound(selector);
      return [...walkElements(root)].filter((node) =>
        matchesSelector(node, parsed)
      );
    },
  };
  return { document, mutations };
}

// 从 fixture 构造 document 桩；root 是解析出的整页树（面板需要
// .columns / #columnUserSingle / head，仅解析 memberUserList 子树不够）。
function documentFromFixture(filename) {
  const html = fs.readFileSync(
    path.join(__dirname, "fixtures", filename),
    "utf8"
  );
  // fixture 自检：确认内容确为好友/反向好友页结构。
  assert.match(html, /id=["']memberUserList["']/);

  const root = parseFragment(html, () => {});
  const { document, mutations } = documentFromTree(root);
  return { document, root, mutations };
}

// ---- 测试辅助 ----

function userContainers(root) {
  return root
    .querySelectorAll("li.user")
    .map((li) => li.querySelector("div.userContainer"));
}

function containerWithAvatarHref(root, href) {
  return userContainers(root).find(
    (container) => container?.querySelector("a.avatar")?.getAttribute("href") === href
  );
}

function tagLinks(root) {
  return [...walkElements(root)].filter(
    (node) => node.tagName === "a" && node.textContent === "tag"
  );
}

function clickTag(link) {
  clickNode(link);
}

function clickNode(node) {
  for (const listener of node.clickListeners) listener({ preventDefault() {} });
}

// ---- 标签栏面板辅助 ----

function findElement(root, predicate) {
  return walkElements(root).find(predicate) ?? null;
}

function hasClass(node, cls) {
  return (node.attributes.class ?? "").split(/\s+/).includes(cls);
}

function elementChildren(node) {
  return node.children.filter((child) => typeof child !== "string");
}

function tagPanel(root) {
  return findElement(root, (node) => hasClass(node, "SimpleSidePanel"));
}

function panelColumn(root) {
  return findElement(root, (node) => node.attributes.id === "friendTagPanelColumn");
}

function columnsElement(root) {
  return findElement(root, (node) => hasClass(node, "columns"));
}

function emptyTip(root) {
  return findElement(
    root,
    (node) => hasClass(node, "tip") && node.textContent === "暂无标签"
  );
}

function chiiButtons(root) {
  return [...walkElements(root)].filter(
    (node) => node.tagName === "a" && hasClass(node, "chiiBtn")
  );
}

function chiiButtonByLabel(root, label) {
  return chiiButtons(root).find((node) => node.textContent === label) ?? null;
}

// tagList 的每个 li：{ tag, count, link }（结构与站内
// `<li><a class="l"><small>计数</small>标签</a></li>` 一致）。
function tagListItems(root) {
  const panel = tagPanel(root);
  if (!panel) return [];
  const list = [...walkElements(panel)].find(
    (node) => node.tagName === "ul" && hasClass(node, "tagList")
  );
  if (!list) return [];
  return elementChildren(list).map((li) => {
    const link = elementChildren(li)[0];
    const [countNode] = elementChildren(link);
    return {
      tag: link.children.at(-1),
      count: countNode.textContent,
      link,
    };
  });
}

function listItemsByHref(root) {
  const map = new Map();
  for (const li of root.querySelectorAll("li.user")) {
    const href = li.querySelector("a.avatar")?.getAttribute("href");
    if (href !== null && href !== undefined) map.set(href, li);
  }
  return map;
}

function visibleHrefs(root) {
  return [...listItemsByHref(root).entries()]
    .filter(([, li]) => li.style.display !== "none")
    .map(([href]) => href)
    .sort();
}

// 构造一次完整的用户脚本模式初始化：GM 存储由内存字符串模拟，
// prompt/confirm/alert 桩可编程返回值并记录调用，files 桩记录下载并
// 提供可编程的文件读取结果。
function makeUserscriptPage(
  fixtureName,
  {
    pathname,
    storeData = {},
    promptReturn,
    confirmReturn = true,
    readTextReturn,
  } = {}
) {
  const { document, root, mutations } = documentFromFixture(fixtureName);
  let serialized = JSON.stringify(storeData);
  const gmGetValue = () => serialized;
  const gmSetValue = (key, value) => {
    serialized = value;
  };
  const promptCalls = [];
  const confirmCalls = [];
  const alertCalls = [];
  const readTextCalls = [];
  const downloads = [];
  const dialog = {
    prompt(message, defaultValue) {
      promptCalls.push({ message, defaultValue });
      return promptReturn;
    },
    confirm(message) {
      confirmCalls.push(message);
      return confirmReturn;
    },
    alert(message) {
      alertCalls.push(message);
    },
  };
  const files = {
    download(filename, text) {
      downloads.push({ filename, text });
    },
    readText() {
      readTextCalls.push(true);
      return Promise.resolve(readTextReturn ?? null);
    },
  };
  const runtime = core.initialize({
    document,
    location: { pathname },
    gmInfo: { scriptMetaStr: "" },
    gmGetValue,
    gmSetValue,
    dialog,
    files,
  });
  return {
    runtime,
    root,
    mutations,
    promptCalls,
    confirmCalls,
    alertCalls,
    readTextCalls,
    downloads,
    readStore: () => JSON.parse(serialized),
  };
}

function cloudSettingsStub() {
  return {
    cloud_settings: {
      update() {},
      getAll() {},
      get() {},
      delete() {},
      save() {},
    },
  };
}

// ---- 组件模式（#5）：cloud_settings 后端 + localStorage 缓存 ----

function makeLocalStorageStub(initialEntries = {}) {
  const map = new Map(Object.entries(initialEntries));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

// fake cloud_settings 桩（docs/bangumi/cloud-settings.md 的 API 形状）：
// 内存保存、记录 update/save 调用；deferGet 让 get 返回未决 promise，
// 模拟云端数据延迟到达。
function makeCloudSettingsStub(
  initialTags,
  { getThrows = false, rawValue, defer = false } = {}
) {
  const calls = { update: [], save: 0, get: 0 };
  const data = {};
  if (initialTags !== undefined) {
    data[core.CLOUD_SETTINGS_KEY] = initialTags;
  }
  let deferred = null;
  let lastDeferred = null;
  const stub = {
    update(patch) {
      calls.update.push({ ...patch });
      Object.assign(data, patch);
    },
    getAll() {
      return { ...data };
    },
    get(key) {
      calls.get += 1;
      if (getThrows) throw new Error("cloud read failed");
      if (deferred) return deferred.promise;
      if (rawValue !== undefined && key === core.CLOUD_SETTINGS_KEY) {
        return rawValue;
      }
      return data[key];
    },
    delete(key) {
      delete data[key];
    },
    save() {
      calls.save += 1;
    },
    deferGet() {
      let resolveGet;
      const promise = new Promise((resolve) => (resolveGet = resolve));
      deferred = {
        promise,
        resolve(value) {
          deferred = null;
          resolveGet(value);
        },
      };
      lastDeferred = deferred;
      return deferred;
    },
  };
  if (defer) stub.deferGet();
  return {
    stub,
    calls,
    data,
    get deferred() {
      return lastDeferred;
    },
  };
}

// 构造一次完整的组件模式初始化。cacheData（结构化映射）或 rawCache
// （原始字符串，用于构造损坏缓存）预置 localStorage 缓存。
function makeComponentPage(
  fixtureName,
  { pathname, cloudData, cacheData, rawCache, cloudOptions } = {}
) {
  const { document, root } = documentFromFixture(fixtureName);
  const cacheEntries =
    rawCache !== undefined
      ? { [core.LOCAL_CACHE_KEY]: rawCache }
      : cacheData === undefined
        ? {}
        : { [core.LOCAL_CACHE_KEY]: JSON.stringify(cacheData) };
  const storage = makeLocalStorageStub(cacheEntries);
  const cloud = makeCloudSettingsStub(cloudData, cloudOptions);
  const dialog = {
    prompt() {
      return null;
    },
    confirm() {
      return true;
    },
    alert() {},
  };
  const runtime = core.initialize({
    document,
    location: { pathname: pathname ?? "/user/sai/friends" },
    chiiApp: { cloud_settings: cloud.stub },
    localStorage: storage,
    dialog,
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { runtime, root, storage, cloud, flush, dialog };
}

function cachedTags(storage) {
  const raw = storage.getItem(core.LOCAL_CACHE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

function tagLinkFor(root, href) {
  const container = containerWithAvatarHref(root, href);
  return tagLinks(root).find((link) =>
    container.children.some(function has(node) {
      return node === link || (node.children && node.children.some(has));
    })
  );
}

// ---- core API 与运行环境判定 ----

test("core 暴露 initialize、normalizeTags、两种 store 工厂与存储键常量", () => {
  assert.deepEqual(Object.keys(core).sort(), [
    "CLOUD_SETTINGS_KEY",
    "LOCAL_CACHE_KEY",
    "createComponentStore",
    "createUserScriptStore",
    "initialize",
    "normalizeTags",
  ]);
  assert.equal(typeof core.initialize, "function");
  assert.equal(typeof core.normalizeTags, "function");
  assert.equal(typeof core.createUserScriptStore, "function");
  assert.equal(typeof core.createComponentStore, "function");
  assert.equal(typeof core.CLOUD_SETTINGS_KEY, "string");
  assert.equal(typeof core.LOCAL_CACHE_KEY, "string");
});

test("存在 GM_info 时判定为用户脚本模式", () => {
  const { document } = documentFromFixture("friends.html");
  const runtime = core.initialize({
    document,
    location: { pathname: "/user/sai/friends" },
    gmInfo: { scriptMetaStr: "" },
  });
  assert.deepEqual(runtime, {
    mode: "userscript",
    page: { section: "friends", ownerIdentifier: "sai" },
  });
});

test("存在 chiiApp.cloud_settings 时判定为组件模式并安装 tag 按钮与面板", () => {
  const page = makeComponentPage("rev_friends.html", {
    pathname: "/user/2/rev_friends",
    cloudData: {},
  });
  assert.deepEqual(page.runtime, {
    mode: "component",
    page: { section: "rev_friends", ownerIdentifier: "2" },
  });
  const containers = userContainers(page.root);
  assert.equal(tagLinks(page.root).length, containers.length);
  assert.ok(tagPanel(page.root));
  assert.ok(panelColumn(page.root));
});

test("GM_info 与 chiiApp 同时存在时用户脚本模式优先（ADR-0003）", () => {
  const { document } = documentFromFixture("friends.html");
  const runtime = core.initialize({
    document,
    location: { pathname: "/user/sai/friends" },
    gmInfo: { scriptMetaStr: "" },
    chiiApp: cloudSettingsStub(),
  });
  assert.equal(runtime?.mode, "userscript");
});

test("chiiApp 存在但缺 cloud_settings 时静默退出", () => {
  const { document, mutations } = documentFromFixture("friends.html");
  const runtime = core.initialize({
    document,
    location: { pathname: "/user/sai/friends" },
    chiiApp: {},
  });
  assert.equal(runtime, null);
});

test("两种环境标志皆无时静默退出且不读取、不修改页面 DOM", () => {
  const { document, mutations } = documentFromFixture("friends.html");
  const runtime = core.initialize({
    document,
    location: { pathname: "/user/sai/friends" },
  });
  assert.equal(runtime, null);
  // 桩把查询也记入 mutations：为空说明源码既没查询也没修改页面。
  assert.deepEqual(mutations, []);
});

test("非好友页静默退出且不修改页面 DOM", () => {
  const { document, mutations } = documentFromFixture("friends.html");
  const runtime = core.initialize({
    document,
    location: { pathname: "/user/sai/anime" },
    gmInfo: { scriptMetaStr: "" },
  });
  assert.equal(runtime, null);
  assert.deepEqual(mutations, []);
});

test("页面类型解析覆盖好友页、反向好友页、尾斜杠与百分号编码标识", () => {
  const { document } = documentFromFixture("friends.html");
  const initializeWith = (pathname) =>
    core.initialize({
      document,
      location: { pathname },
      gmInfo: { scriptMetaStr: "" },
    })?.page;

  assert.deepEqual(initializeWith("/user/2/friends"), {
    section: "friends",
    ownerIdentifier: "2",
  });
  assert.deepEqual(initializeWith("/user/sai/rev_friends/"), {
    section: "rev_friends",
    ownerIdentifier: "sai",
  });
  assert.deepEqual(initializeWith("/user/%E6%A2%85/friends"), {
    section: "friends",
    ownerIdentifier: "梅",
  });
  assert.equal(initializeWith("/user/sai"), undefined);
  assert.equal(initializeWith("/"), undefined);
});

// ---- 标签规范化 ----

test("normalizeTags：按连续空白切分并丢弃空串", () => {
  assert.deepEqual(core.normalizeTags("a  b\tc\n d"), ["a", "b", "c", "d"]);
  assert.deepEqual(core.normalizeTags("  x  "), ["x"]);
  assert.deepEqual(core.normalizeTags("   "), []);
  assert.deepEqual(core.normalizeTags(""), []);
});

test("normalizeTags：区分大小写去重，保留首次输入形式", () => {
  assert.deepEqual(core.normalizeTags("A a Ab a A"), ["A", "a", "Ab"]);
});

test("normalizeTags：非字符串输入视为空", () => {
  assert.deepEqual(core.normalizeTags(null), []);
  assert.deepEqual(core.normalizeTags(undefined), []);
  assert.deepEqual(core.normalizeTags(42), []);
});

// ---- store ----

test("GM store：保存后重新读取数据一致；新实例读到同一份数据", () => {
  let serialized = "";
  const gmGetValue = () => serialized;
  const gmSetValue = (key, value) => {
    serialized = value;
  };
  const store = core.createUserScriptStore({ gmGetValue, gmSetValue });

  store.set("puson_pp", ["动画", "监督"]);
  assert.deepEqual(store.get("puson_pp"), ["动画", "监督"]);

  // 模拟新页面加载：全新 store 实例从 GM 存储读取。
  const reloaded = core.createUserScriptStore({ gmGetValue, gmSetValue });
  assert.deepEqual(reloaded.get("puson_pp"), ["动画", "监督"]);
});

test("GM store：全部为空视为清除该好友所有标签", () => {
  let serialized = JSON.stringify({ sai: ["旧"] });
  const store = core.createUserScriptStore({
    gmGetValue: () => serialized,
    gmSetValue: (key, value) => {
      serialized = value;
    },
  });

  store.set("sai", []);
  assert.deepEqual(store.get("sai"), []);
  assert.deepEqual(JSON.parse(serialized), {});
});

test("GM store：get 返回副本，外部修改不影响存储", () => {
  const serialized = JSON.stringify({ sai: ["a"] });
  const store = core.createUserScriptStore({
    gmGetValue: () => serialized,
    gmSetValue: () => {},
  });
  const tags = store.get("sai");
  tags.push("b");
  assert.deepEqual(store.get("sai"), ["a"]);
});

test("GM store：存储内容损坏时回退为空映射而非抛错", () => {
  const store = core.createUserScriptStore({
    gmGetValue: () => "not-json{",
    gmSetValue: () => {},
  });
  assert.deepEqual(store.get("sai"), []);
});

// ---- tag 按钮：四类页面形态 ----

test("自己好友页：PM / del 后追加 tag（成 PM / del / tag）", () => {
  const { root } = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
  });

  const links = tagLinks(root);
  const containers = userContainers(root);
  assert.equal(links.length, containers.length);

  for (const container of containers) {
    const opRow = container.querySelector("small.grey");
    assert.ok(opRow, "好友项应保留原操作行");
    const texts = opRow.children.map((child) =>
      typeof child === "string" ? child : child.textContent
    );
    assert.deepEqual(texts, ["PM", " / ", "del", " / ", "tag"]);
    const tagLink = opRow.children.at(-1);
    assert.equal(tagLink.getAttribute("href"), "#;");
    assert.equal(tagLink.getAttribute("class"), "l");
  }
});

test("自己反向好友页：del 后追加 tag（成 del / tag）", () => {
  const { root } = makeUserscriptPage("rev_friends_logged.html", {
    pathname: "/user/sai/rev_friends",
  });

  const links = tagLinks(root);
  const containers = userContainers(root);
  assert.equal(links.length, containers.length);

  for (const container of containers) {
    const opRow = container.querySelector("small.grey");
    assert.ok(opRow, "反向好友项应保留原操作行");
    const texts = opRow.children.map((child) =>
      typeof child === "string" ? child : child.textContent
    );
    assert.deepEqual(texts, ["del", " / ", "tag"]);
  }
});

test("他人页面：无 PM/del 操作行时按 del 样式创建独立 tag 按钮", () => {
  const { root } = makeUserscriptPage("friends.html", {
    pathname: "/user/sai/friends",
  });
  const links = tagLinks(root);
  const containers = userContainers(root);
  assert.equal(links.length, containers.length);

  for (const container of containers) {
    // 原页面没有操作行；脚本新增一个 small.grey 持有 tag 按钮。
    const holder = container.querySelector("small.grey");
    assert.ok(holder, "应为无操作行的好友项创建 tag 按钮容器");
    assert.deepEqual(container.children.at(-1), holder);
    const tagLink = holder.children.at(-1);
    assert.equal(tagLink.textContent, "tag");
    assert.equal(tagLink.getAttribute("href"), "#;");
    assert.equal(tagLink.getAttribute("class"), "l");
    // 不触碰页面其他元素：container 的元素子节点只有原有的 strong 和新增的 holder。
    const elementChildren = container.children.filter(
      (child) => typeof child !== "string"
    );
    assert.deepEqual(
      elementChildren.map((child) => child.tagName),
      ["strong", "small"]
    );
  }
});

test("他人反向好友页：同样在无操作行时创建独立 tag 按钮", () => {
  const { root } = makeUserscriptPage("rev_friends.html", {
    pathname: "/user/other/rev_friends",
  });

  const links = tagLinks(root);
  const containers = userContainers(root);
  assert.equal(links.length, containers.length);

  for (const container of containers) {
    const holder = container.querySelector("small.grey");
    assert.ok(holder, "应为无操作行的反向好友项创建 tag 按钮容器");
    assert.equal(holder.children.at(-1).textContent, "tag");
  }
});

test("好友项缺失头像链接（无法确定用户标识）时跳过且不抛错", () => {
  const root = parseFragment(
    '<ul id="memberUserList"><li class="user"><div class="userContainer"><strong>无头像</strong></div></li></ul>',
    () => {}
  );
  const { document } = documentFromTree(root);

  assert.doesNotThrow(() =>
    core.initialize({
      document,
      location: { pathname: "/user/sai/friends" },
      gmInfo: { scriptMetaStr: "" },
    })
  );
  assert.equal(tagLinks(root).length, 0);
});

// ---- 点击闭环：prompt 预填 + 按用户标识保存 ----

test("点击 tag 弹出 prompt 预填现有标签；确认后按用户标识保存", () => {
  const page = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
    storeData: { puson_pp: ["旧标签"] },
    promptReturn: "  动画  监督  动画  ",
  });

  const container = containerWithAvatarHref(page.root, "/user/puson_pp");
  const tagLink = tagLinks(page.root).find((link) =>
    container.children.some(function has(node) {
      return node === link || (node.children && node.children.some(has));
    })
  );
  clickTag(tagLink);

  assert.equal(page.promptCalls.length, 1);
  assert.match(page.promptCalls[0].message, /标签/);
  assert.equal(page.promptCalls[0].defaultValue, "旧标签");
  assert.deepEqual(page.readStore()["puson_pp"], ["动画", "监督"]);

  // 再次点击时 prompt 预填的是刚保存的标签。
  clickTag(tagLink);
  assert.equal(page.promptCalls.length, 2);
  assert.equal(page.promptCalls[1].defaultValue, "动画 监督");
});

test("点击 tag：标识取自头像链接，数字与百分号编码标识均按规范解码保存", () => {
  const page = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
    promptReturn: "t",
  });

  for (const href of ["/user/614349", "/user/madoka_kaname"]) {
    const container = containerWithAvatarHref(page.root, href);
    const tagLink = tagLinks(page.root).find((link) =>
      container.children.some(function has(node) {
        return node === link || (node.children && node.children.some(has));
      })
    );
    clickTag(tagLink);
  }
  const store = page.readStore();
  assert.deepEqual(store["614349"], ["t"]);
  assert.deepEqual(store["madoka_kaname"], ["t"]);
});

test("prompt 取消（返回 null）时不修改存储", () => {
  const page = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
    storeData: { puson_pp: ["旧标签"] },
    promptReturn: null,
  });

  const tagLink = tagLinks(page.root)[0];
  clickTag(tagLink);
  assert.equal(page.promptCalls.length, 1);
  assert.deepEqual(page.readStore(), { puson_pp: ["旧标签"] });
});

test("同一好友在 friends 与 rev_friends 页面共享同一套标签（ADR-0002）", () => {
  const friendsPage = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
    promptReturn: " 共同好友 ",
  });
  clickTag(tagLinks(friendsPage.root)[0]);
  const saved = JSON.stringify(friendsPage.readStore());

  // 反向好友页以同一份 GM 存储数据重新加载。
  const revPage = makeUserscriptPage("rev_friends_logged.html", {
    pathname: "/user/sai/rev_friends",
    storeData: JSON.parse(saved),
  });
  const container = containerWithAvatarHref(revPage.root, "/user/puson_pp");
  const tagLink = tagLinks(revPage.root).find((link) =>
    container.children.some(function has(node) {
      return node === link || (node.children && node.children.some(has));
    })
  );
  clickTag(tagLink);
  assert.equal(revPage.promptCalls[0].defaultValue, "共同好友");
});

// ---- 标签栏面板：结构与渲染 ----

test("面板插入 .columns 内 columnUserSingle 之后的新右栏，仅双栏布局为新 CSS", () => {
  const page = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
    storeData: { puson_pp: ["动画", "监督"] },
  });

  const columns = columnsElement(page.root);
  const ids = elementChildren(columns).map((node) => node.attributes.id);
  assert.deepEqual(ids, ["columnUserSingle", "friendTagPanelColumn"]);

  const column = panelColumn(page.root);
  assert.ok(hasClass(column, "column"), "右栏应复用站内 .column 类");

  const panel = tagPanel(page.root);
  assert.equal(panel.attributes.style, "width:190px;", "复刻站内 SimpleSidePanel 宽度内联样式");

  // 唯一手写的新样式：双栏布局规则，注入 head。
  const styles = [...walkElements(page.root)].filter(
    (node) => node.tagName === "style"
  );
  assert.equal(styles.length, 1);
  assert.match(styles[0].textContent, /#friendTagPanelColumn\{[^}]*\}/);
});

test("标题「好友的标签」+ 右对齐 chiiBtn 重置；下方 chiiBtn 导出/导入", () => {
  const page = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
  });

  const panel = tagPanel(page.root);
  const heading = elementChildren(panel).find((node) => node.tagName === "h2");
  assert.equal(heading.children.at(-1), "好友的标签");
  const reset = elementChildren(heading)[0];
  assert.equal(reset.tagName, "a");
  assert.deepEqual(
    (reset.attributes.class ?? "").split(/\s+/).sort(),
    ["chiiBtn", "rr"]
  );
  assert.equal(reset.textContent, "重置");

  assert.equal(chiiButtonByLabel(page.root, "导出") !== null, true);
  assert.equal(chiiButtonByLabel(page.root, "导入") !== null, true);
});

test("面板渲染标签与计数、按数量降序、计数右对齐结构复刻站内 tagList", () => {
  const page = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
    storeData: {
      puson_pp: ["动画", "监督"],
      "614349": ["动画", "特摄"],
      madoka_kaname: ["动画"],
    },
  });

  const items = tagListItems(page.root);
  assert.deepEqual(
    items.map(({ tag, count }) => ({ tag, count })),
    [
      { tag: "动画", count: "3" },
      // 同计数按码元序稳定排序（特 U+7279 < 监 U+76D1）。
      { tag: "特摄", count: "1" },
      { tag: "监督", count: "1" },
    ]
  );
  for (const { link } of items) {
    assert.equal(link.getAttribute("href"), "#;");
    assert.equal(link.getAttribute("class"), "l");
    // 计数 small 在前，右对齐交给站内 .tagList li a small 的浮动规则。
    assert.equal(link.children[0].tagName, "small");
  }
});

test("计数与列表只聚合当前页面实际出现的好友", () => {
  const page = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
    storeData: { puson_pp: ["动画"], absent_user: ["动画"] },
  });
  assert.deepEqual(tagListItems(page.root).map((i) => i.tag), ["动画"]);
  assert.equal(tagListItems(page.root)[0].count, "1");
});

test("空状态显示 tip「暂无标签」而非空白，标题与按钮常驻", () => {
  const page = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
    storeData: {},
  });

  assert.deepEqual(tagListItems(page.root), []);
  const tip = emptyTip(page.root);
  assert.ok(tip, "应有「暂无标签」提示");
  assert.notEqual(tip.style.display, "none");
  assert.ok(tagPanel(page.root));
  assert.ok(chiiButtonByLabel(page.root, "重置"));
  assert.ok(chiiButtonByLabel(page.root, "导出"));
  assert.ok(chiiButtonByLabel(page.root, "导入"));
});

// ---- 标签栏面板：筛选 ----

test("单击标签进入选中态并只显示含该标签的好友项；再点同一标签取消", () => {
  const page = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
    storeData: {
      puson_pp: ["动画"],
      "614349": ["动画", "特摄"],
      madoka_kaname: ["特摄"],
    },
  });
  const [anime] = tagListItems(page.root);

  clickNode(anime.link);
  // 点击后面板列表重建，需重新查询当前节点。
  const selected = tagListItems(page.root);
  assert.equal(selected[0].tag, "动画");
  assert.equal(selected[0].link.getAttribute("class"), "l focus");
  assert.deepEqual(visibleHrefs(page.root), [
    "/user/614349",
    "/user/puson_pp",
  ]);

  clickNode(selected[0].link);
  const deselected = tagListItems(page.root);
  assert.equal(deselected[0].tag, "动画");
  assert.equal(deselected[0].link.getAttribute("class"), "l");
  assert.equal(visibleHrefs(page.root).length, listItemsByHref(page.root).size);
});

test("点击另一标签为单选切换筛选", () => {
  const page = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
    storeData: {
      puson_pp: ["动画"],
      "614349": ["动画", "特摄"],
      madoka_kaname: ["特摄"],
    },
  });
  const [anime] = tagListItems(page.root);

  clickNode(anime.link);
  const [, tokusatsu] = tagListItems(page.root);
  clickNode(tokusatsu.link);
  const [afterAnime, afterTokusatsu] = tagListItems(page.root);
  assert.equal(afterAnime.tag, "动画");
  assert.equal(afterAnime.link.getAttribute("class"), "l");
  assert.equal(afterTokusatsu.tag, "特摄");
  assert.equal(afterTokusatsu.link.getAttribute("class"), "l focus");
  assert.deepEqual(visibleHrefs(page.root), [
    "/user/614349",
    "/user/madoka_kaname",
  ]);
});

test("重置按钮清除筛选且恢复全部好友项；无筛选时点击无副作用", () => {
  const page = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
    storeData: { puson_pp: ["动画"], "614349": ["特摄"] },
  });
  const reset = chiiButtonByLabel(page.root, "重置");

  // 无筛选时：无任何可见变化，数据不变。
  clickNode(reset);
  assert.equal(visibleHrefs(page.root).length, listItemsByHref(page.root).size);
  assert.deepEqual(page.readStore(), { puson_pp: ["动画"], "614349": ["特摄"] });

  clickNode(tagListItems(page.root)[0].link);
  assert.deepEqual(visibleHrefs(page.root), ["/user/puson_pp"]);
  clickNode(reset);
  assert.equal(visibleHrefs(page.root).length, listItemsByHref(page.root).size);
  const [first] = tagListItems(page.root);
  assert.equal(first.link.getAttribute("class"), "l");
});
test("tag 按钮编辑后面板计数刷新，且当前筛选立即重新应用", () => {
  const page = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
    storeData: { puson_pp: ["动画"] },
    promptReturn: "动画",
  });
  const container = containerWithAvatarHref(page.root, "/user/614349");
  const tagLink = tagLinks(page.root).find((link) =>
    container.children.some(function has(node) {
      return node === link || (node.children && node.children.some(has));
    })
  );

  clickNode(tagListItems(page.root)[0].link);
  assert.deepEqual(visibleHrefs(page.root), ["/user/puson_pp"]);

  clickTag(tagLink); // 给 614349 也打上「动画」
  const [anime] = tagListItems(page.root);
  assert.deepEqual(
    { tag: anime.tag, count: anime.count },
    { tag: "动画", count: "2" }
  );
  // 筛选仍在选中态，新打上该标签的好友项立即变为可见。
  assert.deepEqual(visibleHrefs(page.root), [
    "/user/614349",
    "/user/puson_pp",
  ]);
});

// ---- 导出 / 导入 ----

test("导出：confirm 确认后下载原始 store 的 pretty JSON", async () => {
  const data = { puson_pp: ["动画", "监督"], "614349": [] };
  const page = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
    storeData: data,
  });

  clickNode(chiiButtonByLabel(page.root, "导出"));
  assert.equal(page.confirmCalls.length, 1);
  assert.equal(page.downloads.length, 1);
  const { filename, text } = page.downloads[0];
  assert.match(filename, /\.json$/);
  assert.deepEqual(JSON.parse(text), data);
  assert.ok(text.includes("\n"), "应为 pretty 打印的 JSON");
});

test("导出：confirm 取消后不下载且无任何变更", () => {
  const page = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
    storeData: { puson_pp: ["动画"] },
    confirmReturn: false,
  });
  clickNode(chiiButtonByLabel(page.root, "导出"));
  assert.equal(page.downloads.length, 0);
  assert.deepEqual(page.readStore(), { puson_pp: ["动画"] });
});

test("导入：合法 JSON 覆盖现有数据并刷新面板", async () => {
  const page = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
    storeData: { puson_pp: ["旧"], "614349": ["保留"] },
    readTextReturn: JSON.stringify({ puson_pp: ["新"], "614349": ["y"] }),
  });

  clickNode(chiiButtonByLabel(page.root, "导入"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.alertCalls.length, 0);
  // 文件是唯一事实来源：不在文件里的条目（madoka_kaname）被清除。
  assert.deepEqual(page.readStore(), {
    puson_pp: ["新"],
    "614349": ["y"],
  });
  assert.deepEqual(
    tagListItems(page.root).map(({ tag, count }) => ({ tag, count })),
    [
      { tag: "y", count: "1" },
      { tag: "新", count: "1" },
    ]
  );
});

test("导入：文件读取失败时 alert 提示且数据与面板不变（区别于取消）", async () => {
  const { document, root, mutations } = documentFromFixture("friends_logged.html");
  let serialized = JSON.stringify({ puson_pp: ["动画"] });
  const alertCalls = [];
  const runtime = core.initialize({
    document,
    location: { pathname: "/user/sai/friends" },
    gmInfo: { scriptMetaStr: "" },
    gmGetValue: () => serialized,
    gmSetValue: (key, value) => {
      serialized = value;
    },
    dialog: {
      confirm: () => true,
      alert: (message) => alertCalls.push(message),
    },
    files: {
      download() {},
      readText: () => Promise.reject(new Error("read failed")),
    },
  });
  assert.ok(runtime);

  clickNode(chiiButtonByLabel(root, "导入"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(alertCalls.length, 1);
  assert.deepEqual(JSON.parse(serialized), { puson_pp: ["动画"] });
  assert.deepEqual(
    tagListItems(root).map((item) => item.tag),
    ["动画"]
  );
});

test("导入：confirm 取消时不读取文件、数据与面板不变", async () => {
  const page = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
    storeData: { puson_pp: ["动画"] },
    confirmReturn: false,
    readTextReturn: JSON.stringify({ evil: [] }),
  });

  clickNode(chiiButtonByLabel(page.root, "导入"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.readTextCalls.length, 0);
  assert.deepEqual(page.readStore(), { puson_pp: ["动画"] });
  assert.deepEqual(tagListItems(page.root).map((i) => i.tag), ["动画"]);
});

test("导入：文件选择取消时数据与面板不变", async () => {
  const page = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
    storeData: { puson_pp: ["动画"] },
    readTextReturn: null,
  });

  clickNode(chiiButtonByLabel(page.root, "导入"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.alertCalls.length, 0);
  assert.deepEqual(page.readStore(), { puson_pp: ["动画"] });
});

test("导入：非法结构被拒绝、alert 提示、现有数据与面板不变", async () => {
  for (const text of [
    "not json{",
    "null",
    "[1, 2]",
    JSON.stringify({ a: "b" }),
    JSON.stringify({ a: [1] }),
  ]) {
    const page = makeUserscriptPage("friends_logged.html", {
      pathname: "/user/sai/friends",
      storeData: { puson_pp: ["动画"] },
      readTextReturn: text,
    });
    const panelBefore = tagListItems(page.root).map((i) => i.tag);

    clickNode(chiiButtonByLabel(page.root, "导入"));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(page.alertCalls.length, 1, `应 alert：${text}`);
    assert.deepEqual(page.readStore(), { puson_pp: ["动画"] });
    assert.deepEqual(
      tagListItems(page.root).map((i) => i.tag),
      panelBefore
    );
  }
});

test("导入后选中的筛选标签不存在时自动清除筛选", async () => {
  const page = makeUserscriptPage("friends_logged.html", {
    pathname: "/user/sai/friends",
    storeData: { puson_pp: ["动画"] },
    readTextReturn: JSON.stringify({ "614349": ["特摄"] }),
  });

  clickNode(tagListItems(page.root)[0].link);
  assert.deepEqual(visibleHrefs(page.root), ["/user/puson_pp"]);

  clickNode(chiiButtonByLabel(page.root, "导入"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(visibleHrefs(page.root).length, listItemsByHref(page.root).size);
  assert.deepEqual(tagListItems(page.root).map((i) => i.link.getAttribute("class")), ["l"]);
});

// ---- 组件模式：cloud_settings 后端（#5）----

test("组件模式首次加载：无缓存时等待云端数据渲染，云端到达后出现标签", async () => {
  const page = makeComponentPage("friends_logged.html", {
    cloudData: { puson_pp: ["动画"], "614349": ["动画", "特摄"] },
  });

  // 云端数据尚未应用：面板为空状态。
  assert.deepEqual(tagListItems(page.root), []);

  await page.flush();
  assert.deepEqual(
    tagListItems(page.root).map(({ tag, count }) => ({ tag, count })),
    [
      { tag: "动画", count: "2" },
      { tag: "特摄", count: "1" },
    ]
  );
});

test("组件模式首次加载：有缓存时先按缓存渲染，云端到达后以云端为准刷新", async () => {
  const page = makeComponentPage("friends_logged.html", {
    cloudData: { puson_pp: ["新"] },
    cacheData: { puson_pp: ["旧"], "614349": ["特摄"] },
  });

  // 缓存优先：未让出事件循环前就已按缓存渲染。
  assert.deepEqual(
    tagListItems(page.root).map((item) => item.tag),
    ["旧", "特摄"]
  );

  await page.flush();
  // 未编辑的标识以云端为准：puson_pp 改为「新」；云端没有的 614349 条目删除。
  assert.deepEqual(
    tagListItems(page.root).map(({ tag, count }) => ({ tag, count })),
    [{ tag: "新", count: "1" }]
  );
  // 合并产生变更 → 回写云端 + 缓存同步为合并结果。
  const lastUpdate = page.cloud.calls.update.at(-1);
  assert.deepEqual(lastUpdate[core.CLOUD_SETTINGS_KEY], { puson_pp: ["新"] });
  assert.deepEqual(cachedTags(page.storage), { puson_pp: ["新"] });
});

test("合并方向：本地编辑过的用户标识保留本地值，其余以云端为准（ADR-0001）", async () => {
  const page = makeComponentPage("friends_logged.html", {
    cacheData: { puson_pp: ["旧"], "614349": ["缓存"] },
    cloudOptions: { defer: true },
  });

  // 云端数据到达前编辑 puson_pp。
  page.dialog.prompt = () => "本地新标签";
  clickTag(tagLinkFor(page.root, "/user/puson_pp"));

  page.cloud.deferred.resolve({
    puson_pp: ["云端值"],
    "614349": ["云端保留"],
    madoka_kaname: ["云端新增"],
  });
  await page.flush();

  const merged = cachedTags(page.storage);
  assert.deepEqual(merged, {
    puson_pp: ["本地新标签"],
    "614349": ["云端保留"],
    madoka_kaname: ["云端新增"],
  });
  // 合并产生变更 → 回写云端（update + save）。
  const lastUpdate = page.cloud.calls.update.at(-1);
  assert.deepEqual(lastUpdate[core.CLOUD_SETTINGS_KEY], merged);
  assert.ok(page.cloud.calls.save >= 2, "编辑与合并回写各触发一次 save");
});

test("编辑标签后：update + save 写入云端，localStorage 缓存与云端数据结构一致", async () => {
  const page = makeComponentPage("friends_logged.html", { cloudData: {} });
  await page.flush();

  page.dialog.prompt = () => "动画 监督 动画";
  clickTag(tagLinkFor(page.root, "/user/puson_pp"));

  assert.deepEqual(page.cloud.calls.update, [
    { [core.CLOUD_SETTINGS_KEY]: { puson_pp: ["动画", "监督"] } },
  ]);
  assert.equal(page.cloud.calls.save, 1);
  assert.deepEqual(
    cachedTags(page.storage),
    page.cloud.data[core.CLOUD_SETTINGS_KEY]
  );
});

test("编辑为空时清除该好友全部标签：云端映射中删除该键", async () => {
  const page = makeComponentPage("friends_logged.html", {
    cloudData: { puson_pp: ["旧"] },
  });
  await page.flush();

  page.dialog.prompt = () => "   ";
  clickTag(tagLinkFor(page.root, "/user/puson_pp"));
  await page.flush();

  assert.deepEqual(page.cloud.data[core.CLOUD_SETTINGS_KEY], {});
  assert.deepEqual(cachedTags(page.storage), {});
  assert.deepEqual(tagListItems(page.root), []);
});

test("云端读取抛错时跳过合并：本地数据保留、不回写、不抛错", async () => {
  const page = makeComponentPage("friends_logged.html", {
    cacheData: { puson_pp: ["旧"] },
    cloudOptions: { getThrows: true },
  });

  await page.flush();
  assert.deepEqual(
    tagListItems(page.root).map((item) => item.tag),
    ["旧"]
  );
  assert.equal(page.cloud.calls.update.length, 0);
  assert.equal(page.cloud.calls.save, 0);
  assert.deepEqual(cachedTags(page.storage), { puson_pp: ["旧"] });
});

test("云端数据结构非法时跳过合并不回写", async () => {
  const page = makeComponentPage("friends_logged.html", {
    cacheData: { puson_pp: ["旧"] },
    cloudData: { sai: "not-an-array" },
  });

  await page.flush();
  assert.deepEqual(
    tagListItems(page.root).map((item) => item.tag),
    ["旧"]
  );
  assert.equal(page.cloud.calls.update.length, 0);
});

test("云端读取返回 JSON 字符串时也能解析合并（防御序列化往返）", async () => {
  const page = makeComponentPage("friends_logged.html", {
    cloudOptions: {
      rawValue: JSON.stringify({ puson_pp: ["动画"] }),
    },
  });

  await page.flush();
  assert.deepEqual(
    tagListItems(page.root).map(({ tag, count }) => ({ tag, count })),
    [{ tag: "动画", count: "1" }]
  );
});

test("localStorage 缓存损坏时按无缓存处理，等待云端数据渲染", async () => {
  const page = makeComponentPage("friends_logged.html", {
    cloudData: { puson_pp: ["动画"] },
    rawCache: "not-json{",
  });

  assert.deepEqual(tagListItems(page.root), []);
  await page.flush();
  assert.deepEqual(
    tagListItems(page.root).map((item) => item.tag),
    ["动画"]
  );
});

// ---- 浏览器自动初始化 ----

test("浏览器环境自动初始化：无 GM_info 与 chiiApp 时静默退出且不修改 DOM", () => {
  const { document, mutations } = documentFromFixture("friends.html");
  // 沙箱无 module：若导出分支被误执行会抛出 ReferenceError。
  vm.runInNewContext(fs.readFileSync(SOURCE_PATH, "utf8"), {
    document,
    location: { pathname: "/user/sai/friends" },
  });
  assert.deepEqual(mutations, []);
});

test("浏览器环境自动初始化：GM_info 存在时为每个好友创建 tag 按钮", () => {
  const { document, root, mutations } = documentFromFixture("friends.html");
  vm.runInNewContext(fs.readFileSync(SOURCE_PATH, "utf8"), {
    document,
    location: { pathname: "/user/sai/friends" },
    GM_info: { scriptName: "test" },
  });
  const containers = userContainers(root);
  assert.equal(tagLinks(root).length, containers.length);
  assert.ok(mutations.length > 0);
});
