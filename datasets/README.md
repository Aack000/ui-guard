# 验收数据集

用途：给下一版规则 / 模型做训练与回归。**只保存脱敏标注，不保存其他项目的截图、文案或业务数据。**

## 结构

- `../fixtures/`：受控样本（44 条断言，已提交）。
- `labels.jsonl`：真实页面标注，一行一条。
- `raw/`：原始扫描 JSON / 截图（本地保留，不提交，`.gitignore`）。

## labels.jsonl 字段

| 字段 | 含义 |
|---|---|
| `id` | 标注 ID |
| `source` | 项目代号（P1、P2…），不含真实项目名 / URL |
| `viewport` | 视口宽度 |
| `state` | `baseline` 或交互状态（如 `click:products`） |
| `rule` | H1 / H1c / H2 / H3 / H4 / H4-partial / H5 / S1–S8 / P1 |
| `selector` | 脱敏后的元素选择器 |
| `label` | `true` = 真问题；`false` = 误报 / 应豁免 |
| `note` | 实测数据或判断原因 |

## 使用

- 训练 / 评估：按 `rule + label` 统计精确率、召回率。
- 回归：新增规则前先跑 `labels.jsonl` 里的负样本，误报不能增加。
- 原始数据只放 `raw/`，不进入 git。
- 项目代号到真实项目的映射只保留在本地，不写入仓库。
