# Fixtures

来自 bgm.tv 的真实页面 HTML，供 `test/index.test.js` 构造只响应源码所用
选择器的最小 DOM 桩（做法模仿 bangumi-friend-sorter）。

| 文件 | 来源 | 抓取方式 |
| --- | --- | --- |
| `friends.html` | `https://bgm.tv/user/sai/friends` | 未登录 GET（2025-09） |
| `rev_friends.html` | `https://bgm.tv/user/sai/rev_friends` | 未登录 GET（2025-09） |
| `friends_logged.html` | `https://bgm.tv/user/imagebuilder183/friends` | 登录态 GET（人工抓取，仓库作者本人页面） |
| `rev_friends_logged.html` | `https://bgm.tv/user/imagebuilder183/rev_friends` | 登录态 GET（人工抓取，仓库作者本人页面） |

未登录 fixture 的好友项中没有「PM / del」操作行，等价于「他人的页面」的
DOM 形态（tag 按钮独立创建）；登录态 fixture 含操作行，覆盖「自己的
friends 页（PM / del）」与「自己的 rev_friends 页（del）」两种形态。

已知限制：登录态 fixture 均为仓库作者本人页面，「未登录 ≈ 他人页面」
的等价假设未在真实登录态他人页上验证过；登录态他人页 fixture 待人工
抓取补充。
