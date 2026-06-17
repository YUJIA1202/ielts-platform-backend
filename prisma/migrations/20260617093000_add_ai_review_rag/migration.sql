-- AI review request and job tables
CREATE TABLE `AiReviewRequest` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `questionId` INTEGER NULL,
  `submissionId` INTEGER NULL,
  `sourceType` ENUM('DIRECT_AI', 'FROM_SUBMISSION', 'FROM_EXAM') NOT NULL DEFAULT 'DIRECT_AI',
  `task` ENUM('TASK1', 'TASK2') NULL,
  `subtype` VARCHAR(191) NULL,
  `topic` VARCHAR(191) NULL,
  `questionText` LONGTEXT NULL,
  `questionImageUrl` VARCHAR(191) NULL,
  `essayText` LONGTEXT NOT NULL,
  `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `AiReviewRequest_userId_createdAt_idx` ON `AiReviewRequest`(`userId`, `createdAt`);
CREATE INDEX `AiReviewRequest_status_idx` ON `AiReviewRequest`(`status`);

CREATE TABLE `AiReviewJob` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `requestId` INTEGER NOT NULL,
  `status` ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
  `stage` VARCHAR(191) NOT NULL DEFAULT 'created',
  `errorCode` VARCHAR(191) NULL,
  `errorMessage` TEXT NULL,
  `startedAt` DATETIME(3) NULL,
  `completedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `AiReviewJob_userId_createdAt_idx` ON `AiReviewJob`(`userId`, `createdAt`);
CREATE INDEX `AiReviewJob_status_idx` ON `AiReviewJob`(`status`);

CREATE TABLE `AiReviewInputSnapshot` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `jobId` INTEGER NOT NULL,
  `normalizedQuestion` LONGTEXT NULL,
  `normalizedEssay` LONGTEXT NOT NULL,
  `sentenceJson` JSON NOT NULL,
  `paragraphJson` JSON NOT NULL,
  `wordCount` INTEGER NOT NULL,
  `detectedTask` ENUM('TASK1', 'TASK2') NULL,
  `detectedSubtype` VARCHAR(191) NULL,
  `detectedTopic` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `AiReviewInputSnapshot_jobId_key`(`jobId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AI review result tables
CREATE TABLE `AiReview` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `jobId` INTEGER NOT NULL,
  `requestId` INTEGER NOT NULL,
  `userId` INTEGER NOT NULL,
  `submissionId` INTEGER NULL,
  `overallBand` DOUBLE NULL,
  `summary` LONGTEXT NOT NULL,
  `priorityAdvice` LONGTEXT NULL,
  `provider` VARCHAR(191) NOT NULL,
  `model` VARCHAR(191) NOT NULL,
  `promptVersion` VARCHAR(191) NULL,
  `rawOutput` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `AiReview_jobId_key`(`jobId`),
  INDEX `AiReview_userId_createdAt_idx`(`userId`, `createdAt`),
  INDEX `AiReview_requestId_idx`(`requestId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AiReviewScore` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `reviewId` INTEGER NOT NULL,
  `dimension` ENUM('OVERALL', 'TASK_RESPONSE', 'COHERENCE_COHESION', 'LEXICAL_RESOURCE', 'GRAMMAR_RANGE_ACCURACY') NOT NULL,
  `score` DOUBLE NULL,
  `rationale` TEXT NOT NULL,
  `evidence` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `AiReviewScore_reviewId_dimension_key`(`reviewId`, `dimension`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AiGlobalFinding` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `reviewId` INTEGER NOT NULL,
  `category` ENUM('TASK_RESPONSE', 'STRUCTURE', 'LOGIC', 'LANGUAGE', 'VOCABULARY', 'GRAMMAR') NOT NULL,
  `severity` ENUM('LOW', 'MEDIUM', 'HIGH') NOT NULL DEFAULT 'MEDIUM',
  `title` VARCHAR(191) NOT NULL,
  `explanation` LONGTEXT NOT NULL,
  `suggestion` LONGTEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `AiGlobalFinding_reviewId_category_idx`(`reviewId`, `category`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AiSentenceAnnotation` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `reviewId` INTEGER NOT NULL,
  `sentenceIndex` INTEGER NOT NULL,
  `originalText` LONGTEXT NOT NULL,
  `issueType` ENUM('GRAMMAR', 'VOCABULARY', 'LOGIC', 'COHESION', 'TASK_RESPONSE', 'STRUCTURE', 'STYLE') NOT NULL,
  `subtype` VARCHAR(191) NULL,
  `severity` ENUM('LOW', 'MEDIUM', 'HIGH') NOT NULL DEFAULT 'MEDIUM',
  `explanation` LONGTEXT NOT NULL,
  `suggestion` LONGTEXT NULL,
  `rubricDimension` ENUM('OVERALL', 'TASK_RESPONSE', 'COHERENCE_COHESION', 'LEXICAL_RESOURCE', 'GRAMMAR_RANGE_ACCURACY') NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `AiSentenceAnnotation_reviewId_sentenceIndex_idx`(`reviewId`, `sentenceIndex`),
  INDEX `AiSentenceAnnotation_issueType_idx`(`issueType`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AiRewrite` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `reviewId` INTEGER NOT NULL,
  `sentenceIndex` INTEGER NULL,
  `paragraphIndex` INTEGER NULL,
  `originalText` LONGTEXT NOT NULL,
  `rewrittenText` LONGTEXT NOT NULL,
  `reason` LONGTEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `AiRewrite_reviewId_sentenceIndex_idx`(`reviewId`, `sentenceIndex`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Model, prompt and provider metadata
CREATE TABLE `AiModelCall` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `jobId` INTEGER NULL,
  `callType` ENUM('CLASSIFY', 'REVIEW', 'REWRITE', 'EMBEDDING') NOT NULL,
  `provider` VARCHAR(191) NOT NULL,
  `model` VARCHAR(191) NOT NULL,
  `promptVersion` VARCHAR(191) NULL,
  `inputTokens` INTEGER NULL,
  `outputTokens` INTEGER NULL,
  `estimatedCost` DOUBLE NULL,
  `latencyMs` INTEGER NULL,
  `status` ENUM('SUCCESS', 'FAILED') NOT NULL DEFAULT 'SUCCESS',
  `errorMessage` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `AiModelCall_userId_createdAt_idx`(`userId`, `createdAt`),
  INDEX `AiModelCall_jobId_idx`(`jobId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AiPromptTemplate` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `purpose` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `AiPromptTemplate_name_purpose_key`(`name`, `purpose`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AiPromptVersion` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `templateId` INTEGER NOT NULL,
  `version` VARCHAR(191) NOT NULL,
  `content` LONGTEXT NOT NULL,
  `outputSchemaJson` JSON NULL,
  `changelog` TEXT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `AiPromptVersion_templateId_version_key`(`templateId`, `version`),
  INDEX `AiPromptVersion_isActive_idx`(`isActive`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AiProviderConfig` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `provider` VARCHAR(191) NOT NULL,
  `displayName` VARCHAR(191) NOT NULL,
  `baseUrl` VARCHAR(191) NULL,
  `defaultModel` VARCHAR(191) NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `complianceNote` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `AiProviderConfig_provider_key`(`provider`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- RAG knowledge base
CREATE TABLE `KnowledgeSource` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `sourceType` ENUM('IELTS_RUBRIC', 'MODEL_ESSAY', 'TEACHER_REVIEW', 'ERROR_LIBRARY', 'TEMPLATE', 'OTHER') NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `owner` VARCHAR(191) NULL,
  `visibility` ENUM('PRIVATE', 'PUBLIC') NOT NULL DEFAULT 'PRIVATE',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `KnowledgeDocument` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `sourceId` INTEGER NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `rawText` LONGTEXT NOT NULL,
  `fileUrl` VARCHAR(191) NULL,
  `task` ENUM('TASK1', 'TASK2') NULL,
  `subtype` VARCHAR(191) NULL,
  `topic` VARCHAR(191) NULL,
  `band` DOUBLE NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `KnowledgeDocument_sourceId_idx`(`sourceId`),
  INDEX `KnowledgeDocument_task_subtype_idx`(`task`, `subtype`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `KnowledgeChunk` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `documentId` INTEGER NOT NULL,
  `chunkText` LONGTEXT NOT NULL,
  `chunkType` ENUM('RUBRIC', 'ESSAY_PARAGRAPH', 'REVIEW_EXAMPLE', 'ERROR_EXPLANATION', 'TEMPLATE', 'OTHER') NOT NULL,
  `task` ENUM('TASK1', 'TASK2') NULL,
  `subtype` VARCHAR(191) NULL,
  `topic` VARCHAR(191) NULL,
  `band` DOUBLE NULL,
  `tokenCount` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `KnowledgeChunk_documentId_idx`(`documentId`),
  INDEX `KnowledgeChunk_task_subtype_idx`(`task`, `subtype`),
  INDEX `KnowledgeChunk_chunkType_idx`(`chunkType`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `KnowledgeEmbedding` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `chunkId` INTEGER NOT NULL,
  `provider` VARCHAR(191) NOT NULL,
  `model` VARCHAR(191) NOT NULL,
  `vectorJson` JSON NULL,
  `vectorRef` VARCHAR(191) NULL,
  `dimensions` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `KnowledgeEmbedding_chunkId_key`(`chunkId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `RetrievalEvent` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `jobId` INTEGER NOT NULL,
  `query` TEXT NOT NULL,
  `topK` INTEGER NOT NULL,
  `strategy` VARCHAR(191) NOT NULL DEFAULT 'keyword',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `RetrievalEvent_jobId_idx`(`jobId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `RetrievalEventChunk` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `retrievalEventId` INTEGER NOT NULL,
  `chunkId` INTEGER NOT NULL,
  `rank` INTEGER NOT NULL,
  `similarityScore` DOUBLE NULL,
  `usedInPrompt` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `RetrievalEventChunk_retrievalEventId_chunkId_key`(`retrievalEventId`, `chunkId`),
  INDEX `RetrievalEventChunk_chunkId_idx`(`chunkId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Foreign keys
ALTER TABLE `AiReviewRequest` ADD CONSTRAINT `AiReviewRequest_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiReviewRequest` ADD CONSTRAINT `AiReviewRequest_questionId_fkey` FOREIGN KEY (`questionId`) REFERENCES `Question`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `AiReviewRequest` ADD CONSTRAINT `AiReviewRequest_submissionId_fkey` FOREIGN KEY (`submissionId`) REFERENCES `Submission`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `AiReviewJob` ADD CONSTRAINT `AiReviewJob_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiReviewJob` ADD CONSTRAINT `AiReviewJob_requestId_fkey` FOREIGN KEY (`requestId`) REFERENCES `AiReviewRequest`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiReviewInputSnapshot` ADD CONSTRAINT `AiReviewInputSnapshot_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `AiReviewJob`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `AiReview` ADD CONSTRAINT `AiReview_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `AiReviewJob`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiReview` ADD CONSTRAINT `AiReview_requestId_fkey` FOREIGN KEY (`requestId`) REFERENCES `AiReviewRequest`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiReview` ADD CONSTRAINT `AiReview_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiReview` ADD CONSTRAINT `AiReview_submissionId_fkey` FOREIGN KEY (`submissionId`) REFERENCES `Submission`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `AiReviewScore` ADD CONSTRAINT `AiReviewScore_reviewId_fkey` FOREIGN KEY (`reviewId`) REFERENCES `AiReview`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiGlobalFinding` ADD CONSTRAINT `AiGlobalFinding_reviewId_fkey` FOREIGN KEY (`reviewId`) REFERENCES `AiReview`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiSentenceAnnotation` ADD CONSTRAINT `AiSentenceAnnotation_reviewId_fkey` FOREIGN KEY (`reviewId`) REFERENCES `AiReview`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiRewrite` ADD CONSTRAINT `AiRewrite_reviewId_fkey` FOREIGN KEY (`reviewId`) REFERENCES `AiReview`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `AiModelCall` ADD CONSTRAINT `AiModelCall_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AiModelCall` ADD CONSTRAINT `AiModelCall_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `AiReviewJob`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `AiPromptVersion` ADD CONSTRAINT `AiPromptVersion_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `AiPromptTemplate`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `KnowledgeDocument` ADD CONSTRAINT `KnowledgeDocument_sourceId_fkey` FOREIGN KEY (`sourceId`) REFERENCES `KnowledgeSource`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `KnowledgeChunk` ADD CONSTRAINT `KnowledgeChunk_documentId_fkey` FOREIGN KEY (`documentId`) REFERENCES `KnowledgeDocument`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `KnowledgeEmbedding` ADD CONSTRAINT `KnowledgeEmbedding_chunkId_fkey` FOREIGN KEY (`chunkId`) REFERENCES `KnowledgeChunk`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `RetrievalEvent` ADD CONSTRAINT `RetrievalEvent_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `AiReviewJob`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `RetrievalEventChunk` ADD CONSTRAINT `RetrievalEventChunk_retrievalEventId_fkey` FOREIGN KEY (`retrievalEventId`) REFERENCES `RetrievalEvent`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `RetrievalEventChunk` ADD CONSTRAINT `RetrievalEventChunk_chunkId_fkey` FOREIGN KEY (`chunkId`) REFERENCES `KnowledgeChunk`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
