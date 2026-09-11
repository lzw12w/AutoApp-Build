---
name: para-mobile
description: 用自然语言驱动插在这台电脑上的 iOS / Android 真机 App——点按滑动输入、读界面结构、取 A/B 分组与 feature flag、看网络请求与崩溃日志。用户提到真机、iPhone、安卓设备、App 内某个页面、线上包的实验值、界面为什么长这样、点不动、页面没跳转时使用。不用于模拟器 UI 测试框架（XCUITest / Espresso）、不用于纯网页自动化。
---

# para-mobile

`para` 是一个已装好的 CLI，通过 USB 直连真机上的 Inspector，能看界面、能操作、能读 App 内部状态。

先确认环境，再动手：

```bash
para doctor --json
```

`result.ok` 为 true 才能继续。`devices` 数组是当前所有连接的设备——
多于一台时后续每条命令都要带 `--device <id>`；`ready:false` 表示插着但
未配对（iOS）或未授权（Android），要用户在设备上点信任。

## 两种用法，按你是否已经知道要点什么来选

**你不知道界面长什么样、要多步摸索 → 交给 para 自己判断：**

```bash
para exec -m "打开搜索页，输入'测试'，告诉我结果有几条"
```

它内部有跨会话累积的页面图谱和一套工具选择经验，会自己决定看几次、点哪里。
花模型 token，但你不用管细节。

**你已经明确知道要什么 → 直接调工具，不花模型 token：**

```bash
para call screen_digest
para call ab_experiments --limit 5
para call tap_with_diff --accessibility_id discovery.searchBox
```

先 `para call --list` 看有哪些，再 `para call <tool> --help` 看某一个的参数。
不必一开始全读——需要哪个再看哪个。

## 多轮：让连续几次 exec 共享上下文

```bash
para exec -m "打开个人主页" --continue
para exec -m "刚才那个页面，头像是圆的还是方的？" --continue
```

`--continue` 接最近一次会话。第二条能答出来是因为它记得上一轮看到的界面，
不会重新去问设备。

要精确控制接哪一段用 `--session-id <你起的名字>`。注意 id 是自己起的，
所以返回值里若出现 `session_resumed`，说明你接上了一段已有对话——
核对它的 `created` 和 `turns`，确认不是别人的。

## 用 call 操作界面时，这些经验能省很多来回

**先看再动。** 直接点一个没核实过的目标，失败率很高。

**看界面用哪个工具，取决于你要做什么，不是取决于哪个便宜：**

- **要点 / 滑 / 输入**（绝大多数情况）→ `screen_digest`。
  纯文本、按阅读顺序、已排除隐藏和屏幕外节点。界面复杂也不要换成
  `view_hierarchy`，digest 就是为这种情况设计的。
- **查布局问题**（位置偏了、字号不对、颜色不符）→ `view_hierarchy --depth 8`，
  再对可疑节点 `view_inspect --address <hex>`。
  `screen_digest` 故意丢掉了几何和样式信息，不能用来对比设计稿。
- **只想知道当前是哪个页面** → `vc_hierarchy`，最省。

**拿到目标后，优先用 `aid=` 而不是十六进制地址。**
`screen_digest` 的输出里若某行带 `aid=discovery.searchBox`，就把这个字符串
传给 `--accessibility_id`。它在界面重排后依然有效，而 hex 地址会变。
行首的 `@12` 只是这次快照里的编号，任何时候都不要当参数传。

**tab 的 title 常常是没翻译的 key**（形如 `TabBarItem_AccessibilityLabel`），
不要拿它传给 `switch_tab --title`，用 `--index` 或 `--accessibility_id`。

**点完不用马上再看一次。** 点按类工具的返回值里已经带了 `post_check`，
说明界面变了没有。只有当你确实需要看新页面上有什么时，才再调一次
`screen_digest`。

**点了没反应时，先查目标存不存在，而不是重复点：**

```bash
para call find_view --text 登录 --max_results 5
```

返回 `count: 0` 说明当前页面就没有这个东西——可能上一步的跳转没成功，
或者它在需要滚动才可见的位置。

## 别处拿不到的：App 内部状态

通用的手机自动化工具只能看界面。这几个能读到 App 里面：

```bash
para call ab_experiments          # 当前命中的 A/B 实验分组
para call feature_flags           # feature flag 开关状态
para call user_defaults --prefix sa_   # 本地存储
para call network_log --limit 20   # 最近的网络请求
para call console_log --limit 50   # 控制台 / 崩溃日志
```

"这个功能为什么没生效"这类问题，看 flag 和实验分组通常比看界面直接。

## 判断结果

所有命令都输出 JSON。`ok` 为 true 才算成功。常见 `code`：

| code | 含义 | 怎么办 |
|---|---|---|
| `device_unavailable` | 设备没连上或 App 没在前台 | 跑 `para doctor --json` 看 `devices` |
| `tool_error` | 工具本身失败，`error` 里有原因 | 常见是 `E_TARGET_NOT_FOUND`，用 `find_view` 核实目标 |
| `model_not_found` | 模型配置不对（只影响 `exec`） | 跑 `para models` 看哪个可用 |
| `tool_not_callable` | 该工具只在 `exec` 会话里有意义 | 改用 `para exec` |

`exec` 的返回值里 `step_count` 为 0 值得警惕：说明它一个工具都没调，
往往是设备或配置有问题，不是任务真的不需要操作。

## 边界

- 改变界面的操作（点、滑、输入、切 tab）会真的动用户的 App。执行破坏性操作
  （删除、退出登录、支付）前先跟用户确认。
- `set_lane`（切环境）、`appoint_feed_story`（指定信息流内容）会影响这台设备
  后续的测试状态，用之前说明清楚。
- 一次 `para exec` 可能跑几十秒到几分钟。若在有超时限制的环境里调用，
  给到 300 秒以上；要更快就用 `para call` 单步执行。
