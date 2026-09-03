const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const core = require("../src/index.user.js");

const SOURCE_PATH = path.join(__dirname, "..", "src", "index.user.js");

// 手写最小 DOM 桩（模仿 bangumi-friend-sorter）：从真实页面 fixture 构造，
// 只记录源码施加的修改操作，不模拟真实 DOM。源码使用的选择器必须在桩上
// 显式声明响应，未声明的选择器一律断言失败，避免测试与实现静默漂移。
// 骨架阶段源码尚未查询任何选择器，桩的 querySelector/querySelectorAll
// 因此一律失败；后续工单随源码引入选择器时在此显式添加响应。
class StubElement {
  constructor(tagName, record) {
    this.tagName = tagName;
    this.children = [];
    this.#record = record;
  }

  #record;

  append(...nodes) {
    this.#record("append", { tagName: this.tagName, count: nodes.length });
    for (const node of nodes) this.children.push(node);
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
}

function documentFromFixture(filename) {
  const html = fs.readFileSync(path.join(__dirname, "fixtures", filename), "utf8");
  // fixture 自检：确认内容确为好友/反向好友页结构。
  assert.match(html, /id=["']memberUserList["']/);

  const mutations = [];
  const record = (kind, detail) => mutations.push({ kind, ...detail });
  const document = {
    createElement(tagName) {
      record("createElement", { tagName });
      return new StubElement(tagName, record);
    },
    createTextNode(data) {
      record("createTextNode", { data });
      return { data };
    },
    querySelector(selector) {
      assert.fail(`源码使用了未在桩中声明的选择器：${selector}`);
    },
    querySelectorAll(selector) {
      assert.fail(`源码使用了未在桩中声明的选择器：${selector}`);
    },
  };
  return { document, mutations };
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

test("core 仅暴露 initialize 依赖注入入口", () => {
  assert.deepEqual(Object.keys(core), ["initialize"]);
  assert.equal(typeof core.initialize, "function");
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

test("存在 chiiApp.cloud_settings 时判定为组件模式", () => {
  const { document } = documentFromFixture("rev_friends.html");
  const runtime = core.initialize({
    document,
    location: { pathname: "/user/2/rev_friends" },
    chiiApp: cloudSettingsStub(),
  });
  assert.deepEqual(runtime, {
    mode: "component",
    page: { section: "rev_friends", ownerIdentifier: "2" },
  });
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
  const { document } = documentFromFixture("friends.html");
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
  // 桩的 querySelector/querySelectorAll 遇未声明选择器即断言失败，
  // 走到这里说明源码从未查询页面。
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

test("浏览器环境自动初始化：无 GM_info 与 chiiApp 时静默退出且不修改 DOM", () => {
  const { document, mutations } = documentFromFixture("friends.html");
  // 沙箱无 module：若导出分支被误执行会抛出 ReferenceError。
  vm.runInNewContext(fs.readFileSync(SOURCE_PATH, "utf8"), {
    document,
    location: { pathname: "/user/sai/friends" },
  });
  assert.deepEqual(mutations, []);
});

test("浏览器环境自动初始化：GM_info 存在时正常启动且骨架阶段不修改 DOM", () => {
  const { document, mutations } = documentFromFixture("friends.html");
  vm.runInNewContext(fs.readFileSync(SOURCE_PATH, "utf8"), {
    document,
    location: { pathname: "/user/sai/friends" },
    GM_info: { scriptName: "test" },
  });
  assert.deepEqual(mutations, []);
});
