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
  }

  appendChild(node) {
    this.#record("appendChild", { tagName: this.tagName });
    this.children.push(node);
    return node;
  }

  insertBefore(node) {
    this.#record("insertBefore", { tagName: this.tagName });
    this.children.unshift(node);
    return node;
  }

  remove() {
    this.#record("remove", { tagName: this.tagName });
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

// 从 fixture 构造 document 桩；root 是解析出的 memberUserList 子树根。
function documentFromFixture(filename) {
  const html = fs.readFileSync(
    path.join(__dirname, "fixtures", filename),
    "utf8"
  );
  // fixture 自检：确认内容确为好友/反向好友页结构。
  assert.match(html, /id=["']memberUserList["']/);
  const blockMatch = /<ul id="memberUserList"[\s\S]*?<\/ul>/.exec(html);
  assert.ok(blockMatch, `fixture ${filename} 中 memberUserList 未闭合`);

  const root = parseFragment(blockMatch[0], () => {});
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
  for (const listener of link.clickListeners) listener({ preventDefault() {} });
}

// 构造一次完整的用户脚本模式初始化：GM 存储由内存字符串模拟，prompt 桩
// 可编程返回值并记录调用。
function makeUserscriptPage(fixtureName, { pathname, storeData = {}, promptReturn } = {}) {
  const { document, root, mutations } = documentFromFixture(fixtureName);
  let serialized = JSON.stringify(storeData);
  const gmGetValue = () => serialized;
  const gmSetValue = (key, value) => {
    serialized = value;
  };
  const promptCalls = [];
  const dialog = {
    prompt(message, defaultValue) {
      promptCalls.push({ message, defaultValue });
      return promptReturn;
    },
  };
  const runtime = core.initialize({
    document,
    location: { pathname },
    gmInfo: { scriptMetaStr: "" },
    gmGetValue,
    gmSetValue,
    dialog,
  });
  return {
    runtime,
    root,
    mutations,
    promptCalls,
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

// ---- core API 与运行环境判定 ----

test("core 暴露 initialize、normalizeTags、createUserScriptStore", () => {
  assert.deepEqual(Object.keys(core).sort(), [
    "createUserScriptStore",
    "initialize",
    "normalizeTags",
  ]);
  assert.equal(typeof core.initialize, "function");
  assert.equal(typeof core.normalizeTags, "function");
  assert.equal(typeof core.createUserScriptStore, "function");
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

test("存在 chiiApp.cloud_settings 时判定为组件模式且不修改页面 DOM", () => {
  const { document, mutations } = documentFromFixture("rev_friends.html");
  const runtime = core.initialize({
    document,
    location: { pathname: "/user/2/rev_friends" },
    chiiApp: cloudSettingsStub(),
  });
  assert.deepEqual(runtime, {
    mode: "component",
    page: { section: "rev_friends", ownerIdentifier: "2" },
  });
  // 组件模式的 cloud_settings 后端未落地前不安装按钮，避免内存后端
  // 造成「能编辑但刷新即丢」的体验（后续工单启用）。
  assert.deepEqual(mutations, []);
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
