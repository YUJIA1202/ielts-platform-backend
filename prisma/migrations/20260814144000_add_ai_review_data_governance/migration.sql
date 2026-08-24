-- Complete the AI review data-governance schema that was already declared in
-- schema.prisma but was not represented by the earlier migrations.

DROP INDEX `KnowledgeEmbedding_chunkId_provider_model_key` ON `KnowledgeEmbedding`;

ALTER TABLE `AiSentenceAnnotation`
    ADD COLUMN `anchorType` ENUM('SPAN', 'POINT_BEFORE', 'POINT_AFTER', 'RELATION', 'TEACHER_NOTE') NULL,
    ADD COLUMN `attachedTokenIndex` INTEGER NULL,
    ADD COLUMN `relationType` ENUM('CAUSAL', 'COHESION', 'CONTRAST', 'PROGRESSION') NULL,
    ADD COLUMN `sourceRef` VARCHAR(191) NULL,
    ADD COLUMN `targetRef` VARCHAR(191) NULL;

ALTER TABLE `KnowledgeDocument`
    ADD COLUMN `allowedForRag` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `completenessStatus` VARCHAR(191) NULL,
    ADD COLUMN `contentRole` VARCHAR(191) NULL,
    ADD COLUMN `excludeFromEval` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `probableTask` ENUM('TASK1', 'TASK2') NULL,
    ADD COLUMN `qualityNotes` TEXT NULL;

ALTER TABLE `KnowledgeEmbedding`
    ADD COLUMN `embeddingRole` ENUM('PRIMARY', 'STRUCTURE', 'TOPIC', 'LANGUAGE_ERROR') NOT NULL DEFAULT 'PRIMARY';

CREATE TABLE `KnowledgeAnnotation` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `documentId` INTEGER NOT NULL,
    `chunkId` INTEGER NULL,
    `commentId` VARCHAR(191) NULL,
    `paragraphIndex` INTEGER NULL,
    `sentenceIndex` INTEGER NULL,
    `anchorType` ENUM('SPAN', 'POINT_BEFORE', 'POINT_AFTER', 'RELATION', 'TEACHER_NOTE') NOT NULL DEFAULT 'SPAN',
    `anchorText` TEXT NULL,
    `startOffset` INTEGER NULL,
    `endOffset` INTEGER NULL,
    `occurrence` INTEGER NULL,
    `attachedTokenIndex` INTEGER NULL,
    `sourceRef` VARCHAR(191) NULL,
    `targetRef` VARCHAR(191) NULL,
    `relationType` ENUM('CAUSAL', 'COHESION', 'CONTRAST', 'PROGRESSION') NULL,
    `issueType` VARCHAR(191) NULL,
    `issueSubtype` VARCHAR(191) NULL,
    `severity` ENUM('LOW', 'MEDIUM', 'HIGH') NOT NULL DEFAULT 'MEDIUM',
    `teacherFeedback` TEXT NULL,
    `replacementText` TEXT NULL,
    `locationStatus` ENUM('PENDING', 'RESOLVED', 'UNRESOLVED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `KnowledgeAnnotation_documentId_idx`(`documentId`),
    INDEX `KnowledgeAnnotation_chunkId_idx`(`chunkId`),
    INDEX `KnowledgeAnnotation_issueType_idx`(`issueType`),
    INDEX `KnowledgeAnnotation_anchorType_idx`(`anchorType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `RetrievalGoldStandard` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `essayId` INTEGER NOT NULL,
    `relevantChunkId` INTEGER NOT NULL,
    `issueType` VARCHAR(191) NULL,
    `channel` VARCHAR(191) NULL,
    `relevanceGrade` INTEGER NOT NULL DEFAULT 2,
    `source` ENUM('AUTO', 'MANUAL') NOT NULL DEFAULT 'AUTO',
    `confirmedBy` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `RetrievalGoldStandard_essayId_idx`(`essayId`),
    INDEX `RetrievalGoldStandard_relevantChunkId_idx`(`relevantChunkId`),
    INDEX `RetrievalGoldStandard_issueType_idx`(`issueType`),
    UNIQUE INDEX `RetrievalGoldStandard_essayId_relevantChunkId_key`(`essayId`, `relevantChunkId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ExperimentRun` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NULL,
    `gitCommit` VARCHAR(191) NULL,
    `fusionMethod` ENUM('LINEAR', 'RRF', 'WEIGHTED_RRF') NOT NULL DEFAULT 'RRF',
    `configJson` JSON NULL,
    `topKGlobal` INTEGER NULL,
    `topKParagraph` INTEGER NULL,
    `topKSentence` INTEGER NULL,
    `rrfK` INTEGER NULL,
    `mmrLambda` DOUBLE NULL,
    `seed` INTEGER NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `ExperimentRun_gitCommit_idx`(`gitCommit`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `RetrievalEvaluation` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `runId` INTEGER NOT NULL,
    `essayId` INTEGER NULL,
    `channel` VARCHAR(191) NULL,
    `issueType` VARCHAR(191) NULL,
    `recallAtK` DOUBLE NULL,
    `ndcgAtK` DOUBLE NULL,
    `precisionAtK` DOUBLE NULL,
    `noiseRate` DOUBLE NULL,
    `diversityScore` DOUBLE NULL,
    `topK` INTEGER NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `RetrievalEvaluation_runId_idx`(`runId`),
    INDEX `RetrievalEvaluation_essayId_idx`(`essayId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `RetrievalHardNegative` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `queryEssayId` INTEGER NULL,
    `queryUnitId` VARCHAR(191) NULL,
    `chunkId` INTEGER NOT NULL,
    `negativeType` ENUM('WRONG_TASK', 'WRONG_ISSUE', 'TOO_GENERIC', 'MISLEADING', 'DUPLICATE') NOT NULL,
    `severity` ENUM('LOW', 'MEDIUM', 'HIGH') NOT NULL DEFAULT 'MEDIUM',
    `createdBy` INTEGER NULL,
    `source` ENUM('AUTO', 'MANUAL') NOT NULL DEFAULT 'MANUAL',
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `RetrievalHardNegative_queryEssayId_idx`(`queryEssayId`),
    INDEX `RetrievalHardNegative_chunkId_idx`(`chunkId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ImportBatch` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `label` VARCHAR(191) NULL,
    `sourceFileHash` VARCHAR(191) NULL,
    `parserVersion` VARCHAR(191) NULL,
    `cleaningVersion` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `importedCount` INTEGER NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `ImportBatch_sourceFileHash_idx`(`sourceFileHash`),
    INDEX `ImportBatch_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `RubricVersion` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `version` VARCHAR(191) NOT NULL,
    `content` LONGTEXT NOT NULL,
    `taskType` ENUM('TASK1', 'TASK2') NULL,
    `changelog` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `RubricVersion_version_key`(`version`),
    INDEX `RubricVersion_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `OutputSchemaVersion` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `version` VARCHAR(191) NOT NULL,
    `schemaJson` JSON NOT NULL,
    `changelog` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `OutputSchemaVersion_version_key`(`version`),
    INDEX `OutputSchemaVersion_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `HumanReviewAudit` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `reviewId` INTEGER NOT NULL,
    `auditorId` INTEGER NOT NULL,
    `configLabel` VARCHAR(191) NULL,
    `problemReality` INTEGER NULL,
    `locationAccuracy` INTEGER NULL,
    `explanationQuality` INTEGER NULL,
    `suggestionQuality` INTEGER NULL,
    `teacherLikeness` INTEGER NULL,
    `studentClarity` INTEGER NULL,
    `overallScore` DOUBLE NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `HumanReviewAudit_reviewId_idx`(`reviewId`),
    INDEX `HumanReviewAudit_auditorId_idx`(`auditorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `AiSentenceAnnotation_anchorType_idx` ON `AiSentenceAnnotation`(`anchorType`);
CREATE INDEX `KnowledgeDocument_contentRole_idx` ON `KnowledgeDocument`(`contentRole`);
CREATE INDEX `KnowledgeDocument_allowedForRag_idx` ON `KnowledgeDocument`(`allowedForRag`);
CREATE INDEX `KnowledgeDocument_excludeFromEval_idx` ON `KnowledgeDocument`(`excludeFromEval`);
CREATE INDEX `KnowledgeEmbedding_embeddingRole_idx` ON `KnowledgeEmbedding`(`embeddingRole`);
CREATE UNIQUE INDEX `KnowledgeEmbedding_chunkId_provider_model_embeddingRole_key`
    ON `KnowledgeEmbedding`(`chunkId`, `provider`, `model`, `embeddingRole`);

ALTER TABLE `KnowledgeAnnotation`
    ADD CONSTRAINT `KnowledgeAnnotation_documentId_fkey`
    FOREIGN KEY (`documentId`) REFERENCES `KnowledgeDocument`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `KnowledgeAnnotation`
    ADD CONSTRAINT `KnowledgeAnnotation_chunkId_fkey`
    FOREIGN KEY (`chunkId`) REFERENCES `KnowledgeChunk`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `RetrievalGoldStandard`
    ADD CONSTRAINT `RetrievalGoldStandard_relevantChunkId_fkey`
    FOREIGN KEY (`relevantChunkId`) REFERENCES `KnowledgeChunk`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `RetrievalEvaluation`
    ADD CONSTRAINT `RetrievalEvaluation_runId_fkey`
    FOREIGN KEY (`runId`) REFERENCES `ExperimentRun`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `RetrievalHardNegative`
    ADD CONSTRAINT `RetrievalHardNegative_chunkId_fkey`
    FOREIGN KEY (`chunkId`) REFERENCES `KnowledgeChunk`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `HumanReviewAudit`
    ADD CONSTRAINT `HumanReviewAudit_reviewId_fkey`
    FOREIGN KEY (`reviewId`) REFERENCES `AiReview`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `HumanReviewAudit`
    ADD CONSTRAINT `HumanReviewAudit_auditorId_fkey`
    FOREIGN KEY (`auditorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
