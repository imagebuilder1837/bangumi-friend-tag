# chiiApp.cloud_settings 平台知识

Bangumi 超合金组件的云端存储 API。本文供 agent 与开发者共享，避免重新调研。

来源：<https://bangumi.tv/group/topic/435662>（2025 年调研）。若本文与该帖或实际行为冲突，以实际行为为准并更新本文。

## API

组件沙箱内可用 `chiiApp.cloud_settings`：

```js
chiiApp.cloud_settings.update({ key: value, key2: value2 }); // 合并写入指定键
chiiApp.cloud_settings.getAll();                              // 读取全部设置
chiiApp.cloud_settings.get('key');                            // 读取指定键
chiiApp.cloud_settings.delete('key');                         // 删除键
chiiApp.cloud_settings.save();                                // 手动触发保存
```

- 若设置项加入了个性化面板（`/settings/gadgets`），关闭面板时 Bangumi **自动保存**；否则需手动调用 `save()`。
- 每个组件有专属字段，组件间数据默认隔离；数据跟随组件启用状态。
- 底层字段为 MEDIUMTEXT（上限 16MB），且**每次页面载入都会全量下发**——避免存大字符串。
- 读取当前用户其他组件的设置需用 `chiiLib.cloud_settings` 下的方法。

## 序列化行为（重要）

存入的值会被**字符串化**，但保留嵌套对象结构、嵌套对象内的值也会变字符串：

```js
.update({ answer: 42, deeper: { answer: true } })
.save()
// 刷新后读取：
// { answer: "42", deeper: { answer: "true" } }
```

字符串数组的元素本身就是字符串，可安全往返；数字键会被转成字符串键。

## 已知坑（截至调研时）

1. **无法删除最后一个 key**：删除后保存并刷新会重新出现。设计 schema 时保证永远至少保留一个键。
2. **`save()` 无 callback / 无 promise**：保存失败无从感知，不要依赖保存成功的确认。
3. **组件的 `@match` 语义与油猴标准不同**：search params 会被算进匹配，通配需写成 `...*` 结尾。

## 本项目的使用约定

见 ADR-0001：单键存储整张好友标签映射，localStorage 缓存优先渲染，后台刷新后按好友条目合并回写。
