# AI 批改后端更新报告

日期：2026-07-06

## 背景

本次依据三份产品/技术文档更新后端：

- `产品蓝图_AI批改与呈现 (1).md`
- `报告2_如何服务系统_完整详细版.md`
- `报告3_后端搭建_完整详细版.md`

文档目标是让 AI 批改结果可以支撑 PC 端四个 tab：逐句批注、总评与打分、段落评价、逐句/段级改写。

技术栈口径已确认：本项目后端使用 **MySQL + Prisma**。报告三中提到的 PostgreSQL/pgvector 只作为“关系库 + 向量检索 + 分层数据架构”的抽象参考，不作为本项目当前或默认技术栈。本次更新完全沿用当前 MySQL + Prisma 架构。

## 已完成

### 1. 总评阶段开始产出四维分数

更新了 `src/services/ai/stagePromptComposer.ts`、`src/services/ai/stageTypes.ts`、`src/services/ai/multiStageReviewPipeline.ts`。

Global stage 现在要求模型输出：

- `overallBand`
- `scores[]`
- 四个维度：`TASK_RESPONSE`、`COHERENCE_COHESION`、`LEXICAL_RESOURCE`、`GRAMMAR_RANGE_ACCURACY`

这样 Tab 2 “总评与打分” 不再只能展示空分数。分数仍通过已有 `AiReviewScore` 表保存，没有新增评分表。

### 2. 段落阶段开始产出段落四维

更新了 paragraph stage prompt 和 validator。每段现在要求输出：

- `tr`
- `cc`
- `lr`
- `gra`
- 以及原有的 `function`、`topicSentence`、`development`、`cohesion`、`relationToQuestion`、`findings`

这些数据保存在 `AiReview.rawOutput.paragraphs` 中，供 presentation 层组织 Tab 3 “段落评价”。

### 3. 改写新增分层字段

新增 Prisma enum：

- `AiRewriteLayer`
  - `LANGUAGE`
  - `COHERENCE`
  - `TASK`
  - `PARAGRAPH`

并给 `AiRewrite` 新增可空字段：

- `rewriteLayer`

对应迁移：

- `prisma/migrations/20260706161000_add_ai_rewrite_layer/migration.sql`

sentence stage prompt 现在要求句级改写标注 `LANGUAGE / COHERENCE / TASK`。段级改写自动标为 `PARAGRAPH`。旧数据没有该字段时，validator 会兜底：句级默认 `LANGUAGE`，段级默认 `PARAGRAPH`。

### 4. 新增四 tab presentation 组装层

新增文件：

- `src/services/ai/aiReviewPresenter.ts`

该服务不重新判断批改，只把已有 review、input snapshot、stage rawOutput、annotations、rewrites 组织成前端可直接消费的结构：

- `presentation.question`
- `presentation.essay`
- `presentation.tabs.sentenceAnnotations`
- `presentation.tabs.overallScores`
- `presentation.tabs.paragraphReview`
- `presentation.tabs.rewrites`

这样前端不需要自己从数据库对象里拼 tab。

### 5. 接口返回新增 presentation

更新：

- `src/services/ai/aiReviewService.ts`
- `src/controllers/aiReviewController.ts`
- `src/routes/aiReviews.ts`

现在：

- `POST /api/ai-reviews/requests` 返回的 `review` 带 `presentation`
- `GET /api/ai-reviews/:id` 返回完整 review，并带 `presentation`
- 新增 `GET /api/ai-reviews/:id/presentation`，只返回四 tab 呈现数据

## 为什么这样做

1. 坚持 MySQL + Prisma：当前项目已经围绕 MySQL + Prisma 建了用户、作文、AI review、Knowledge/RAG、迁移和本地环境。后续扩展都应优先在这套栈上做，避免数据库栈来回切换。
2. 不重写 AI pipeline：现有代码已有 Global / Paragraph / Sentence / Merge / Verification / Repair 多阶段流程，本次是在这个流程上补产品字段，风险低。
3. 新增 presentation 层：产品蓝图的四 tab 是前端视图结构，不应该让前端散落拼接逻辑。后端统一组装可以保证字段稳定，也方便之后移动端复用。
4. `rewriteLayer` 用可空字段：兼容历史数据，避免老 review 因缺字段无法展示。

## 当前后端多层架构对应关系

虽然没有照搬报告三里的 PostgreSQL 表名，但当前后端已经按“多层服务系统”在搭，并且都落在 MySQL + Prisma 里：

| 报告里的层 | 当前后端对应 | 作用 |
|---|---|---|
| 请求/任务层 | `AiReviewRequest`、`AiReviewJob`、`AiReviewInputSnapshot` | 接收作文、记录任务状态、保存预处理快照 |
| 知识库层 | `KnowledgeSource`、`KnowledgeDocument`、`KnowledgeChunk`、`KnowledgeAnnotation` | 存老师语料、文档、chunk、结构化批注 |
| 向量/检索层 | `KnowledgeEmbedding`、`RetrievalEvent`、`RetrievalEventChunk` | 存 embedding 元数据和每次 RAG 检索轨迹 |
| 检索评估层 | `RetrievalGoldStandard`、`ExperimentRun`、`RetrievalEvaluation`、`RetrievalHardNegative` | 支撑后续 RAG 调参、召回评估、负样本实验 |
| 生成流水线层 | `AiReviewStageResult`、`AiModelCall` | 记录 Global / Paragraph / Sentence / Merge / Verification / Repair 各阶段输出和模型调用 |
| 批改结果层 | `AiReview`、`AiReviewScore`、`AiGlobalFinding`、`AiSentenceAnnotation`、`AiRewrite` | 存学生最终能看到的总评、四维分数、逐句批注、改写 |
| 呈现层 | `aiReviewPresenter.ts` 生成 `presentation` | 把数据库结果组装成四 tab 前端结构 |
| 人工评估层 | `HumanReviewAudit`、`RubricVersion`、`OutputSchemaVersion` | 支撑老师盲评、rubric 版本化和输出 schema 版本化 |

所以答案是：**有按照之前报告的“多层架构思想”写，但没有照搬报告里 PostgreSQL/pgvector 的技术栈。当前实现是 MySQL + Prisma 版本的分层架构。**

## 已验证

已执行：

```bash
npm run build
```

结果：Prisma Client 生成成功，TypeScript 编译通过。

已执行：

```bash
npx prisma migrate deploy
npx prisma migrate status
```

结果：新增迁移已应用，本地 MySQL 显示 `Database schema is up to date!`。

已执行 presenter smoke test，确认四个 tab 的核心结构可由 review-like 对象生成。

## 2026-07-07 复查补充

再次复查时补了两处稳健性/一致性小修：

- `src/services/ai/multiStageReviewPipeline.ts` 的 sentence stage 内部现在也接受 `LOGIC / COHESION / TASK_RESPONSE / TR / PARAGRAPH_LEVEL` 这类 rewriteLayer 同义写法，并规范化到 `COHERENCE / TASK / PARAGRAPH`。这样和最终 `reviewValidator` 的兜底逻辑一致，减少模型输出轻微偏差导致整批失败的概率。
- `src/services/ai/promptComposer.ts` 里的旧单阶段 prompt 文案已同步为“需要打分 + 分层改写”，避免它继续写着“不打分”。`AiPromptVersion` registry 的说明也改为指向当前真正使用的 `stagePromptComposer.ts`。

复查后重新执行：

```bash
npm run build
npx prisma validate
```

并补跑了 reviewer/presenter smoke test，确认分数别名、rewriteLayer 同义值和四 tab 组装都正常。

## 暂未做，需要确认

### 1. Multiagent 方案 A/B 未真正接入

当前已有 Verification + Repair 阶段，但还没有实现“串行 reviewer agent”或“多 specialist 并行 agent”。文档也明确说这部分要实验择优。

建议：先把单 pipeline 的四 tab 输出和教师盲评跑通，再加实验配置表/开关做 A/B。

### 2. 导入 8 sheet 的正式 API 未接

报告二/三强调 8 sheet 导入三层库。目前仓库已有不少 dry-run / migrate scripts，但还不是稳定的 `/import` API。本次没有动导入链路。

建议：等样例 xlsx 和字段最终确认后，再做导入 API；不要现在凭文档猜列名。

### 3. 逐句批注连线是前端渲染问题

后端现在提供 `startOffset/endOffset/sentenceIndex/paragraphIndex`，足够支撑定位和高亮；真正的 Word/WPS 批注连线属于前端布局实现，本次未做。
