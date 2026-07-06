-- Allow one knowledge chunk to keep independently versioned embeddings.
CREATE INDEX `KnowledgeEmbedding_chunkId_idx` ON `KnowledgeEmbedding`(`chunkId`);
DROP INDEX `KnowledgeEmbedding_chunkId_key` ON `KnowledgeEmbedding`;

ALTER TABLE `AiRewrite`
    ADD COLUMN `anchorText` TEXT NULL,
    ADD COLUMN `endOffset` INTEGER NULL,
    ADD COLUMN `level` ENUM('WORD', 'PHRASE', 'SENTENCE', 'PARAGRAPH') NOT NULL DEFAULT 'SENTENCE',
    ADD COLUMN `operation` ENUM('REPLACE', 'INSERT', 'DELETE', 'REORDER') NOT NULL DEFAULT 'REPLACE',
    ADD COLUMN `startOffset` INTEGER NULL;

ALTER TABLE `AiSentenceAnnotation`
    ADD COLUMN `anchorText` TEXT NULL,
    ADD COLUMN `endOffset` INTEGER NULL,
    ADD COLUMN `level` ENUM('WORD', 'PHRASE', 'SENTENCE', 'PARAGRAPH') NOT NULL DEFAULT 'SENTENCE',
    ADD COLUMN `locationStatus` ENUM('PENDING', 'RESOLVED', 'UNRESOLVED') NOT NULL DEFAULT 'PENDING',
    ADD COLUMN `occurrence` INTEGER NULL,
    ADD COLUMN `paragraphIndex` INTEGER NULL,
    ADD COLUMN `replacementText` LONGTEXT NULL,
    ADD COLUMN `startOffset` INTEGER NULL,
    MODIFY `sentenceIndex` INTEGER NULL;

ALTER TABLE `KnowledgeEmbedding`
    ADD COLUMN `contentHash` VARCHAR(191) NULL,
    ADD COLUMN `errorMessage` TEXT NULL,
    ADD COLUMN `status` ENUM('PENDING', 'COMPLETED', 'FAILED', 'STALE') NOT NULL DEFAULT 'PENDING',
    ADD COLUMN `updatedAt` DATETIME(3) NULL;

UPDATE `KnowledgeEmbedding`
SET `updatedAt` = CURRENT_TIMESTAMP(3)
WHERE `updatedAt` IS NULL;

ALTER TABLE `KnowledgeEmbedding`
    MODIFY `updatedAt` DATETIME(3) NOT NULL;

CREATE TABLE `AiReviewStageResult` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `jobId` INTEGER NOT NULL,
    `stage` ENUM('GLOBAL_ANALYSIS', 'PARAGRAPH_ANALYSIS', 'SENTENCE_ANALYSIS', 'MERGE', 'VERIFICATION', 'REPAIR') NOT NULL,
    `targetIndex` INTEGER NULL,
    `attempt` INTEGER NOT NULL DEFAULT 1,
    `provider` VARCHAR(191) NOT NULL,
    `model` VARCHAR(191) NOT NULL,
    `promptVersion` VARCHAR(191) NULL,
    `inputJson` JSON NULL,
    `outputJson` JSON NULL,
    `validationStatus` ENUM('PENDING', 'VALID', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `errorMessage` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `AiReviewStageResult_jobId_stage_targetIndex_idx`(`jobId`, `stage`, `targetIndex`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `KnowledgeEmbedding_provider_model_status_idx`
    ON `KnowledgeEmbedding`(`provider`, `model`, `status`);

CREATE UNIQUE INDEX `KnowledgeEmbedding_chunkId_provider_model_key`
    ON `KnowledgeEmbedding`(`chunkId`, `provider`, `model`);

ALTER TABLE `AiReviewStageResult`
    ADD CONSTRAINT `AiReviewStageResult_jobId_fkey`
    FOREIGN KEY (`jobId`) REFERENCES `AiReviewJob`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
