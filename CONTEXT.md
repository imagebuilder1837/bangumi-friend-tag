# Bangumi 好友标签

为 Bangumi 好友页与反向好友页提供好友标签的添加、展示与筛选能力的超合金组件。

## Language

**好友（Friend）**：
登录账号关注的用户，出现在 `/user/*/friends` 页面。
_Avoid_: 朋友、关注

**反向好友（Reverse Friend）**：
关注登录账号的用户，出现在 `/user/*/rev_friends` 页面。
_Avoid_: 粉丝、被关注

**用户标识（User Identifier）**：
Bangumi 用户的唯一标识，可能是数字或字符串，即 `/user/{标识}` 路径段。好友以用户标识索引。
_Avoid_: uid、ID、用户名（用户名可改，不作为标识）、昵称（仅用于显示）

**好友标签（Friend Tag）**：
用户附加到某个好友上的词，一个好友可有多个标签。
_Avoid_: 分类、分组

**好友标签数据（Friend Tag Store）**：
某登录账号对其所有好友的全部标签集合，全局仅一份，不按页面所有者区分。
_Avoid_: 标签缓存、配置
