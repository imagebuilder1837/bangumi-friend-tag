# Fixtures

来自 bgm.tv 的真实页面 HTML，供 `test/index.test.js` 构造只响应源码所用
选择器的最小 DOM 桩（做法模仿 bangumi-friend-sorter）。

| 文件 | 来源 | 抓取方式 |
| --- | --- | --- |
| `friends.html` | `https://bgm.tv/user/sai/friends` | 未登录 GET（2025-09） |
| `rev_friends.html` | `https://bgm.tv/user/sai/rev_friends` | 未登录 GET（2025-09） |

注意：抓取时**未登录**，因此好友项中不含「PM / del」操作行。后续工单若
需要依赖这些操作行的选择器（tag 按钮插入位置），需要人工提供登录态的
真实页面 HTML 更新 fixture。
