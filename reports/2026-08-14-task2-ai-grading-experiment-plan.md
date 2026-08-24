# IELTS Task 2 AI 批改实验：需求基线、数据入库与模型方案

日期：2026-08-15

> 2026-08-15 更新：最新完整实验方案与数据盘点已输出到 Codex deliverables；本文件保留为仓库内实施摘要。题库 981 条已经正式入库，修正后的 Excel/Word manifest 暂作为 V2 staging，等待 canonical question/family 字段后激活。

## 1. 已冻结的产品需求

当前只做 IELTS Writing Task 2，不处理 Task 1，也暂不处理小程序端。

批改页采用多个 Tab。每个 Tab 的主要布局一致：左侧约 3/4 显示学生原文，右侧约 1/4 显示 AI 分析。

首期至少包括：

1. 全文四维评价：Task Response（TR）、Coherence and Cohesion（CC）、Lexical Resource（LR）、Grammatical Range and Accuracy（GRA）。
2. 段落四维评价：每段分别展示 TR、CC、LR、GRA 教学诊断。
3. 句子四维评价：每句分别展示 TR、CC、LR、GRA 的适用性、问题、证据和建议。
4. 句子多层 rewrite：按句显示，而不是只展示一篇整篇改写。
5. 评价与原文证据关联：点击右侧评价，左侧对应句子或短语高亮，并用连线连接两侧。
6. 所有层级都必须能够追溯到稳定的 paragraphId、sentenceId 和字符区间，不依赖前端模糊搜索。

重要口径：IELTS 官方分数是对完整任务的评价。段落和句子可以做四维教学诊断，但不应把“句子 TR 7 分”包装成官方意义的 band score。建议段落/句子使用 `表现良好 / 可改进 / 主要问题 / 不适用` 加置信度，整篇才显示四项 0–9、0.5 步长的估分。

## 2. 本轮数据结果

### Excel 实验数据

- 文件：97
- 可正常解析：97
- 可直接用于训练侧 RAG：74
- 固定留出集：22，已设置 `allowedForRag=false`
- 待人工复核：1（xc18 含 a/b 两版），已设置 `allowedForRag=false`
- 句子：1,429；每句四维完整，共 5,716 条句级四维评价
- 数据库 V1 chunks：4,568
- 数据库 V1 annotations：11,193
- 数据库 V1 已精确解析到原文字符区间的 annotations：9,680

Excel 标签的真实来源无法统一证明为 IELTS 考官或人工教师，因此当前标为 AI-assisted/unknown-authority 实验标签，不将其宣称为 teacher gold。

### Word 数据

- 有效文件：103（另跳过一个 `.~` 临时锁文件）
- Task 2：99；明确 Task 1：2
- 完整范文：76；不完整范文：18；多篇/多版本文件：7
- 可按明确 scope 进入 RAG：87；重复文本只启用一份
- 不完整范文允许用于语言/段内逻辑，题目明确时可用于 TR；只有完整范文可用于 full-essay scope

文件名中的“9分”等字样只作为来源元数据，不自动写成可信 band 标签；内容不完整时不由 AI 猜写缺失部分。

### 数据治理规则

1. `allowedForRag=false` 的文档永远不能进入提示词。
2. holdout 可以入库用于审计和评测，但不能被检索。
3. 不完整或多作文 Word 文档不得自动拼接成一篇完整作文。
4. 范文只能用于结构、表达和 rewrite 参考，不能直接证明学生作文得分。
5. 每次导入记录文件 hash、解析器版本和批次；重复运行不得重复写入。
6. 原始文本、清洗后文本、句子 ID、字符 offset、标签来源和置信度必须可追溯。

## 3. 推荐的 RAG 结构

不要把所有资料混在一个向量池里只做一次 top-k。至少分成四个证据通道：

1. `RUBRIC`：官方 Task 2 band descriptors 和 key assessment criteria。评分时优先级最高。
2. `ANNOTATION`：实验 Excel 中的句子/短语问题、解释、建议和 rewrite。
3. `TEACHER_CONTEXT`：全文和段落层面的讲解、Teaching note、Expansion。
4. `MODEL_REFERENCE`：已确认完整的范文，只支持结构、展开和表达参考。

每个检索请求先过滤：`task=TASK2`、`allowedForRag=true`、scope、dimension、subtype，再做关键词 + embedding 混合排序和去重。每条进入提示词的证据都记录 sourceDocumentId、chunkId、retrieval score、rank 和使用阶段。

建议使用 `text-embedding-3-large` 做第一版 embedding 基线，并保留当前关键词检索作为对照组。最终是否采用 OpenAI 托管 vector store 或现有 MySQL 自建索引，应由召回评测决定；当前数据库已经具备按文档质量、任务和内容角色过滤的优势。

## 4. 模型流水线

### Stage 0：确定性预处理

由代码完成，不交给模型：

- 题目清洗、题型识别、字数和格式检查
- paragraphId、sentenceId、startOffset、endOffset
- 确定性语法/拼写候选信号（只作为候选，不能直接判分）
- RAG 查询构造和证据通道过滤

### Stage 1：四维独立全文分析

TR、CC、LR、GRA 分成四个独立判断任务，避免一个维度的强弱形成 halo effect。每个任务只能依据官方对应维度规则评分，同时返回：

- band estimate
- descriptor matches / mismatches
- evidenceSentenceIds
- concise rationale
- confidence
- uncertaintyReasons

整体 band 由确定性代码按照四项等权平均计算，并按 IELTS 允许的档位处理；模型不得凭感觉另给一个不一致总分。

### Stage 2：段落诊断

每段输出四维教学诊断，但不声称为官方段落 band。每个评价必须引用当前段或必要的跨段证据 sentenceId，覆盖：段落功能、中心句、展开、例证、逻辑顺序、衔接、词汇和语法模式。

### Stage 3：句子诊断

每句输出四个维度槽位：`GOOD / IMPROVE / MAJOR_ISSUE / NOT_APPLICABLE`。所有局部问题必须返回精确 anchor：

- sentenceId
- anchorText（必须是原句子串）
- startOffset / endOffset
- occurrence
- issueType / severity
- explanation / suggestion

若 TR 或 CC 在某个孤立句子上不适合判断，应明确返回 `NOT_APPLICABLE`，而不是编造问题。

### Stage 4：三种正交的逐句 rewrite

三种 rewrite 不是“从差到好的润色等级”，而是分别处理不同问题；必须独立判断是否适用，不能因为语言差就推断偏题，也不能因为语言好就推断 TR 正确。某层没有问题时返回 `NOT_NEEDED`，不为了凑齐三版而改写：

1. `LANGUAGE_LAYER`：语言层，只处理 GRA/LR，包括语法、拼写、搭配、用词精度和自然度；不得改变句子承担的论证功能或立场。
2. `INTRA_PARAGRAPH_LOGIC_LAYER`：段内逻辑层，结合本段其他句子处理句间承接、指代、因果缺口、中心偏移、信息顺序和重复；允许重组本句或建议与相邻句合并/拆分，但不得自行改变全文立场。
3. `TASK_RESPONSE_LAYER`：TR 层，结合题目、全文立场和段落功能处理偏题、答题不完整、概念偷换、立场不一致、论点相关性与展开不足；若需要改变或补充命题内容，必须显式标注 `meaningChanged=true` 和 `newClaimIntroduced=true`，不能伪装成普通语言润色。

每层都返回 `applicability`、`changedSpans`、`reason`、`evidenceSentenceIds`、`meaningPreserved`、`meaningChanged`、`newClaimIntroduced`。验证器拒绝无必要堆砌生僻词、把语言问题误判成 TR 问题、改变立场却不披露、或引入未经原文支持事实的改写。

### Stage 5：独立复核与修复

使用独立 judge 检查：

- 四项分数是否与证据和 descriptor 一致
- 全文、段落、句子结论是否矛盾
- 锚点是否真实存在且区间正确
- 是否漏掉高影响问题，或制造不存在的问题
- rewrite 是否保留原意
- RAG 证据是否真的支持结论

代码先做 schema、enum、offset、重复项和平均分校验；只有语义问题才回到模型修复。

## 5. CoT 的正确落地方式

不在提示词中要求“逐步展示思维过程”，也不把原始 hidden chain-of-thought 存入数据库或展示给学生。

使用推理模型的内部 reasoning，再要求它输出可核验的结构化决策记录：

- criterion
- judgment
- evidenceIds
- shortRationale
- confidence
- alternativeConsidered（可选，简短）

这满足批改可解释性，同时避免把冗长、不稳定、不可验证的内部推理误当成产品内容。

## 6. API 与模型基线

质量优先的第一版建议：

- API：OpenAI Responses API
- 全文四维 scorer：`gpt-5.6-sol`，`reasoning.effort=high`
- 最终 judge：`gpt-5.6-sol`，先比较 `xhigh` 与 `max`；只有 eval 证明有收益才使用 pro mode
- 段落/句子诊断：第一轮也用 `gpt-5.6-sol`，建立质量上限；之后再比较 Terra
- embedding：`text-embedding-3-large`
- 输出：每个 stage 使用独立、严格的 JSON Schema Structured Outputs

当前 provider 仍使用 `/chat/completions` + `json_object`。正式实验前应新增原生 OpenAI Responses provider，而不是破坏现有 OpenAI-compatible/DeepSeek provider；两条 provider 路径都保留，方便做同题 A/B。

## 7. 第一轮实验矩阵

固定同一批留出作文、同一 prompt version、rubric version、output schema version，每个配置重复运行 3 次：

| 配置 | RAG | 四维独立 | Judge | Rewrite verifier | 目的 |
|---|---:|---:|---:|---:|---|
| E0 | 否 | 否 | 否 | 否 | 单次模型下限 |
| E1 | 是 | 否 | 否 | 否 | 测 RAG 增益 |
| E2 | 是 | 是 | 否 | 否 | 测独立维度评分 |
| E3 | 是 | 是 | 是 | 否 | 测一致性复核 |
| E4 | 是 | 是 | 是 | 是 | 完整质量上限 |

核心指标：

- 四维 band MAE、±0.5 命中率、weighted kappa
- 问题识别 precision / recall / F1
- 精确锚点成功率
- 无证据结论率、错误引用率
- 跨层矛盾率
- rewrite meaning preservation、grammar correction、naturalness、task usefulness
- 同一作文 3 次运行的稳定性
- 人工盲评：问题真实性、定位准确、解释质量、建议质量、教师感、学生易懂性

目前 22 篇 holdout 的标签权威性仍不足，适合做回归集，不适合直接宣称是最终 gold。正式判断“AI 是否批得好”至少需要两位合格教师对一批作文盲评并处理分歧。

## 8. 前端数据合同

建议前端只消费 presenter 输出，不直接拼接底层模型结果。核心对象：

```json
{
  "essay": {
    "paragraphs": [
      {
        "paragraphId": "p1",
        "startOffset": 0,
        "endOffset": 120,
        "sentences": [
          {"sentenceId": "p1-s1", "startOffset": 0, "endOffset": 45, "text": "..."}
        ]
      }
    ]
  },
  "tabs": {
    "overall": [],
    "paragraphs": [],
    "sentences": [],
    "rewrites": []
  },
  "links": [
    {
      "feedbackId": "fb-123",
      "sentenceId": "p1-s1",
      "startOffset": 8,
      "endOffset": 20
    }
  ]
}
```

点击右侧 feedback 时，根据 feedbackId 查 link，左侧滚动并高亮对应 DOM range；连线层使用同一组 DOM rect 计算 SVG path。窗口缩放、Tab 切换和左侧滚动后重新计算，不从评价文字反向猜原句。

## 9. 当前阻塞与下一步

当前 981 条 Task 2 总题库已正式入库。实验 V1 也已在数据库中；本轮修正后的 Excel/Word manifest 暂作为 V2 staging，先补 canonical question/family 和版本关系，再激活，避免 V1/V2 重复召回。

下一步顺序：

1. 经确认后，将官方 IELTS Task 2 descriptors 作为版本化 `IELTS_RUBRIC` 来源入库。
2. 配置 OpenAI API key；密钥只放本地环境变量/secret manager，不提交 Git。
3. 新增 Responses + Structured Outputs provider，并为每个 stage 定义 Zod/JSON Schema。
4. 对允许 RAG 的 chunks 生成 embeddings，验证 holdout 和 quarantine 仍为零召回。
5. 先跑 1 篇留出作文 E0–E4，再跑完整 22 篇；保存配置、证据、token、延迟和结果。
6. 由教师盲评 5–10 篇初始结果，先修 rubric、RAG 和 prompt，再扩大样本。

## 10. 官方依据

- IELTS Writing Band Descriptors: https://ielts.org/cdn/ielts-guides/ielts-writing-band-descriptors.pdf
- IELTS Writing Key Assessment Criteria: https://ielts.org/cdn/ielts-guides/ielts-writing-key-assessment-criteria.pdf
- OpenAI GPT-5.6 model guidance: https://developers.openai.com/api/docs/guides/latest-model
- OpenAI GPT-5.6 Sol: https://developers.openai.com/api/docs/models/gpt-5.6-sol
- OpenAI Structured Outputs: https://developers.openai.com/api/docs/guides/structured-outputs
- OpenAI Reasoning best practices: https://developers.openai.com/api/docs/guides/reasoning-best-practices
- OpenAI Retrieval: https://developers.openai.com/api/docs/guides/retrieval
- OpenAI Evals: https://developers.openai.com/api/docs/guides/evals
